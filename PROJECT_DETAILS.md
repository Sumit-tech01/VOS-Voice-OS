# VOS Voice OS - Project Details

## Overview
VOS Voice OS is a production-style realtime voice assistant web application built with a vanilla web frontend and a Node.js backend. The system is designed around a voice-first interaction model and supports speech-to-text, intent routing, per-session memory, AI response generation through Ollama, text-to-speech generation through Murf, realtime WebSocket events, and a futuristic Jarvis-inspired UI.

Core pipeline:

```text
Mic -> Web Speech API -> Router -> Memory -> AI (Ollama) -> Murf -> Audio -> UI -> WebSocket events
```

The project is structured for hackathon delivery while still following modular backend service boundaries so it can be extended into a more production-hardened application.

## Product Capabilities
- Voice-first user interaction through the browser microphone
- Speech recognition using the Web Speech API
- Intent detection for commands vs general conversation
- Conversation memory persisted per session
- AI modes:
  - `assistant`
  - `tutor`
  - `translator`
  - `customer-support`
- Language support:
  - `en`
  - `hi`
  - `es`
  - `fr`
  - `de`
  - `ja`
- Murf text-to-speech voice generation
- Realtime REST + WebSocket orchestration
- Session persistence across refresh using `localStorage`
- Keyboard fallback input when speech is unavailable
- Debug mode with deep tracing across the stack

## Technology Stack

### Backend
- Node.js
- Express 4
- ws
- axios
- dotenv
- express-rate-limit

### Frontend
- HTML5
- CSS3
- Vanilla JavaScript
- Web Speech API for browser speech recognition
- HTML audio element for playback

### AI and Voice
- Ollama local inference endpoint: `POST /api/generate`
- Default Ollama model: `llama3:latest`
- Murf TTS endpoint: `https://api.murf.ai/v1/speech/generate`
- Murf model flow: try `FALCON`, fallback to `GEN2`

## Repository Structure

```text
/
  .env
  .env.example
  package.json
  package-lock.json
  server.js
  PROJECT_DETAILS.md
  routes/
    voice.js
  services/
    ai.js
    commandRouter.js
    intent.js
    memory.js
    murf.js
  public/
    index.html
    script.js
    style.css
    fonts/
      orbitron-latin-500-700.woff2
      rajdhani-*.woff2
    generated/
      .gitkeep
  data/
    memory/
      .gitkeep
  tests/
    ai.test.js
    commandRouter.test.js
    intent.test.js
    memory.test.js
    murf.test.js
    server.test.js
    voice.test.js
```

## Runtime Architecture

### 1. Server Bootstrap
`server.js` is the application entry point and is responsible for:
- loading environment variables with `dotenv`
- validating critical env vars
- creating runtime directories
- running startup cleanup for old generated audio and memory files
- running optional startup diagnostics in debug mode
- creating the Express app
- creating the WebSocket server
- wiring all services together

### 2. Voice Route Layer
`routes/voice.js` provides the main voice API and implements a strict sequential request flow:

```text
receive request -> await router -> await ai -> await murf -> send response
```

This route also emits best-effort WebSocket events without allowing WebSocket failures to block REST responses.

### 3. Service Layer

#### `services/ai.js`
- builds mode-aware prompts
- includes recent conversation history
- calls Ollama using axios
- always returns a string
- returns a user-friendly fallback message on failure

#### `services/commandRouter.js`
- handles deterministic commands before AI
- updates memory
- can trigger voice playback generation for command replies
- always returns a stable object shape including `text`, `mode`, and `language`

#### `services/intent.js`
- lightweight intent detection
- detects:
  - help
  - clear memory
  - repeat
  - stop audio
  - mode switch
  - language switch
  - target language switch

#### `services/memory.js`
- persists session JSON files under `data/memory/<sessionId>.json`
- stores the active mode, language, target language, history, and last reply
- keeps only the last 16 messages
- uses per-session locks to avoid file write races

