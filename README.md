# Lecture Studio

**Lecture Studio** is a web app for accessible, document-grounded teaching: professors record a session, upload and annotate a PDF, publish a package, and students open the same slides with **Gemini Live** for voice (or ASL-based text) Q&A tied to the lecture and annotations.

## Features

- **Landing & theme** — Marketing hero, features section, light/dark mode (persisted in the browser).
- **Professor workspace** — Start/stop lecture recording, ElevenLabs transcription, PDF upload, pen/highlighter/eraser tools, publish to the shared session context.
- **Student workspace** — PDF viewer with annotations, Gemini Live session (voice), optional ASL camera path with spelled text sent to the model, session transcript panel.
- **Backend proxy** — Express server for transcription, context storage, lecture post-processing (optional local **Ollama** for enrichment), WebSocket bridge for Gemini Live, and token minting for Live API.

## Tech stack

| Layer | Technology |
|--------|------------|
| UI | React 18, Vite 5, Tailwind CSS |
| PDF | pdf.js |
| Live AI | `@google/genai` (Gemini Live in the browser) |
| Speech | ElevenLabs (transcription / TTS as configured in `server/proxy.js`) |
| ASL demo | MediaPipe hand landmarks, TensorFlow.js templates |
| Server | Node.js, Express, `ws`, Axios |

## Prerequisites

- **Node.js** 18+ recommended  
- **npm**  
- API keys as described below (at minimum **Gemini** and **ElevenLabs** for full flows)  
- Optional: **Ollama** running locally if you want lecture enrichment (lecture memory / chapters) after publish

## Quick start

```bash
git clone <your-fork-or-repo-url>
cd Project_Ed-Assist
npm install
```

Copy environment template and fill in secrets:

```bash
cp .env.example .env
```

Edit `.env` (see [Environment variables](#environment-variables)).

```bash
npm run dev
```

- **App (Vite):** [http://localhost:5173](http://localhost:5173)  
- **API (Express):** [http://localhost:5173/api/...](http://localhost:5173/api/...) — proxied to port **3001** by Vite during development

## Environment variables

Create a `.env` file in the project root (never commit real keys). Reference `.env.example` for the full list.

| Variable | Purpose |
|----------|---------|
| `GEMINI_API_KEY` | Server-side Gemini API key; used for token minting (`POST /api/gemini-live/token`) and server features. **Recommended** for Live: avoids browser referrer issues with API key restrictions. |
| `ELEVENLABS_API_KEY` | Transcription, voice features, TTS as wired in the proxy. |
| `ELEVENLABS_VOICE_ID` | Default voice id for TTS when applicable. |
| `PORT` | Express listen port (default `3001`). |
| `OLLAMA_URL` | Local Ollama base URL (default `http://localhost:11434`). |
| `OLLAMA_MODEL` | Model tag for post-publish enrichment (e.g. `gemma4:e4b`). |
| `OLLAMA_TIMEOUT_MS` / `OLLAMA_LECTURE_MEMORY_TIMEOUT_MS` | Optional HTTP timeouts for slow local models. |
| `VITE_GOOGLE_API_KEY` | Optional browser-embedded key (not required if using server-minted Live tokens). |
| `VITE_GEMINI_LIVE_MODEL` | Optional override for the Live model name in the client. |

**Tip:** For local dev, leave `VITE_API_URL` unset so the browser calls `/api/...` on the same origin as Vite and the proxy forwards to Express.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Runs `server/proxy.js` and Vite (port 5173) together. |
| `npm run build` | Production build of the React app to `dist/`. |
| `npm start` | Runs only the Express server (expects built assets or your deployment setup). |
| `npm run test:e2e` | Smoke script (`scripts/e2e-smoke.mjs`) if configured for your environment. |

## How it fits together

1. **Landing** — Choose **Get Started** (professor) or **View demo** (student).  
2. **Professor** — Audio is transcribed via the proxy; PDF + annotations are sent when processing the lecture.  
3. **Student** — Loads context from `/api/context`, connects Gemini Live (after optional `preparePlayback` / token flow), and chats with grounding from transcript, document index, and annotations.  
4. **Optional Ollama** — After publish, the server may run background jobs (e.g. structured memory, chapters). If Ollama is offline or slow, publishing can still succeed while enrichment stays pending or errors gracefully.

## Gemini Live and API keys

Browser WebSocket connections to Google may send an empty `Referer`, so API keys restricted by **HTTP referrers** in Google AI Studio can fail for Live. This project uses **server-minted auth tokens** (`POST /api/gemini-live/token`) when `GEMINI_API_KEY` is set on the server, which avoids that class of failure for local development.

## Troubleshooting

| Issue | What to try |
|-------|-------------|
| Student PDF / context fails to load | Ensure Vite proxy is used (`/api` on port 5173) or CORS allows your origin; confirm `npm run dev` is running both processes. |
| Live session won’t connect | Verify `GEMINI_API_KEY` in `.env`, restart the server, check browser console and `/api/health`. |
| Transcription errors | Check `ELEVENLABS_API_KEY` and account limits. |
| Ollama timeouts or slow enrichment | Use a smaller/faster `OLLAMA_MODEL`, increase timeouts in `.env`, or ensure GPU/CPU is not overloaded. |

## Project layout (high level)

```
├── server/proxy.js    # Express API, WebSockets, transcription, context, Ollama hooks
├── src/               # React app (pages, components, hooks, context)
├── public/            # Static assets (e.g. ASL calibration data)
├── scripts/           # Utility scripts (e.g. e2e smoke)
└── .env.example       # Environment template
```

## License

Use and modify according to your repository’s license (add a `LICENSE` file if you distribute this project).
