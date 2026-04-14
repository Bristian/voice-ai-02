require('dotenv').config();

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const OpenAI = require('openai');

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

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------
let cars  = loadCarsFile(CARS_FILE);
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

// cars.json may be stored as concatenated JSON objects separated by blank
// lines rather than a proper JSON array. This loader handles both formats.
function loadCarsFile(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    // Fast path: valid JSON array (or single object).
    try { return JSON.parse(raw); } catch {}
    // Fallback: split on blank lines between top-level objects and parse each.
    const parts = raw.split(/(?<=\})\s*\n\s*(?=\{)/);
    const result = [];
    for (const p of parts) {
      const t = p.trim();
      if (!t) continue;
      try { result.push(JSON.parse(t)); } catch {}
    }
    return result;
  } catch { return []; }
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
//
// The inventory JSON follows the Blocket vehicle_ad schema. Each entry is
// shaped like { "vehicle_ad": { ... } }. These helpers unwrap it and expose
// the fields the rest of the app needs.
// ---------------------------------------------------------------------------
function ad(car) {
  return (car && car.vehicle_ad) ? car.vehicle_ad : null;
}
function carId(car) {
  const a = ad(car);
  return a ? String(a.id) : null;
}
function isAvailable(car) {
  const a = ad(car);
  return !!(a && a.ad_status === 'active');
}
function carLabel(car) {
  const a = ad(car);
  if (!a) return 'Unknown vehicle';
  const v = a.vehicle || {};
  const parts = [v.year, v.color, v.make, v.model, v.variant].filter(Boolean);
  return parts.join(' ') || a.heading || 'Unknown vehicle';
}
function carShortLabel(car) {
  const a = ad(car);
  if (!a) return 'Unknown vehicle';
  const v = a.vehicle || {};
  return [v.year, v.make, v.model].filter(Boolean).join(' ') || a.heading;
}
function priceText(car) {
  const a = ad(car);
  if (!a || !a.price) return '';
  const { amount, currency, suffix } = a.price;
  if (suffix) return `${amount} ${suffix}`;
  if (currency) return `${amount} ${currency}`;
  return String(amount);
}
function normalize(s) {
  return (s || '').toString().toLowerCase().replace(/[\s\-_]/g, '');
}
function scoreCar(car, clues) {
  const a = ad(car);
  if (!a) return 0;
  const v = a.vehicle || {};
  const p = a.price || {};
  let score = 0;
  const c = clues || {};
  if (c.registration_number && v.registration_number &&
      normalize(v.registration_number) === normalize(c.registration_number)) score += 100;
  if (c.brand && v.make && normalize(v.make).includes(normalize(c.brand))) score += 8;
  if (c.model && v.model && normalize(v.model).includes(normalize(c.model))) score += 8;
  if (c.model && v.variant && normalize(v.variant).includes(normalize(c.model))) score += 2;
  if (c.color && v.color && normalize(v.color) === normalize(c.color)) score += 4;
  if (c.year && v.year && Number(c.year) === Number(v.year)) score += 3;
  if (c.price && p.amount) {
    const diff = Math.abs(Number(c.price) - Number(p.amount));
    // Threshold scales with price magnitude since prices may be in SEK (6-digit) or USD (5-digit)
    if (diff < 1000)  score += 6;
    else if (diff < 5000) score += 3;
    else if (diff < 20000) score += 1;
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

// A compact inventory summary the model can use to ANSWER questions directly
// when no specific car has been locked in yet. Every car gets one line with
// its key identifying attributes so the model can find a match from natural
// language like "the Ford Focus" or "the black Audi".
function buildInventorySummary() {
  const lines = cars.map((c) => {
    const a = ad(c);
    if (!a) return null;
    const v = a.vehicle || {};
    const loc = a.location || {};
    const status = a.ad_status === 'active' ? 'available'
      : a.ad_status === 'reserved' ? 'reserved'
      : a.ad_status === 'sold' ? 'sold'
      : (a.ad_status || 'unknown');
    return `- id=${a.id} | ${v.year || '?'} ${v.color || ''} ${v.make || ''} ${v.model || ''} ${v.variant || ''} | reg=${v.registration_number || '?'} | ${priceText(c) || 'price on request'} | ${v.mileage_km != null ? v.mileage_km + 'km' : 'mileage unknown'} | ${v.fuel || '?'}, ${v.transmission || '?'} | ${v.engine_power_hp || '?'}hp | ${loc.postal_name || loc.municipality || ''} | ${status}`
      .replace(/ +/g, ' ');
  }).filter(Boolean).join('\n');
  return lines;
}

// The detailed fact sheet for a single matched car, used once the model has
// locked in which vehicle the caller is asking about.
function buildMatchedCarFacts(car) {
  const a = ad(car);
  if (!a) return '';
  const v = a.vehicle || {};
  const loc = a.location || {};
  const meta = a.seller_metadata || {};
  const statusLine = a.ad_status === 'active'
    ? 'Available for sale'
    : (a.ad_status === 'reserved' ? 'Reserved (deposit taken, may still fall through)'
      : (a.ad_status === 'sold' ? 'Sold' : `Status: ${a.ad_status}`));

  return `- Ad ID: ${a.id}\n` +
    `- Listing headline: ${a.heading}\n` +
    `- ${v.year || '?'} ${v.color || ''} ${v.make || ''} ${v.model || ''} ${v.variant || ''}\n`.replace(/ +/g, ' ') +
    `- Registration: ${v.registration_number || 'unknown'}\n` +
    `- VIN: ${v.vin || 'unknown'}\n` +
    `- Price: ${priceText(car) || 'on request'}\n` +
    `- Mileage: ${v.mileage_km != null ? v.mileage_km + ' km' : 'unknown'}\n` +
    `- Fuel: ${v.fuel || 'unknown'}\n` +
    `- Transmission: ${v.transmission || 'unknown'}\n` +
    `- Drivetrain: ${v.drivetrain || 'unknown'}\n` +
    `- Body type: ${v.body_type || 'unknown'}, Doors: ${v.doors || '?'}, Seats: ${v.seats || '?'}\n` +
    `- Power: ${v.engine_power_hp || '?'} hp (${v.engine_power_kw || '?'} kW)\n` +
    `- Engine size: ${v.engine_size_cc || '?'} cc\n` +
    `- Fuel consumption: ${v.consumption_l_100km != null ? v.consumption_l_100km + ' L/100km' : 'unknown'}\n` +
    `- CO₂ emissions: ${v.co2_g_km != null ? v.co2_g_km + ' g/km' : 'unknown'}\n` +
    `- Emission class: ${v.emission_class || 'unknown'}\n` +
    `- Inspection valid until: ${v.inspection_valid_until || 'unknown'}\n` +
    `- Annual tax: ${v.tax_annual_sek != null ? v.tax_annual_sek + ' SEK' : 'unknown'}\n` +
    `- Towbar: ${v.towbar ? 'yes' : 'no'}\n` +
    `- Service book: ${v.service_book ? 'yes' : 'no'}\n` +
    `- Winter tires: ${v.winter_tires ? 'yes' : 'no'}\n` +
    `- Summer tires: ${v.summer_tires ? 'yes' : 'no'}\n` +
    `- Previous owners: ${meta.owners_count != null ? meta.owners_count : 'unknown'}\n` +
    `- Imported: ${meta.imported ? 'yes' : 'no'}\n` +
    `- Accident-free: ${meta.accident_free ? 'yes' : 'no (has been in an accident)'}\n` +
    `- Location: ${loc.postal_name || loc.municipality || 'unknown'}${loc.county ? ', ' + loc.county : ''}\n` +
    `- Availability: ${statusLine}\n` +
    `- Description: ${a.body || '(none)'}\n`;
}

function buildReplySystemPrompt(session) {
  const car = session.matchedCar;
  const a = ad(car);

  let base =
    `You are a professional, polite phone assistant for a car dealership. ` +
    `Speak naturally and briefly — one or two short sentences per reply. ` +
    `Keep it conversational; do not read out long lists of specs — give the specific facts the caller asked for. ` +
    `\n\n` +
    `CRITICAL RULES:\n` +
    `1. You DO have access to the dealership's full vehicle inventory — it is provided below in this system message. Always use it to answer.\n` +
    `2. NEVER say you don't have access to the database, don't have the information, can't look it up, or need to check elsewhere. If the caller asks about a vehicle, find it in the inventory and answer directly.\n` +
    `3. Only ask the caller a clarifying question if the inventory genuinely contains multiple vehicles that match their description, or if they have not mentioned any vehicle at all yet.\n` +
    `4. When the caller asks a specific factual question (transmission, mileage, price, availability, damages, fuel type, etc.), answer it directly from the inventory data. Do not deflect.\n` +
    `5. If the caller asks about appointments, confirm we can book a visit at our location and ask for a preferred day and time. If they ask for a callback, acknowledge it and confirm the phone number.\n`;

  if (a) {
    base += `\n\nThe caller is asking about this specific vehicle (already identified from the conversation):\n` +
      buildMatchedCarFacts(car) +
      `\nAnswer the caller's questions using the facts above. When they ask about "damages" or "condition", use the accident-free flag and previous-owners count as the honest basis.`;
  } else {
    base += `\n\nFull vehicle inventory (${cars.length} vehicles). Use this to identify which car the caller is asking about, and to answer their questions. If the caller mentions any identifying detail — registration number, make, model, color, price, year — find the matching car in this list and answer from its row:\n\n` +
      buildInventorySummary() +
      `\n\nIf only one vehicle reasonably matches the caller's description, treat it as the one they mean and answer from its row. Only ask "which car" if multiple rows genuinely match.`;
  }
  return base;
}

// Pre-reply car identification: ask a small JSON-only call to pull any car
// clues out of the full transcript, then match them against the inventory.
// Runs on every turn until a car is locked in.
async function identifyCarFromTranscript(session) {
  if (!openai) return null;
  if (session.matchedCar) return session.matchedCar;
  if (!cars.length) return null;

  const transcriptTxt = session.history
    .filter((h) => h.role === 'user' || h.role === 'assistant')
    .map((h) => `${h.role === 'user' ? 'Caller' : 'AI'}: ${h.content}`)
    .join('\n');
  if (!transcriptTxt.trim()) return null;

  const inventorySummary = buildInventorySummary();

  const sys =
    `You match a phone caller's spoken request to a specific vehicle in a car dealership's inventory. ` +
    `Return ONLY valid minified JSON: {"car_id":"<ad_id or empty>","confidence":<0..1>,"brand":"","model":"","color":"","year":null,"price":null,"registration_number":""}. ` +
    `Put the ad_id of the best-matching row in car_id if you can identify it with reasonable confidence (>=0.5). Otherwise leave car_id empty and fill whatever clues you have. No markdown, no commentary.`;

  const user = `Inventory:\n${inventorySummary}\n\nTranscript so far:\n${transcriptTxt}`;

  try {
    const t0 = Date.now();
    const resp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      temperature: 0,
      response_format: { type: 'json_object' },
      max_tokens: 150,
    });
    log('info', 'inventory', `car identification call ${Date.now() - t0}ms`, { session_id: session.id });

    const obj = JSON.parse(resp.choices[0].message.content || '{}');

    // Preferred: direct ad_id match from the model
    if (obj.car_id) {
      const direct = cars.find((c) => carId(c) === String(obj.car_id));
      if (direct) {
        log('info', 'inventory', `identified car directly by id=${obj.car_id}`, { session_id: session.id });
        return direct;
      }
    }

    // Fallback: score clues against inventory
    const clues = {
      brand: obj.brand || '',
      model: obj.model || '',
      color: obj.color || '',
      year: obj.year || null,
      price: obj.price || null,
      registration_number: obj.registration_number || '',
    };
    if (Object.values(clues).some((v) => v !== '' && v !== null)) {
      const { car, score } = matchCarFromClues(clues);
      if (car) {
        log('info', 'inventory', `matched car by clues (score=${score}): ${carId(car)}`, { session_id: session.id });
        return car;
      }
    }
  } catch (e) {
    log('warn', 'inventory', `car identification failed: ${e.message}`, { session_id: session.id });
  }
  return null;
}