#### `services/murf.js`
- validates input text
- resolves Murf voice based on language
- sends Murf TTS request
- retries from `FALCON` to `GEN2` if needed
- caches audio per session
- stores audio in `public/generated/<sessionId>/`
- returns browser-playable relative URLs
- cleans up old generated audio files

### 4. Frontend Runtime
`public/script.js` handles:
- browser session creation and persistence
- microphone control
- Web Speech API recognition
- REST request orchestration
- WebSocket connection and event handling
- audio playback
- UI sync and telemetry updates
- fallback to REST if realtime events are delayed

## Authentication and Security Model

### REST Auth
All `/api/voice` routes are protected by bearer token auth unless `NODE_ENV === "test"`.

Expected header:

```http
Authorization: Bearer <API_SECRET>
```

### Rate Limiting
`/api/voice` is protected by IP rate limiting:
- 20 requests per IP
- 1 minute window

On breach, the API returns:

```json
{
  "error": "Too many requests",
  "retryAfter": 60
}
```

### WebSocket Protection
WebSocket upgrades at `/ws` are allowed when:
- the request is from localhost, or
- the request includes `?token=<API_SECRET>`

Unauthorized upgrades are rejected before a session is attached.

### Security Headers
The app sets:
- `Content-Security-Policy`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: no-referrer`
- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Resource-Policy: same-origin`

### Local Font Hosting
The UI uses self-hosted font files from `public/fonts/` to avoid third-party font requests.

## Environment Variables

Documented in `.env.example`:

```env
PORT=3000
DEBUG=false
API_SECRET=your-secret-here
AI_PROVIDER=ollama

OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=llama3:latest
OLLAMA_TIMEOUT_MS=30000
OLLAMA_MAX_TOKENS=72

OPENAI_API_KEY=your_openai_api_key_here
OPENAI_MODEL=gpt-4.1-mini

MURF_API_KEY=your_murf_api_key_here
MURF_API_URL=https://api.murf.ai/v1/speech/generate
MURF_TIMEOUT_MS=8000
MURF_LOW_LATENCY_TIMEOUT_MS=5000

MURF_DEFAULT_VOICE_EN=en-US-natalie
MURF_DEFAULT_VOICE_HI=hi-IN-khyati
MURF_DEFAULT_VOICE_ES=es-ES-carla
MURF_DEFAULT_VOICE_FR=fr-FR-axel
MURF_DEFAULT_VOICE_DE=de-DE-lia
MURF_DEFAULT_VOICE_JA=ja-JP-kenji
```

### Required for Core Operation
- `PORT`
- `DEBUG`
- `API_SECRET`
- `MURF_API_KEY`
- `MURF_API_URL`
- `AI_PROVIDER`
- `OLLAMA_BASE_URL`
- `OLLAMA_MODEL`

## Session Model

Each browser session gets a generated `sessionId` stored in `localStorage`.

The backend persists session state at:

```text
data/memory/<sessionId>.json
```

Session shape:

```json
{
  "createdAt": "2026-03-15T10:00:00.000Z",
  "history": [
    {
      "id": "uuid",
      "intent": "conversation",
      "language": "en",
      "mode": "assistant",
      "provider": "ollama",
      "role": "user",
      "source": "voice",
      "text": "Hello",
      "timestamp": "2026-03-15T10:00:00.000Z"
    }
  ],
  "language": "en",
  "lastAssistantResponse": "Hello, how can I help?",
  "lastAudioUrl": "/generated/session-id/voice_123.mp3",
  "lastReply": "Hello, how can I help?",
  "mode": "assistant",
  "sessionId": "session-id",
  "targetLanguage": "hi",
  "timestamp": "2026-03-15T10:00:10.000Z",
  "updatedAt": "2026-03-15T10:00:10.000Z"
}
```

## AI Mode Behavior

### Assistant
System prompt:

```text
You are a helpful AI assistant.
```

Behavior:
- short, practical help
- answers in the currently selected language

### Tutor
System prompt:

```text
You are a teacher. Explain clearly.
```

Behavior:
- simpler explanations
- spoken-answer friendly

### Translator
System prompt:

