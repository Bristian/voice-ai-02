require('dotenv').config();

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const OpenAI = require('openai');
const { ElevenLabsClient } = require('@elevenlabs/elevenlabs-js');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const ELEVEN_LABS_API_KEY = process.env.ELEVEN_LABS_API_KEY || '';

const DATA_DIR = __dirname;
const CARS_FILE  = path.join(DATA_DIR, 'cars.json');
const CALLS_FILE = path.join(DATA_DIR, 'calls.json');
const LEADS_FILE = path.join(DATA_DIR, 'leads.json');

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
const eleven = ELEVEN_LABS_API_KEY ? new ElevenLabsClient({ apiKey: ELEVEN_LABS_API_KEY }) : null;

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------
let cars  = loadJSONSafe(CARS_FILE,  []);
let calls = loadJSONSafe(CALLS_FILE, []);
let leads = loadJSONSafe(LEADS_FILE, []);
const sessions = new Map();        // call_id -> session
const sseClients = new Set();      // dashboard SSE clients
const logs = [];                   // ring buffer
const MAX_LOGS = 2000;

function loadJSONSafe(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
function log(level, source, message, extra = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    source,
    message,
    session_id: extra.session_id || null,
    ...extra,
  };
  logs.push(entry);
  if (logs.length > MAX_LOGS) logs.shift();
  const line = `[${entry.timestamp}] [${level.toUpperCase()}] [${source}] ${message}` +
    (entry.session_id ? ` (session=${entry.session_id})` : '');
  if (level === 'error') console.error(line); else console.log(line);
  broadcast({ type: 'log', entry });
}

// ---------------------------------------------------------------------------
// Async write queue (FIFO via setImmediate)
// ---------------------------------------------------------------------------
const writeQueue = [];
let writing = false;
function enqueueWrite(file, data) {
  writeQueue.push({ file, data });
  if (!writing) drainQueue();
}
function drainQueue() {
  if (writeQueue.length === 0) { writing = false; return; }
  writing = true;
  const { file, data } = writeQueue.shift();
  setImmediate(() => {
    fs.writeFile(file, JSON.stringify(data, null, 2), (err) => {
      if (err) log('error', 'storage', `writeFile ${file} failed: ${err.message}`);
      setImmediate(drainQueue);
    });
  });
}
function saveCalls() { enqueueWrite(CALLS_FILE, calls); }
function saveLeads() { enqueueWrite(LEADS_FILE, leads); }
function saveCars()  { enqueueWrite(CARS_FILE,  cars);  }

// ---------------------------------------------------------------------------
// SSE broadcasting
// ---------------------------------------------------------------------------
function broadcast(obj) {
  const payload = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Audio resampler 24kHz -> 16kHz (linear interpolation, pure JS)
// ---------------------------------------------------------------------------
function resample24to16(pcm24) {
  // pcm24: Buffer of signed 16-bit LE samples at 24000 Hz
  const srcCount = Math.floor(pcm24.length / 2);
  const ratio = 16000 / 24000; // 2/3
  const dstCount = Math.floor(srcCount * ratio);
  const out = Buffer.alloc(dstCount * 2);
  for (let i = 0; i < dstCount; i++) {
    const srcPos = i / ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, srcCount - 1);
    const frac = srcPos - i0;
    const s0 = pcm24.readInt16LE(i0 * 2);
    const s1 = pcm24.readInt16LE(i1 * 2);
    const v  = Math.round(s0 + (s1 - s0) * frac);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i * 2);
  }
  return out;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// Inventory helpers