async function generateReply(session, userText) {
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
    temperature: 0.4,
    max_tokens: 200,
  });
  log('info', 'openai', `reply generated in ${Date.now() - t0}ms`, { session_id: session.id });

  const text = (resp.choices[0]?.message?.content || '').trim();
  session.history.push({ role: 'assistant', content: text });
  return text;
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

  const mA = ad(session.matchedCar);
  const user = `Transcript:\n${transcriptTxt}\n\n` +
    (mA
      ? `Matched car: ${mA.id} — ${carLabel(session.matchedCar)} (${mA.vehicle?.registration_number || 'no reg'})`
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
    if (mA) {
      obj.requested_car_id = String(mA.id);
      obj.requested_car_label = carLabel(session.matchedCar);
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

    let bargedIn = false;
    for (let i = 0; i < pcm16.length; i += CHUNK) {
      if (session.playbackAborted) { bargedIn = true; break; }
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
    log('info', 'tts', bargedIn ? `playback aborted (barge-in)` : `playback complete`, { session_id: session.id });
  } catch (e) {
    log('error', 'tts', `tts failed: ${e.message}`, { session_id: session.id });
  }
  // NOTE: turn state is reset by runTurn's finally block, not here.
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
    matched_car_id: carId(s.matchedCar),
    matched_car_label: s.matchedCar ? carLabel(s.matchedCar) : null,
    transcript: s.transcript,
    interim: s.interim || '',
  };
}