```text
You translate text only.
```

Behavior:
- translates from input language to target language
- returns only translated text

### Customer Support
System prompt:

```text
You are a polite support agent. Answer short.
```

Behavior:
- short, calm support-style answers

## Language and Voice Mapping

Supported language codes:
- `en`
- `hi`
- `es`
- `fr`
- `de`
- `ja`

Murf voice defaults:
- `en` -> `en-US-natalie`
- `hi` -> `hi-IN-khyati`
- `es` -> `es-ES-carla`
- `fr` -> `fr-FR-axel`
- `de` -> `de-DE-lia`
- `ja` -> `ja-JP-kenji`

Speech recognition locales:
- `en` -> `en-US`
- `hi` -> `hi-IN`
- `es` -> `es-ES`
- `fr` -> `fr-FR`
- `de` -> `de-DE`
- `ja` -> `ja-JP`

## Supported Commands

The command router supports:
- `switch to assistant`
- `switch to tutor`
- `switch to translator`
- `switch to support`
- `change language to english`
- `change language to hindi`
- `change language to spanish`
- `change language to french`
- `change language to german`
- `change language to japanese`
- `clear memory`
- `repeat`
- `stop audio`
- `help`

Demo quick actions visible in the UI:
- `what is your name`
- `who made you`
- `explain ai`
- `tell joke`
- `translate hello to hindi`
- `switch to tutor`
- `clear memory`
- `repeat`
- `stop audio`
- `help`

## REST API

### `GET /health`
Returns server health.

Response:

```json
{
  "status": "ok",
  "timestamp": "2026-03-15T10:00:00.000Z"
}
```

### `GET /test`
Local/debug Murf smoke test route.

Response:

```json
{
  "audioUrl": "/generated/test-murf/voice_123.mp3"
}
```

### `POST /test-voice`
Local/debug Murf custom text test route.

Request:

```json
{
  "text": "hello",
  "sessionId": "123",
  "language": "en",
  "voiceId": "en-US-natalie",
  "lowLatency": true
}
```

### `GET /api/voice/state?sessionId=<id>`
Returns the persisted session state plus supported modes/languages.

### `POST /api/voice/preferences`
Updates session preferences.

Request:

```json
{
  "sessionId": "abc",
  "mode": "tutor",
  "language": "en",
  "targetLanguage": "hi"
}
```

### `POST /api/voice/clear`
Clears session memory and returns the new empty session.

### `POST /api/voice/message`
Main voice/chat turn endpoint.

Request:

```json
{
  "sessionId": "abc",
  "turnId": "uuid",
  "text": "Explain AI simply",
  "mode": "tutor",
  "language": "en",
  "targetLanguage": "hi",
  "source": "voice"
}
```

Typical response:

```json
{
  "audioUrl": "/generated/abc/voice_123.mp3",
  "detectedIntent": "conversation",
  "history": [
    { "role": "user", "text": "Explain AI simply" }
  ],
  "language": "en",
  "latencyMs": 1450,
  "mode": "tutor",
  "provider": "ollama",
  "replyText": "AI is a system that learns patterns and helps solve tasks.",
  "session": {},
  "sessionMeta": {},
  "sessionId": "abc",
  "supportedLanguages": [],
  "supportedModes": [],
  "targetLanguage": "hi",
  "text": "AI is a system that learns patterns and helps solve tasks.",
  "turnId": "uuid",
  "userText": "Explain AI simply",
  "warning": null
}
```

## WebSocket API

Endpoint:

```text
/ws?sessionId=<id>&token=<API_SECRET>
```

For localhost development, `token` is optional.

### Outbound Events
- `session:ready`
- `assistant:thinking`
- `assistant:text`
- `assistant:audio`
- `assistant:warning`
- `mode:changed`
- `memory:cleared`
- `session:updated`
- `error`

### Event Ordering
The backend preserves this order for a normal AI turn:

```text
assistant:thinking -> assistant:text -> assistant:audio
```

For command-driven turns, only the relevant events are sent.

## Frontend Behavior

