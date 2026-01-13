
import 'dotenv/config';
import express from 'express';
import twilio from 'twilio';
import OpenAI from 'openai';

const app = express();
app.use(express.urlencoded({ extended: false })); // Twilio posts form-encoded
app.use(express.json());

const {
  PORT = 3000,
  BASE_URL,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER,
  OFFICE_TRANSFER_NUMBER,
  OPENAI_API_KEY,
  MAX_TURNS = 6,
} = process.env;

if (!BASE_URL) throw new Error("Missing BASE_URL (public https URL).");
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER) throw new Error("Missing Twilio env vars.");
if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY.");

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/** In-memory session store (replace with DB later) */
const sessions = new Map(); // CallSid -> { turns, name, preferred_time, booked }

function s(callSid) {
  if (!sessions.has(callSid)) sessions.set(callSid, { turns: 0 });
  return sessions.get(callSid);
}

async function agentReply(userText, session) {
  const system = `
You are a dental office phone assistant.
Your job is ONLY to collect:
1) Patient name
2) Preferred appointment day and time

Speak naturally and briefly.
Return ONLY valid JSON in this exact shape:
{"say":"...", "extracted":{"name":null,"preferred_time":null}}
`.trim();

  try {
    const resp = await openai.responses.create({
      model: "gpt-4o-mini",
      input: [
        { role: "system", content: system },
        { role: "user", content: userText }
      ],
      max_output_tokens: 120
    });

    const text = (resp.output_text || "").trim();
    if (!text) return null;

    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1) return null;

    const parsed = JSON.parse(text.slice(start, end + 1));

    if (!parsed.say) return null;

    return parsed;
  } catch (err) {
    console.error("agentReply failed:", err);
    return null;
  }
}


/** ------------- OUTBOUND CALL TRIGGER -------------
 * POST /call  { "to": "+15551234567" }
 */
app.post('/call', async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: "Missing 'to' (E.164 phone number)." });

  const call = await twilioClient.calls.create({
    to,
    from: TWILIO_FROM_NUMBER,
    url: `${BASE_URL}/voice/initial`,
    method: 'POST',
  });

  res.json({ ok: true, callSid: call.sid });
});

/** ------------- TWILIO ENTRYPOINT ------------- */
app.post('/voice/initial', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const callSid = req.body.CallSid;
  s(callSid); // init session

  if (OFFICE_TRANSFER_NUMBER) {
    // Try to transfer to a human first
    const dial = twiml.dial({
      timeout: 10,
      action: '/voice/after-transfer-attempt',
      method: 'POST',
    });
    dial.number(OFFICE_TRANSFER_NUMBER);
  } else {
    twiml.saytwiml.say({ voice: "Polly.Joanna-Neural" }, "Hi! Thank you for calling Cupo Dental, this is Ashley, how can I can help you?");
    twiml.redirect('/voice/gather');
  }

  res.type('text/xml').send(twiml.toString());
});

app.post('/voice/after-transfer-attempt', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const status = req.body.DialCallStatus; // completed, no-answer, busy, failed

  if (status === 'completed') {
    twiml.hangup();
  } else {
    twiml.say("The team is tied up. I can schedule you right now.");
    twiml.redirect('/voice/gather');
  }

  res.type('text/xml').send(twiml.toString());
});

/** ------------- GATHER SPEECH ------------- */
app.post('/voice/gather', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const callSid = req.body.CallSid;
  const session = s(callSid);

  if (session.turns >= Number(MAX_TURNS)) {
    twiml.say("Thanks. I’ll have the team call you back shortly. Goodbye.");
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  const gather = twiml.gather({
    input: 'speech',
    speechTimeout: 'auto',
    action: '/voice/handle',
    method: 'POST',
  });

  // Ask based on what we already have
  if (!session.name && !session.preferred_time) {
    gather.say("Tell me your name and the best day and time to come in.");
  } else if (!session.name) {
    gather.say("What is your name?");
  } else if (!session.preferred_time) {
    gather.say("What day and time works best?");
  } else {
    gather.say("One moment.");
  }

  twiml.redirect('/voice/gather');
  res.type('text/xml').send(twiml.toString());
});

/** ------------- HANDLE SPEECH ------------- */
app.post('/voice/handle', async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  try {
    const callSid = req.body.CallSid;
    const session = s(callSid);

    const speech = (req.body.SpeechResult || "").trim();
    session.turns += 1;

    if (!speech) {
      twiml.say("I didn’t catch that.");
      twiml.redirect('/voice/gather');
      return res.type('text/xml').send(twiml.toString());
    }

   let cmd;
try {
  cmd = await agentReply(speech, session);
} catch (e) {
  console.error("AI error:", e);
}

if (!cmd || typeof cmd.say !== "string") {
  twiml.say("Thanks. One moment while I get that scheduled.");
  twiml.redirect('/voice/gather');
  return res.type('text/xml').send(twiml.toString());
}
    const ex = cmd.extracted || {};
    if (ex.name) session.name = ex.name;
    if (ex.preferred_time) session.preferred_time = ex.preferred_time;

    if (session.name && session.preferred_time) session.booked = true;

    twiml.say(cmd.say || "Okay.");

    if (session.booked) {
      twiml.say("You’re all set. We’ll text you to confirm. Goodbye.");
      twiml.hangup();
    } else {
      twiml.redirect('/voice/gather');
    }

    res.type('text/xml').send(twiml.toString());

  } catch (err) {
    console.error("VOICE HANDLE ERROR:", err);
    twiml.say("I apologize, but something went wrong. A team member will call you back shortly.");
    twiml.hangup();
    res.type('text/xml').send(twiml.toString());
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Listening on ${PORT}`));