async function processCallerInput(session, userText) {
  // Legacy entry point kept for safety; all utterance handling goes through
  // handleCommittedUtterance now which buffers and checks completeness.
  return handleCommittedUtterance(session, userText);
}

// Completeness heuristic: is this utterance likely the end of the caller's
// turn, or are they mid-sentence and about to continue? Used purely as a
// fast local pre-filter so we don't call OpenAI for every fragment.
function looksComplete(text) {
  if (!text) return false;
  const t = text.trim();
  if (t.length < 3) return false;
  // Ends with terminal punctuation → definitely complete.
  if (/[.!?]["')\]]?$/.test(t)) return true;
  // Ends with obvious "more coming" cues → definitely incomplete.
  if (/\b(and|or|but|so|because|with|to|for|of|in|on|at|the|a|an|my|your|is|are|was|were|i|we|he|she|they|it|um|uh|like|that|this|then|if|when|where)$/i.test(t)) return false;
  // Ends with comma / semicolon → incomplete.
  if (/[,;:]$/.test(t)) return false;
  // Very short and no terminal punctuation — probably incomplete (e.g. "hello", "yes",
  // "the Ford Focus"). Short direct answers like "yes" are explicitly allowed.
  const words = t.split(/\s+/).length;
  if (words <= 2 && /^(yes|yeah|yep|no|nope|ok|okay|sure|right|correct)\b/i.test(t)) return true;
  // Longer fragments without terminal punctuation are ambiguous — let the LLM decide.
  return null; // null means "ask the LLM"
}

// LLM-based end-of-turn check. Fast, cheap, called only when the local
// heuristic is ambiguous. Returns true if the caller has finished speaking.
async function isTurnComplete(session, fullUtterance) {
  if (!openai) return true;
  try {
    const t0 = Date.now();
    const resp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      max_tokens: 10,
      messages: [
        { role: 'system', content:
          `You decide whether a caller in a live phone conversation has finished speaking. ` +
          `Given their most recent utterance, reply with ONLY the single word "complete" if they sound like they have finished their thought and are waiting for a reply, ` +
          `or "incomplete" if they are mid-sentence, mid-list, or about to continue. ` +
          `Short direct questions or answers are complete. Trailing conjunctions, unfinished clauses, or mid-list pauses are incomplete.`
        },
        { role: 'user', content: fullUtterance }
      ],
    });
    const out = (resp.choices[0]?.message?.content || '').toLowerCase().trim();
    const complete = out.startsWith('complete');
    log('info', 'openai', `turn-complete check "${fullUtterance.slice(0, 60)}" → ${out} (${Date.now() - t0}ms)`,
      { session_id: session.id });
    return complete;
  } catch (e) {
    log('warn', 'openai', `turn-complete check failed: ${e.message} — defaulting to complete`, { session_id: session.id });
    return true;
  }
}

