import 'dotenv/config';
import express from 'express';
import twilio from 'twilio';
import OpenAI from 'openai';

const app = express();

// Twilio posts application/x-www-form-urlencoded
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const {
  PORT,
  BASE_URL,

  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER,

  // Optional: if set, tries to dial your office first for 10 seconds
  OFFICE_TRANSFER_NUMBER,

  // Optional SMS (see notes below)
  ENABLE_SMS = "false",

  OPENAI_API_KEY,
  MAX_TURNS = 6,
} = process.env;

if (!BASE_URL) throw new Error("Missing BASE_URL (public https URL).");
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER) throw new Error("Missing Twilio env vars.");
if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY.");

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// In-memory sessions: CallSid -> session state
const sessions = new Map();

function getSession(callSid) {
  if (!sessions.has(callSid)) sessions.set(callSid, { turns: 0, name: null, preferred_time: null });
  return sessions.get(callSid);
}

// Always returns an object: { say: string, extracted: {name, preferred_time} }
async function agentReply(userText, session) {
  const system = `
You are a dental office phone assistant.
Your ONLY job is to collect:
1) patient name
2) preferred appointment day and time

Be natural and brief.
Return ONLY valid JSON in this exact shape:
{"say":"...", "extracted":{"name":null,"preferred_time":null}}
`.trim();

  try {
    const resp = await openai.responses.create({
      model: "gpt-4o-mini",
      input: [
        { role: "system", content: system },
        {
          role: "user",
          content: `Patient said: ${userText}\nCurrent session: ${JSON.stringify(session)}`
        }
      ],
      max_output_tokens: 160
    });

    const text = (resp.output_text || "").trim();
    if (!text) {
      return { say: "Sorry — can you repeat that?", extracted: { name: null, preferred_time: null } };
    }

    const a = text.indexOf("{");
    const b = text.lastIndexOf("}");
    if (a === -1 || b === -1) {
      return { say: "Sorry — can you repeat that?", extracted: { name: null, preferred_time: null } };
    }

    const parsed = JSON.parse(text.slice(a, b + 1));

    const say = typeof parsed?.say === "string" && parsed.say.length > 0
      ? parsed.say
      : "Okay — can you tell me your name and the best day/time?";

    const extracted = {
      name: parsed?.extracted?.name ?? null,
      preferred_time: parsed?.extracted?.preferred_time ?? null,
    };

    return { say, extracted };
  } catch (err) {
    console.error("agentReply failed:", err);
    return { say: "Sorry — can you repeat that?", extracted: { name: null, preferred_time: null } };
  }
}

/** Health */
app.get('/health', (req, res) => res.json({ ok: true }));

/** Twilio entrypoint for inbound calls */
app.post('/voice/initial', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const callSid = req.body.CallSid;
  const session = getSession(callSid);

  // Try to transfer to a human first (optional)
  if (OFFICE_TRANSFER_NUMBER) {
    const dial = twiml.dial({
      timeout: 10,
      action: `${BASE_URL}/voice/after-transfer-attempt`,
      method: 'POST',
    });
    dial.number(OFFICE_TRANSFER_NUMBER);
  } else {
    twiml.say(
      { voice: "Polly.Joanna-Neural" },
      "Hi! Thanks for calling Cupo Dental. I can help schedule an appointment."
    );
    twiml.redirect(`${BASE_URL}/voice/gather`);
  }

  // Always send TwiML
  res.type('text/xml').send(twiml.toString());
});

/** If transfer fails, continue to AI */
app.post('/voice/after-transfer-attempt', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const status = req.body.DialCallStatus; // completed, no-answer, busy, failed

  if (status === 'completed') {
    twiml.hangup();
  } else {
    twiml.say(
      { voice: "Polly.Joanna-Neural" },
      "The team is tied up. I can schedule you right now."
    );
    twiml.redirect(`${BASE_URL}/voice/gather`);
  }

  res.type('text/xml').send(twiml.toString());
});

/** Ask a question and listen */
app.post('/voice/gather', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const callSid = req.body.CallSid;
  const session = getSession(callSid);

  if (session.turns >= Number(MAX_TURNS)) {
    twiml.say(
      { voice: "Polly.Joanna-Neural" },
      "Thanks. We'll call you back shortly. Goodbye."
    );
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  const gather = twiml.gather({
    input: 'speech',
    speechTimeout: 'auto',
    action: `${BASE_URL}/voice/handle`,
    method: 'POST',
  });

  if (!session.name && !session.preferred_time) {
    gather.say(
      { voice: "Polly.Joanna-Neural" },
      "Tell me your name and the best day and time to come in."
    );
  } else if (!session.name) {
    gather.say({ voice: "Polly.Joanna-Neural" }, "What is your name?");
  } else if (!session.preferred_time) {
    gather.say({ voice: "Polly.Joanna-Neural" }, "What day and time works best?");
  } else {
    gather.say({ voice: "Polly.Joanna-Neural" }, "One moment.");
  }

  // If no speech captured, Twilio hits this again
  twiml.redirect(`${BASE_URL}/voice/gather`);
  res.type('text/xml').send(twiml.toString());
});

/** Handle speech */
app.post('/voice/handle', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const callSid = req.body.CallSid;
  const session = s(callSid);

  const speech = (req.body.SpeechResult || "").trim();
  session.turns += 1;

  if (!speech) {
    twiml.say("Sorry, I didn’t catch that. Let’s try again.");
    twiml.redirect('/voice/gather');
    return res.type('text/xml').send(twiml.toString());
  }

  // STEP 1: Collect NAME first
  if (!session.name) {
    session.name = speech;
    twiml.say(`Thanks ${session.name}. What day and time works best for you?`);
    twiml.redirect('/voice/gather');
    return res.type('text/xml').send(twiml.toString());
  }

  // STEP 2: Collect TIME second
  if (!session.preferred_time) {
    session.preferred_time = speech;
    twiml.say(
      `Perfect. We have you down for ${session.preferred_time}. We’ll text you to confirm. Goodbye.`
    );
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  // SAFETY (should never hit)
  twiml.say("Thank you. Goodbye.");
  twiml.hangup();
  res.type('text/xml').send(twiml.toString());
});


// Railway uses PORT it provides. Do not force 3000.
const listenPort = Number(PORT || 3000);
app.listen(listenPort, () => console.log(`Listening on ${listenPort}`));


