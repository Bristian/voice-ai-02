# AI Car Dealer Phone Assistant

A production-ready real-time phone AI assistant for a car dealership. When the salesperson does not answer, the AI picks up, talks to the caller, figures out which car they are asking about, answers from a real inventory database, and logs a structured lead that the salesperson can review in a web dashboard.

**Stack:** Vonage Voice API · ElevenLabs Realtime STT · OpenAI `gpt-4o-mini` + `tts-1` · Node.js · Express · WebSockets · vanilla JS dashboard.

---

## What the app does

1. Vonage receives the inbound phone call and connects it to a WebSocket on the server (`/ws-audio`) as raw 16 kHz PCM audio.
2. Audio is forwarded to ElevenLabs' streaming speech-to-text.
3. After 600 ms of silence on a final transcript, the server calls OpenAI `gpt-4o-mini`, which returns both the spoken reply AND a `##CAR_CLUES##` sentinel used to match a vehicle in the inventory (a single merged API call per turn).
4. The reply is sent to OpenAI `tts-1` (PCM 24 kHz), resampled to 16 kHz in pure JS (`resample24to16()`), and streamed back to Vonage in 640-byte / 20 ms chunks at real-time pacing.
5. A strict `idle → thinking → speaking → idle` turn-taking state machine prevents concurrent TTS streams and blocks the Vonage echo feedback loop.
6. When the call ends, OpenAI extracts a structured lead (phone number, intent, appointment request, callback requested, questions asked, notes, etc.) and saves it to `leads.json`.
7. All of this is visible in real time in the dashboard via Server-Sent Events: Leads Inbox · Inventory · Live Calls · Logs.

---

## File layout

```
├── server.js            Main Node.js application
├── cars.json            50 pre-loaded vehicles
├── calls.json           Call records (auto-written)
├── leads.json           Extracted leads (auto-written)
├── package.json
├── .env.example
├── public/
│   ├── index.html       Dashboard
│   ├── app.js           Dashboard JavaScript
│   └── styles.css       Dashboard styles
└── README.md
```

---

## Running locally

```bash
npm install
cp .env.example .env   # fill in real keys
npm start
```

Open http://localhost:3000 to see the dashboard.

> Local testing of inbound phone calls requires exposing your server to the public internet (e.g. `ngrok http 3000`) and pointing your Vonage number at the tunnel URL. The Railway deployment below is the recommended path.

---

## Environment variables

| Variable | Meaning |
|---|---|
| `PORT` | HTTP port to listen on. Railway sets this automatically. |
| `BASE_URL` | Public HTTPS URL of the deployed app (e.g. `https://your-app.up.railway.app`). Used to build the `wss://…/ws-audio` URL returned in the Vonage NCCO. |
| `VONAGE_API_KEY` | Vonage API key. |
| `VONAGE_API_SECRET` | Vonage API secret. |
| `VONAGE_APPLICATION_ID` | Vonage application ID (the application that owns your voice number). |
| `VONAGE_PRIVATE_KEY` | Contents of the Vonage application private key. |
| `ELEVEN_LABS_API_KEY` | ElevenLabs API key (with Scribe / STT access). |
| `OPENAI_API_KEY` | OpenAI API key. |

---

## Railway deployment guide

### 1. Create a Railway project
- Go to https://railway.app → **New Project** → **Deploy from GitHub repo** (or **Empty Project** + upload).

### 2. Connect the repo / upload files
- Push this folder to a GitHub repo and link it, or drag-and-drop the files into a new Railway service.
- Railway auto-detects the Node.js app via `package.json`. The start command is `npm start`.

### 3. Add environment variables
In your service's **Variables** tab, add every key listed in the table above. Notes:
- `PORT` is set automatically by Railway — no need to define it yourself.
- `BASE_URL` must be the HTTPS public URL Railway gives your service (see step 5).
- `VONAGE_PRIVATE_KEY` should be the full PEM contents, including `-----BEGIN PRIVATE KEY-----` and newlines. In Railway, paste the multi-line value directly.

### 4. Deploy the app
Railway builds on every push. Watch the **Deploy Logs** tab to confirm:
```
Server listening on port 3000 — BASE_URL=https://your-app.up.railway.app
```

### 5. Get the public domain
In the **Settings** tab of your service, click **Generate Domain**. You'll get something like:
```
https://your-app.up.railway.app
```
Update the `BASE_URL` variable to this value and redeploy.

### 6. Configure your Vonage number

In the Vonage dashboard → **Applications** → your application:

- **Answer URL:** `https://your-app.up.railway.app/api/vonage/answer` · Method `POST`
- **Event URL:** `https://your-app.up.railway.app/api/vonage/events` · Method `POST`
- Ensure the application is linked to the voice-enabled phone number you want to receive calls on.

The WebSocket URL used internally by Vonage (you don't configure this directly — the server returns it in the NCCO) will be:
```
wss://your-app.up.railway.app/ws-audio
```

### 7. Test the full flow
1. Call your Vonage number.
2. Wait for the greeting, then say something like:
   *"Hi, I'm interested in the red Audi A4 that costs twenty thousand. Registration DEP34D. Is it still available? Any damages? Can I pass by on Monday? Please call me back on 0725871112."*
3. You should hear the AI answer using facts from `cars.json` (the first entry is exactly this car, by design).
4. Open `https://your-app.up.railway.app/` — the dashboard.
5. **Live Calls** shows the conversation in real time with live transcription and a turn indicator.
6. When you hang up, a new lead appears in the **Leads Inbox** with the matched car, phone number, appointment request, callback flag, and full transcript.
7. Open the **Inventory** tab → click the Audi A4 → you'll see this enquiry listed against the car, ready for the salesperson's callback.
8. **Logs** shows verbose, copy-ready diagnostics across `webhook`, `websocket`, `elevenlabs`, `openai`, `tts`, `extraction`, `inventory`, `storage`, `errors`.

---

## Dashboard pages

- **Leads Inbox** — every captured enquiry with intent, callback flag, appointment request, unread indicator, and full transcript on click.
- **Inventory** — all 50 cars, filterable by brand/model/registration/availability. Each car detail page lists every historical enquiry linked to that vehicle — critical for salesperson callback preparation.
- **Live Calls** — any call currently in progress, with the live transcript (interim + final), the currently matched car, and the turn state (`idle` / `thinking` / `speaking`).
- **Logs** — streaming log view. Filter by level or source. "Copy visible" copies the filtered lines to clipboard.

---

## Reliability

The server handles and logs (without crashing):

- no car match, multiple weak matches
- invalid / missing phone numbers
- WebSocket disconnects from Vonage
- ElevenLabs stream errors and closes
- OpenAI errors (both reply generation and extraction)
- TTS failures
- caller hangs up mid-reply (playback is aborted, lead is still saved)
- duplicate / late Vonage webhooks

A global `uncaughtException` / `unhandledRejection` handler logs every unexpected error to the `errors` source in the dashboard.