// Core entry point for every committed utterance from STT.
//
// Behaviour:
//   1. If the AI is currently speaking, this means the caller barged in.
//      Playback has already been aborted by the partial_transcript handler.
//      We buffer this utterance and wait for the current turn to drain.
//   2. Accumulate utterance fragments into pendingUtterance.
//   3. Decide end-of-turn: heuristic first, LLM fallback on ambiguous cases.
//      If incomplete, open a grace window (3s) waiting for more fragments.
//      Each new fragment resets the window.
//   4. Once complete, flush the accumulated text to the AI.
//   5. Multiple fragments that arrive while the AI is thinking/speaking are
//      queued; they are processed as a single coalesced utterance after the
//      AI finishes (or after a barge-in flushes them).
function handleCommittedUtterance(session, text) {
  session.pendingUtterance = (session.pendingUtterance || '');
  session.pendingUtterance = session.pendingUtterance
    ? `${session.pendingUtterance} ${text}`
    : text;
  session.pendingUtterance = session.pendingUtterance.replace(/\s+/g, ' ').trim();

  // If a grace window is already open, reset it; more fragments just arrived.
  if (session.pendingTimer) {
    clearTimeout(session.pendingTimer);
    session.pendingTimer = null;
  }

  // If the AI is busy (thinking or still speaking), just keep accumulating.
  // When the current turn finishes, the finisher will call flushPendingUtterance.
  if (session.turn !== 'idle') {
    log('info', 'openai', `buffering utterance while turn=${session.turn}: "${session.pendingUtterance}"`,
      { session_id: session.id });
    return;
  }

  decideAndMaybeFlush(session);
}