### Session Persistence
- browser generates `sessionId` with `crypto.randomUUID()`
- stores it in `localStorage`
- reuses it after page refresh

### Request Handling
- speech recognition final result triggers `POST /api/voice/message`
- keyboard form can submit silent turns
- if WebSocket events are delayed, REST response still updates the UI
- audio plays automatically when `audioUrl` exists

### Strict Sync-Safe Mode
The frontend uses turn IDs to prevent stale websocket messages from earlier turns from overwriting the current UI state.

## Debug and Observability

When `DEBUG=true`, the app logs:
- env configuration summary
- startup diagnostics
- router stages
- memory reads/writes
- AI prompt flow
- Murf request/response details
- WebSocket lifecycle
- frontend request/audio/error flow

Important backend stage logs:
- `STEP 1 request`
- `STEP 2 router`
- `STEP 3 ai`
- `STEP 4 murf`
- `STEP 5 response`

## Startup Lifecycle
On startup the server:
1. loads `.env`
2. validates key env vars
3. creates `public/generated` and `data/memory`
4. deletes stale audio and memory files older than 1 hour
5. optionally probes Ollama in debug mode
6. starts Express
7. starts WebSocket upgrade handling
8. serves the frontend and generated audio

## Error Handling Strategy

### AI
- AI call timeout: controlled by `OLLAMA_TIMEOUT_MS` and currently set to 30 seconds in `.env`
- always returns a string
- returns a user-friendly recovery message if Ollama fails

### Murf
- Murf call timeouts are bounded
- `generateVoice()` always resolves
- returns a relative URL on success
- returns `null` on failure

### Router
- command router always returns an object
- stable shape includes `text`, `mode`, and `language`

### Memory
- missing or corrupted memory files do not crash the app
- session is rebuilt safely if needed

### Voice Route
- top-level route handler is wrapped in `try/catch`
- returns `"System error"` response shape instead of hanging

## Testing

Test suite covers:
- AI prompt generation and fallback behavior
- command routing
- intent detection
- memory persistence and limits
- Murf request handling and fallback behavior
- server startup behavior
- voice route sequencing and websocket event ordering

Run tests:

```bash
npm test
```

## Local Development

### Prerequisites
- Node.js
- Ollama installed and running
- Murf API key

### Install

```bash
npm install
```

### Run Ollama

```bash
ollama serve
```

### Start Server

```bash
node server.js
```

### Open App

```text
http://localhost:3000/
```

### Useful Debug Endpoints
- `GET /health`
- `GET /test`
- `POST /test-voice`

## Operational Notes
- Generated audio files are written to `public/generated/<sessionId>/`
- Session JSON files are written to `data/memory/`
- Old audio and memory files are cleaned up automatically
- The app is single-process and file-backed, which is fine for local demos and hackathons
- For horizontal scaling, memory should move to Redis or a database

## Known Tradeoffs
- Web Speech API availability depends on browser support
- Ollama latency depends on the local machine and loaded model
- File-based memory is durable enough for single-instance use, not clustered deployments
- Murf availability and Falcon access depend on Murf account permissions

## Suggested Next Upgrades
- add user accounts and per-user secrets instead of one shared API secret
- move session memory to Redis or Postgres
- add browser E2E tests for microphone and playback flows
- add structured logging output for production deployments
- add streaming AI responses when the model backend supports them

## Quick Reference

### Primary Files
- `server.js` - app bootstrap, security, routes, websocket server
- `routes/voice.js` - main voice request orchestration
- `services/ai.js` - Ollama integration
- `services/murf.js` - Murf TTS integration
- `services/memory.js` - session persistence
- `services/commandRouter.js` - command handling
- `services/intent.js` - intent detection
- `public/script.js` - browser runtime
- `public/index.html` - UI shell
- `public/style.css` - futuristic UI styling

### Main Promise of the System
The system is designed to always settle a user turn:
- never wait forever
- never intentionally return `undefined`
- keep REST authoritative
- keep WebSocket realtime but non-blocking
- preserve session context between turns