// ---------------------------------------------------------------------------
function normalize(s) {
  return (s || '').toString().toLowerCase().replace(/[\s\-_]/g, '');
}
function scoreCar(car, clues) {
  let score = 0;
  const c = clues || {};
  if (c.registration_number && normalize(car.registration_number) === normalize(c.registration_number)) score += 100;
  if (c.brand && normalize(car.brand).includes(normalize(c.brand))) score += 8;
  if (c.model && normalize(car.model).includes(normalize(c.model))) score += 8;
  if (c.color && normalize(car.color) === normalize(c.color)) score += 4;
  if (c.year && Number(c.year) === Number(car.year)) score += 3;
  if (c.price) {
    const diff = Math.abs(Number(c.price) - Number(car.price));
    if (diff < 500)  score += 6;
    else if (diff < 2000) score += 3;
    else if (diff < 5000) score += 1;
  }
  return score;
}
function matchCarFromClues(clues) {
  if (!clues) return { car: null, score: 0, candidates: [] };
  const scored = cars.map((car) => ({ car, score: scoreCar(car, clues) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.score < 4) return { car: null, score: 0, candidates: scored.slice(0, 3).map((x) => x.car) };
  return { car: best.car, score: best.score, candidates: scored.slice(0, 3).map((x) => x.car) };
}

// ---------------------------------------------------------------------------
// OpenAI helpers
// ---------------------------------------------------------------------------
function buildReplySystemPrompt(session) {
  const car = session.matchedCar;
  let base = `You are a professional, polite assistant for a car dealership. Speak naturally and briefly — one or two short sentences per reply. Help the customer, gather their intent, ask clarifying questions when needed, and be useful. Do not list prices or specifications unless asked.`;

  if (car) {
    base += `\n\nThe customer is asking about this vehicle from our inventory:\n` +
      `- ${car.year} ${car.color} ${car.brand} ${car.model}\n` +
      `- Registration: ${car.registration_number}\n` +
      `- Price: $${car.price}\n` +
      `- Mileage: ${car.mileage} km\n` +
      `- Fuel: ${car.fuel_type}, Transmission: ${car.transmission}\n` +
      `- Horsepower: ${car.horsepower}\n` +
      `- Condition: ${car.condition}\n` +
      `- Damages: ${car.damages || 'None reported'}\n` +
      `- Available: ${car.available ? 'Yes' : 'No (sold)'}\n` +
      `- Description: ${car.description}\n` +
      `Answer their questions using these facts. If asked about appointments, confirm we can book a visit and ask for a preferred day and time.`;
  } else {
    base += `\n\nWe have not yet identified which vehicle the customer is asking about. After your spoken reply, append a sentinel line exactly like this:\n##CAR_CLUES##{"brand":"","model":"","color":"","year":null,"price":null,"registration_number":""}\n` +
      `Fill in any clues you detected in the whole conversation so far. Use empty string or null when unknown. Never speak the sentinel aloud — it is metadata only.`;
  }
  return base;
}

async function generateReplyAndExtractCar(session, userText) {
  if (!openai) throw new Error('OPENAI_API_KEY not configured');

  session.history.push({ role: 'user', content: userText });

  const messages = [
    { role: 'system', content: buildReplySystemPrompt(session) },
    ...session.history.slice(-20),
  ];

  const t0 = Date.now();
  const resp = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages,
    temperature: 0.5,
    max_tokens: 180,
  });
  log('info', 'openai', `reply generated in ${Date.now() - t0}ms`, { session_id: session.id });

  let text = (resp.choices[0]?.message?.content || '').trim();

  // Strip sentinel
  let clues = null;
  const sentIdx = text.indexOf('##CAR_CLUES##');
  if (sentIdx !== -1) {
    const before = text.slice(0, sentIdx).trim();
    const after  = text.slice(sentIdx + '##CAR_CLUES##'.length).trim();
    try {
      const jsonMatch = after.match(/\{[\s\S]*?\}/);
      if (jsonMatch) clues = JSON.parse(jsonMatch[0]);
    } catch (e) {
      log('warn', 'extraction', `failed to parse car clues: ${e.message}`, { session_id: session.id });
    }
    text = before;
  }

  session.history.push({ role: 'assistant', content: text });
  return { text, clues };
}