async function decideAndMaybeFlush(session) {
  const utter = (session.pendingUtterance || '').trim();
  if (!utter) return;

  // Fast local heuristic first.
  const h = looksComplete(utter);
  if (h === true) {
    return flushPendingUtterance(session);
  }
  if (h === false) {
    // Clearly incomplete — open a grace window and wait for more.
    log('info', 'openai', `utterance looks incomplete, waiting for continuation: "${utter}"`,
      { session_id: session.id });
    session.pendingTimer = setTimeout(() => {
      session.pendingTimer = null;
      // Timed out — even if it still looks incomplete, go with what we have.
      flushPendingUtterance(session);
    }, 3000);
    return;
  }

  // Ambiguous — ask the LLM.
  const complete = await isTurnComplete(session, utter);
  if (complete) {
    return flushPendingUtterance(session);
  }
  log('info', 'openai', `LLM says incomplete, waiting for continuation: "${utter}"`, { session_id: session.id });
  session.pendingTimer = setTimeout(() => {
    session.pendingTimer = null;
    flushPendingUtterance(session);
  }, 3000);
}

async function flushPendingUtterance(session) {
  const utter = (session.pendingUtterance || '').trim();
  if (!utter) return;
  if (session.turn !== 'idle') {
    // Something changed while we were deciding. Leave it buffered;
    // speakToCaller's finally block will retry the flush.
    return;
  }
  session.pendingUtterance = '';
  if (session.pendingTimer) { clearTimeout(session.pendingTimer); session.pendingTimer = null; }
  await runTurn(session, utter);
}