async function extractLead(session) {
  if (!openai) return null;
  const transcriptTxt = session.transcript
    .map((t) => `${t.speaker === 'caller' ? 'Caller' : 'AI'}: ${t.text}`)
    .join('\n');

  const schema = {
    customer_name: '',
    phone_number: '',
    requested_car_id: '',
    requested_car_label: '',
    intent: '',
    questions: [],
    appointment_request: '',
    callback_requested: false,
    availability_question: false,
    damage_question: false,
    price_question: false,
    notes: '',
  };

  const sys = `You extract structured lead data from a phone call transcript between a car dealer AI assistant and a potential customer. ` +
    `Return ONLY valid minified JSON matching this schema exactly (no markdown, no commentary):\n` +
    JSON.stringify(schema) + `\n` +
    `- phone_number: digits only, no spaces. If missing, empty string.\n` +
    `- appointment_request: ISO-ish day/time string in plain English, e.g. "Monday afternoon". Empty if none.\n` +
    `- questions: array of short strings listing what the caller asked.\n` +
    `- notes: any extra context worth knowing for the salesperson.`;

  const user = `Transcript:\n${transcriptTxt}\n\n` +
    (session.matchedCar
      ? `Matched car: ${session.matchedCar.id} — ${session.matchedCar.year} ${session.matchedCar.color} ${session.matchedCar.brand} ${session.matchedCar.model} (${session.matchedCar.registration_number})`
      : `Matched car: none`);

  try {
    const t0 = Date.now();
    const resp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      temperature: 0,
      response_format: { type: 'json_object' },
      max_tokens: 500,
    });
    log('info', 'extraction', `lead extracted in ${Date.now() - t0}ms`, { session_id: session.id });
    const obj = JSON.parse(resp.choices[0].message.content);
    if (session.matchedCar) {
      obj.requested_car_id = session.matchedCar.id;
      obj.requested_car_label = `${session.matchedCar.year} ${session.matchedCar.color} ${session.matchedCar.brand} ${session.matchedCar.model}`;
    }
    return obj;
  } catch (e) {
    log('error', 'extraction', `lead extraction failed: ${e.message}`, { session_id: session.id });
    return null;
  }
}

// ---------------------------------------------------------------------------
// OpenAI TTS -> stream to Vonage
// ---------------------------------------------------------------------------
async function speakToCaller(session, text) {
  if (!openai || !text) return;
  if (!session.ws || session.ws.readyState !== WebSocket.OPEN) return;

  session.turn = 'speaking';
  broadcast({ type: 'session', session: serializeSession(session) });

  try {
    const t0 = Date.now();
    const ttsResp = await openai.audio.speech.create({
      model: 'tts-1',
      voice: 'nova',
      input: text,
      response_format: 'pcm',
    });
    const pcm24 = Buffer.from(await ttsResp.arrayBuffer());
    log('info', 'tts', `tts synthesized ${pcm24.length} bytes in ${Date.now() - t0}ms`, { session_id: session.id });

    const pcm16 = resample24to16(pcm24);
    log('info', 'tts', `resampled to ${pcm16.length} bytes (16kHz)`, { session_id: session.id });

    const CHUNK = 640; // 20ms at 16kHz 16-bit mono
    session.playbackAborted = false;

    for (let i = 0; i < pcm16.length; i += CHUNK) {
      if (session.playbackAborted) break;
      if (!session.ws || session.ws.readyState !== WebSocket.OPEN) break;
      let chunk = pcm16.subarray(i, i + CHUNK);
      if (chunk.length < CHUNK) {
        const padded = Buffer.alloc(CHUNK);
        chunk.copy(padded);
        chunk = padded;
      }
      try { session.ws.send(chunk, { binary: true }); }
      catch (e) { log('warn', 'websocket', `send failed: ${e.message}`, { session_id: session.id }); break; }
      await sleep(20);
    }
    log('info', 'tts', `playback complete`, { session_id: session.id });
  } catch (e) {
    log('error', 'tts', `tts failed: ${e.message}`, { session_id: session.id });
  } finally {
    session.turn = 'idle';
    broadcast({ type: 'session', session: serializeSession(session) });
  }
}

// ---------------------------------------------------------------------------
// Session / turn handling
// ---------------------------------------------------------------------------
function serializeSession(s) {
  if (!s) return null;
  return {
    id: s.id,
    conversation_uuid: s.conversation_uuid,
    from: s.from,
    to: s.to,
    status: s.status,
    turn: s.turn,
    started_at: s.started_at,
    matched_car_id: s.matchedCar ? s.matchedCar.id : null,
    matched_car_label: s.matchedCar
      ? `${s.matchedCar.year} ${s.matchedCar.color} ${s.matchedCar.brand} ${s.matchedCar.model}`
      : null,
    transcript: s.transcript,
    interim: s.interim || '',
  };
}

async function processCallerInput(session, userText) {
  if (session.turn !== 'idle') {
    log('warn', 'openai', `processCallerInput discarded — turn=${session.turn}`, { session_id: session.id });
    return;
  }
  session.turn = 'thinking';
  broadcast({ type: 'session', session: serializeSession(session) });

  const addedAt = new Date().toISOString();
  session.transcript.push({ speaker: 'caller', text: userText, ts: addedAt });
  broadcast({ type: 'transcript', call_id: session.id, entry: { speaker: 'caller', text: userText, ts: addedAt } });
  persistCall(session);

  try {
    const { text: reply, clues } = await generateReplyAndExtractCar(session, userText);

    // Attempt car match if not yet matched
    if (!session.matchedCar && clues) {
      const { car, score, candidates } = matchCarFromClues(clues);
      if (car) {
        session.matchedCar = car;
        log('info', 'inventory', `matched car ${car.id} (score=${score})`, { session_id: session.id });
      } else if (candidates.length > 0) {
        log('info', 'inventory', `no strong match; ${candidates.length} candidates`, { session_id: session.id });
      } else {
        log('info', 'inventory', `no matching car yet`, { session_id: session.id });
      }
    }

    const ts = new Date().toISOString();
    session.transcript.push({ speaker: 'ai', text: reply, ts });
    broadcast({ type: 'transcript', call_id: session.id, entry: { speaker: 'ai', text: reply, ts } });
    persistCall(session);

    await speakToCaller(session, reply);
  } catch (e) {
    log('error', 'openai', `processCallerInput failed: ${e.message}`, { session_id: session.id });
    session.turn = 'idle';
    broadcast({ type: 'session', session: serializeSession(session) });
  }
}

function persistCall(session) {
  const existing = calls.find((c) => c.id === session.id);
  const record = {
    id: session.id,
    conversation_uuid: session.conversation_uuid,
    from: session.from,
    to: session.to,
    status: session.status,
    started_at: session.started_at,
    ended_at: session.ended_at || null,
    matched_car_id: session.matchedCar ? session.matchedCar.id : null,
    transcript: session.transcript,
  };
  if (existing) Object.assign(existing, record);
  else calls.push(record);
  saveCalls();
}

async function finalizeCall(session) {
  if (session.finalized) return;
  session.finalized = true;
  session.ended_at = new Date().toISOString();
  session.status = 'completed';
  persistCall(session);

  if (session.transcript.length === 0) {
    log('info', 'websocket', `call ${session.id} ended with no transcript — skipping lead`, { session_id: session.id });
    return;
  }

  try {
    const lead = await extractLead(session);
    if (lead) {
      const rec = {
        id: `lead_${crypto.randomBytes(6).toString('hex')}`,
        call_id: session.id,
        created_at: new Date().toISOString(),
        read: false,
        ...lead,
      };
      leads.unshift(rec);
      saveLeads();
      broadcast({ type: 'lead', lead: rec });
      log('info', 'extraction', `lead ${rec.id} saved`, { session_id: session.id });
    }
  } catch (e) {
    log('error', 'extraction', `finalize failed: ${e.message}`, { session_id: session.id });
  }
  broadcast({ type: 'session_end', call_id: session.id });
}

// ---------------------------------------------------------------------------
// ElevenLabs streaming STT per session
// ---------------------------------------------------------------------------
async function openElevenStream(session) {
  if (!eleven) {
    log('error', 'elevenlabs', 'ELEVEN_LABS_API_KEY not configured', { session_id: session.id });
    return;
  }
  try {
    // Use direct WebSocket to ElevenLabs realtime STT API to avoid SDK version drift.
    const elevenWS = new WebSocket(
      'wss://api.elevenlabs.io/v1/speech-to-text/stream?model_id=scribe_v1&language_code=en',
      { headers: { 'xi-api-key': ELEVEN_LABS_API_KEY } }
    );

    session.elevenWS = elevenWS;
    session.sttPending = [];

    elevenWS.on('open', () => {
      log('info', 'elevenlabs', 'STT stream open', { session_id: session.id });
      try {
        elevenWS.send(JSON.stringify({
          type: 'config',
          encoding: 'linear16',
          sample_rate: 16000,
          channels: 1,
          endpointing: 300,
        }));
      } catch (e) {
        log('warn', 'elevenlabs', `config send failed: ${e.message}`, { session_id: session.id });
      }
      // Flush any buffered frames
      for (const f of session.sttPending) {
        try { elevenWS.send(f, { binary: true }); } catch {}
      }
      session.sttPending = null;
    });

    elevenWS.on('message', (msg, isBinary) => {
      if (isBinary) return;
      let data;
      try { data = JSON.parse(msg.toString()); }
      catch { return; }

      // Normalize transcript shape across variants
      const text = (data.text || data.transcript || (data.alternatives && data.alternatives[0]?.text) || '').trim();
      if (!text) return;
      const isFinal = data.is_final === true || data.type === 'final' || data.final === true;

      if (!isFinal) {
        session.interim = text;
        broadcast({ type: 'interim', call_id: session.id, text });
        return;
      }

      session.interim = '';
      broadcast({ type: 'interim', call_id: session.id, text: '' });

      // Debounce 600ms of silence after final before processing
      if (session.silenceTimer) clearTimeout(session.silenceTimer);
      session.pendingFinal = (session.pendingFinal ? session.pendingFinal + ' ' : '') + text;
      session.silenceTimer = setTimeout(() => {
        const utter = (session.pendingFinal || '').trim();
        session.pendingFinal = '';
        if (utter.length >= 2) {
          processCallerInput(session, utter).catch((e) =>
            log('error', 'openai', `processCallerInput error: ${e.message}`, { session_id: session.id })
          );
        }
      }, 600);
    });

    elevenWS.on('error', (e) => {
      log('error', 'elevenlabs', `STT error: ${e.message}`, { session_id: session.id });
    });
    elevenWS.on('close', () => {
      log('info', 'elevenlabs', 'STT stream closed', { session_id: session.id });
      session.elevenWS = null;
    });
  } catch (e) {
    log('error', 'elevenlabs', `failed to open stream: ${e.message}`, { session_id: session.id });
  }
}