async function runTurn(session, userText) {
  if (session.turn !== 'idle') {
    log('warn', 'openai', `runTurn discarded — turn=${session.turn}`, { session_id: session.id });
    return;
  }
  session.turn = 'thinking';
  broadcast({ type: 'session', session: serializeSession(session) });

  const addedAt = new Date().toISOString();
  session.transcript.push({ speaker: 'caller', text: userText, ts: addedAt });
  broadcast({ type: 'transcript', call_id: session.id, entry: { speaker: 'caller', text: userText, ts: addedAt } });
  persistCall(session);

  try {
    // Identify car if not yet matched.
    session.history.push({ role: 'user', content: userText });
    if (!session.matchedCar) {
      const identified = await identifyCarFromTranscript(session);
      if (identified) {
        session.matchedCar = identified;
        broadcast({ type: 'session', session: serializeSession(session) });
      }
    }
    session.history.pop();

    const reply = await generateReply(session, userText);

    const ts = new Date().toISOString();
    session.transcript.push({ speaker: 'ai', text: reply, ts });
    broadcast({ type: 'transcript', call_id: session.id, entry: { speaker: 'ai', text: reply, ts } });
    persistCall(session);

    await speakToCaller(session, reply);
  } catch (e) {
    log('error', 'openai', `runTurn failed: ${e.message}`, { session_id: session.id });
  } finally {
    session.turn = 'idle';
    broadcast({ type: 'session', session: serializeSession(session) });

    // If fragments accumulated during this turn (barge-in, or utterances
    // committed while we were busy), process them now.
    if ((session.pendingUtterance || '').trim()) {
      // Give the caller a brief moment in case they're still mid-fragment.
      setTimeout(() => decideAndMaybeFlush(session), 100);
    }
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
    matched_car_id: carId(session.matchedCar),
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
//
// Uses the Realtime Scribe v2 WebSocket API:
//   wss://api.elevenlabs.io/v1/speech-to-text/realtime
// - Auth: xi-api-key header
// - Audio chunks: JSON { message_type: "input_audio_chunk", audio_base_64: "..." }
// - Responses: partial_transcript (interim) + committed_transcript (final)
// - VAD commit strategy with 0.6s silence threshold handles the 600ms endpointing
//   requirement natively; no manual debounce needed on the server side.
// ---------------------------------------------------------------------------
async function openElevenStream(session) {
  if (!ELEVEN_LABS_API_KEY) {
    log('error', 'elevenlabs', 'ELEVEN_LABS_API_KEY not configured', { session_id: session.id });
    return;
  }
  try {
    // VAD settings tuned for natural conversational pauses. The caller can
    // hesitate, take a breath, or think mid-sentence without the AI cutting in.
    // - vad_silence_threshold_secs=1.4: wait 1.4s of silence before committing
    //   (up from 0.6s). Gives the caller room to think between clauses.
    // - min_speech_duration_ms=250: ignore transient noise shorter than 250ms.
    // - min_silence_duration_ms=400: silence inside a phrase needs to be at
    //   least 400ms to count toward the commit threshold; shorter pauses
    //   (natural speech rhythm) don't reset anything.
    // - vad_threshold=0.5: slightly less sensitive than default 0.4 so
    //   background noise / line hiss doesn't count as speech.
    const qs = new URLSearchParams({
      model_id: 'scribe_v2_realtime',
      audio_format: 'pcm_16000',
      language_code: 'en',
      commit_strategy: 'vad',
      vad_silence_threshold_secs: '1.4',
      vad_threshold: '0.5',
      min_speech_duration_ms: '250',
      min_silence_duration_ms: '400',
    }).toString();

    const elevenWS = new WebSocket(
      `wss://api.elevenlabs.io/v1/speech-to-text/realtime?${qs}`,
      { headers: { 'xi-api-key': ELEVEN_LABS_API_KEY } }
    );

    session.elevenWS = elevenWS;
    session.sttReady = false;
    session.sttPending = []; // buffer of raw PCM Buffers until socket is open

    elevenWS.on('open', () => {
      log('info', 'elevenlabs', 'STT WebSocket opened', { session_id: session.id });
      session.sttReady = true;
      const queued = session.sttPending || [];
      session.sttPending = null;
      for (const pcm of queued) sendAudioChunkToEleven(session, pcm);
    });

    elevenWS.on('message', (msg, isBinary) => {
      if (isBinary) return;
      let data;
      try { data = JSON.parse(msg.toString()); }
      catch (e) {
        log('warn', 'elevenlabs', `non-JSON message from STT: ${e.message}`, { session_id: session.id });
        return;
      }

      switch (data.message_type) {
        case 'session_started':
          log('info', 'elevenlabs', `STT session_started id=${data.session_id}`, { session_id: session.id });
          break;

        case 'partial_transcript': {
          const text = (data.text || '').trim();
          if (!text) break;
          session.interim = text;
          broadcast({ type: 'interim', call_id: session.id, text });

          // Barge-in: if the AI is currently speaking and the caller starts
          // saying something substantive, stop the AI immediately so we don't
          // talk over each other. We wait for a meaningful partial (>=3 chars,
          // at least one real word) before aborting to avoid false triggers
          // from line hiss or faint residual echo.
          if (session.turn === 'speaking' && text.length >= 3 && /\b\w{2,}\b/.test(text)) {
            log('info', 'tts', `barge-in detected ("${text}") — aborting AI playback`, { session_id: session.id });
            session.playbackAborted = true;
          }
          break;
        }

        case 'committed_transcript':
        case 'committed_transcript_with_timestamps': {
          const text = (data.text || '').trim();
          session.interim = '';
          broadcast({ type: 'interim', call_id: session.id, text: '' });
          if (text.length < 2) break;
          log('info', 'elevenlabs', `committed: "${text}"`, { session_id: session.id });
          handleCommittedUtterance(session, text);
          break;
        }

        default:
          if (typeof data.message_type === 'string' && data.message_type.endsWith('_error')) {
            log('error', 'elevenlabs',
              `STT ${data.message_type}: ${data.message || data.error || JSON.stringify(data)}`,
              { session_id: session.id });
          } else {
            log('info', 'elevenlabs', `STT event ${data.message_type || 'unknown'}`, { session_id: session.id });
          }
      }
    });

    elevenWS.on('error', (e) => {
      log('error', 'elevenlabs', `STT WebSocket error: ${e.message}`, { session_id: session.id });
    });
    elevenWS.on('close', (code, reason) => {
      const reasonStr = reason ? reason.toString() : '';
      log('info', 'elevenlabs', `STT WebSocket closed code=${code}${reasonStr ? ' reason=' + reasonStr : ''}`,
        { session_id: session.id });
      session.sttReady = false;
      session.elevenWS = null;
    });
  } catch (e) {
    log('error', 'elevenlabs', `failed to open stream: ${e.message}`, { session_id: session.id });
  }
}

function sendAudioChunkToEleven(session, pcmBuffer) {
  const ws = session.elevenWS;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    const msg = JSON.stringify({
      message_type: 'input_audio_chunk',
      audio_base_64: pcmBuffer.toString('base64'),
    });
    ws.send(msg);
  } catch (e) {
    log('warn', 'elevenlabs', `audio chunk send failed: ${e.message}`, { session_id: session.id });
  }
}

function forwardAudioToEleven(session, frame) {
  if (!session.elevenWS) return;
  if (!session.sttReady) {
    if (session.sttPending) session.sttPending.push(frame);
    return;
  }
  sendAudioChunkToEleven(session, frame);
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
  const car = cars.find((c) => carId(c) === req.params.id);
  if (!car) return res.status(404).json({ error: 'not_found' });
  const cid = carId(car);
  const carLeads = leads.filter((l) => l.requested_car_id === cid);
  const carCalls = calls.filter((c) => c.matched_car_id === cid);
  res.json({ car, leads: carLeads, calls: carCalls });
});