function forwardAudioToEleven(session, frame) {
  if (!session.elevenWS) return;
  if (session.elevenWS.readyState === WebSocket.CONNECTING) {
    if (session.sttPending) session.sttPending.push(frame);
    return;
  }
  if (session.elevenWS.readyState !== WebSocket.OPEN) return;
  try { session.elevenWS.send(frame, { binary: true }); }
  catch (e) { log('warn', 'elevenlabs', `forward send failed: ${e.message}`, { session_id: session.id }); }
}

// ---------------------------------------------------------------------------
// Express routes
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Vonage Answer webhook
app.all('/api/vonage/answer', (req, res) => {
  const params = { ...req.query, ...req.body };
  const from = params.from || 'unknown';
  const to = params.to || 'unknown';
  const conversation_uuid = params.conversation_uuid || params.uuid || `conv_${crypto.randomBytes(4).toString('hex')}`;
  log('info', 'webhook', `answer webhook from=${from} to=${to} conv=${conversation_uuid}`);

  const wsBase = BASE_URL.replace(/^http/i, 'ws').replace(/\/$/, '');
  const ncco = [
    {
      action: 'talk',
      text: "Hello, thanks for calling. Our salesperson is unavailable right now, but I can help you. Which car are you interested in?",
      language: 'en-US',
    },
    {
      action: 'connect',
      from: 'NexmoDTMF',
      endpoint: [
        {
          type: 'websocket',
          uri: `${wsBase}/ws-audio?conversation_uuid=${encodeURIComponent(conversation_uuid)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
          'content-type': 'audio/l16;rate=16000',
          headers: { conversation_uuid, from, to },
        },
      ],
    },
  ];
  res.json(ncco);
});

// Vonage Event webhook
app.all('/api/vonage/events', (req, res) => {
  const e = { ...req.query, ...req.body };
  const status = e.status || 'unknown';
  const conv = e.conversation_uuid || e.uuid || '-';
  log('info', 'webhook', `event status=${status} conv=${conv}`, { event: e });

  // Update session status if we recognize it
  for (const s of sessions.values()) {
    if (s.conversation_uuid === conv) {
      s.status = status;
      broadcast({ type: 'session', session: serializeSession(s) });
      if (status === 'completed' || status === 'failed') {
        finalizeCall(s).catch(() => {});
      }
      break;
    }
  }
  res.sendStatus(200);
});

// Dashboard APIs
app.get('/api/cars', (_req, res) => res.json(cars));
app.get('/api/cars/:id', (req, res) => {
  const car = cars.find((c) => c.id === req.params.id);
  if (!car) return res.status(404).json({ error: 'not_found' });
  const carLeads = leads.filter((l) => l.requested_car_id === car.id);
  const carCalls = calls.filter((c) => c.matched_car_id === car.id);
  res.json({ car, leads: carLeads, calls: carCalls });
});

app.get('/api/leads', (_req, res) => res.json(leads));
app.get('/api/leads/:id', (req, res) => {
  const lead = leads.find((l) => l.id === req.params.id);
  if (!lead) return res.status(404).json({ error: 'not_found' });
  const call = calls.find((c) => c.id === lead.call_id) || null;
  const car = lead.requested_car_id ? cars.find((c) => c.id === lead.requested_car_id) : null;
  res.json({ lead, call, car });
});
app.post('/api/leads/:id/read', (req, res) => {
  const lead = leads.find((l) => l.id === req.params.id);
  if (!lead) return res.status(404).json({ error: 'not_found' });
  lead.read = true;
  saveLeads();
  broadcast({ type: 'lead', lead });
  res.json({ ok: true });
});

app.get('/api/calls', (_req, res) => res.json(calls));
app.get('/api/calls/:id', (req, res) => {
  const call = calls.find((c) => c.id === req.params.id);
  if (!call) return res.status(404).json({ error: 'not_found' });
  res.json(call);
});

app.get('/api/live', (_req, res) => {
  const out = [];
  for (const s of sessions.values()) out.push(serializeSession(s));
  res.json(out);
});

app.get('/api/logs', (_req, res) => res.json(logs.slice(-500)));

// SSE stream
app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`: connected\n\n`);
  sseClients.add(res);
  const heartbeat = setInterval(() => {
    try { res.write(`: hb\n\n`); } catch {}
  }, 25000);
  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

app.get('/health', (_req, res) => res.json({ ok: true }));

// ---------------------------------------------------------------------------
// HTTP + WebSocket server
// ---------------------------------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, BASE_URL);
  if (url.pathname === '/ws-audio') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleVonageWS(ws, req, url);
    });
  } else {
    socket.destroy();
  }
});

function handleVonageWS(ws, req, url) {
  const conversation_uuid = url.searchParams.get('conversation_uuid') || `conv_${crypto.randomBytes(4).toString('hex')}`;
  const from = url.searchParams.get('from') || 'unknown';
  const to   = url.searchParams.get('to')   || 'unknown';

  const callId = `call_${crypto.randomBytes(6).toString('hex')}`;
  const session = {
    id: callId,
    conversation_uuid,
    from,
    to,
    status: 'answered',
    turn: 'idle',
    started_at: new Date().toISOString(),
    ended_at: null,
    ws,
    elevenWS: null,
    sttPending: [],
    transcript: [],
    history: [],
    matchedCar: null,
    interim: '',
    pendingFinal: '',
    silenceTimer: null,
    playbackAborted: false,
    finalized: false,
  };
  sessions.set(callId, session);
  log('info', 'websocket', `Vonage WS connected from=${from} conv=${conversation_uuid}`, { session_id: callId });
  broadcast({ type: 'session', session: serializeSession(session) });
  persistCall(session);

  openElevenStream(session);

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      // Echo gate: drop inbound frames while AI is speaking
      if (session.turn === 'speaking') return;
      forwardAudioToEleven(session, data);
    } else {
      // Vonage may send JSON control messages — log them
      const s = data.toString().slice(0, 500);
      log('info', 'websocket', `control message: ${s}`, { session_id: callId });
    }
  });

  ws.on('close', () => {
    log('info', 'websocket', `Vonage WS closed`, { session_id: callId });
    session.playbackAborted = true;
    if (session.silenceTimer) clearTimeout(session.silenceTimer);
    if (session.elevenWS && session.elevenWS.readyState === WebSocket.OPEN) {
      try { session.elevenWS.close(); } catch {}
    }
    finalizeCall(session).finally(() => {
      setTimeout(() => sessions.delete(callId), 2000);
    });
  });

  ws.on('error', (e) => {
    log('error', 'websocket', `Vonage WS error: ${e.message}`, { session_id: callId });
  });
}

// ---------------------------------------------------------------------------
// Global error safety
// ---------------------------------------------------------------------------
process.on('uncaughtException', (e) => log('error', 'errors', `uncaughtException: ${e.stack || e.message}`));
process.on('unhandledRejection', (e) => log('error', 'errors', `unhandledRejection: ${e && e.message ? e.message : e}`));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
server.listen(PORT, () => {
  log('info', 'webhook', `Server listening on port ${PORT} — BASE_URL=${BASE_URL}`);
  if (!OPENAI_API_KEY) log('warn', 'openai', 'OPENAI_API_KEY is not set');
  if (!ELEVEN_LABS_API_KEY) log('warn', 'elevenlabs', 'ELEVEN_LABS_API_KEY is not set');
});