app.get('/api/leads', (_req, res) => res.json(leads));
app.get('/api/leads/:id', (req, res) => {
  const lead = leads.find((l) => l.id === req.params.id);
  if (!lead) return res.status(404).json({ error: 'not_found' });
  const call = calls.find((c) => c.id === lead.call_id) || null;
  const car = lead.requested_car_id ? cars.find((c) => carId(c) === lead.requested_car_id) : null;
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
    sttReady: false,
    sttPending: [],
    transcript: [],
    history: [],
    matchedCar: null,
    interim: '',
    playbackAborted: false,
    finalized: false,
    pendingUtterance: '',
    pendingTimer: null,
  };
  sessions.set(callId, session);
  log('info', 'websocket', `Vonage WS connected from=${from} conv=${conversation_uuid}`, { session_id: callId });
  broadcast({ type: 'session', session: serializeSession(session) });
  persistCall(session);

  openElevenStream(session);

  // Speak the greeting via OpenAI TTS on the Vonage WebSocket. This uses the
  // same turn-taking machinery as any other AI utterance: the turn is
  // "speaking" during playback, barge-in aborts it, and the greeting is
  // recorded in the transcript + conversation history so the model knows
  // what it said.
  const GREETING = "Hello, thanks for calling. This is Honeybadger car dealership. How can I can help you?";
  ws.on('open', () => {}); // noop
  // The ws is already open by the time handleVonageWS is called (upgrade
  // handler completed). Fire the greeting on next tick so session setup
  // finishes first.
  setImmediate(async () => {
    if (session.turn !== 'idle') return;
    session.turn = 'speaking';
    broadcast({ type: 'session', session: serializeSession(session) });
    const ts = new Date().toISOString();
    session.transcript.push({ speaker: 'ai', text: GREETING, ts });
    session.history.push({ role: 'assistant', content: GREETING });
    broadcast({ type: 'transcript', call_id: session.id, entry: { speaker: 'ai', text: GREETING, ts } });
    persistCall(session);
    try {
      await speakToCaller(session, GREETING);
    } catch (e) {
      log('error', 'tts', `greeting failed: ${e.message}`, { session_id: session.id });
    } finally {
      session.turn = 'idle';
      broadcast({ type: 'session', session: serializeSession(session) });
      if ((session.pendingUtterance || '').trim()) {
        setTimeout(() => decideAndMaybeFlush(session), 100);
      }
    }
  });

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      // Forward audio to STT at all times so we can detect barge-in while
      // the AI is speaking. The TTS output does come back on this same
      // Vonage WebSocket as inbound echo, but the barge-in handler only
      // triggers on meaningful partials (>=3 chars with a real word), which
      // filters out most spurious echo. If echo feedback becomes a problem
      // in practice, we can re-introduce a selective gate here.
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
    if (session.pendingTimer) { clearTimeout(session.pendingTimer); session.pendingTimer = null; }
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
