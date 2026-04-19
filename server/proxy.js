import 'dotenv/config'
import express from 'express'
import multer from 'multer'
import axios from 'axios'
import FormData from 'form-data'
import fs from 'fs'
import http from 'http'
import path from 'path'
import { execFile } from 'child_process'
import { fileURLToPath } from 'url'
import { WebSocketServer, WebSocket } from 'ws'

const DEBUG = process.env.DEBUG === 'true'
const log = (...args) => DEBUG && console.log(...args)

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const app = express()
const uploadDir = path.join(__dirname, '../uploads')
const upload = multer({ dest: uploadDir })

const PORT = process.env.PORT || 3001
const GEMINI_API_KEY = process.env.GEMINI_API_KEY
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY
const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/+$/, '')
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'gemma3:4b'
/** Default HTTP timeout for Ollama /api/chat (chapter detection, short calls). */
const OLLAMA_TIMEOUT_MS = Math.max(10000, Number(process.env.OLLAMA_TIMEOUT_MS) || 120000)
/**
 * Lecture memory sends a large prompt + JSON response; local models often need several minutes on CPU.
 * Defaults to 10 minutes; set OLLAMA_LECTURE_MEMORY_TIMEOUT_MS to override (milliseconds).
 */
const OLLAMA_LECTURE_MEMORY_TIMEOUT_MS = Math.max(
  OLLAMA_TIMEOUT_MS,
  Number(process.env.OLLAMA_LECTURE_MEMORY_TIMEOUT_MS) || 600000,
)
const OLLAMA_LECTURE_MEMORY_RETRIES = Math.max(1, Number(process.env.OLLAMA_LECTURE_MEMORY_RETRIES) || 2)
const OLLAMA_CHAPTER_TRANSCRIPT_CHARS = Math.max(2000, Number(process.env.OLLAMA_CHAPTER_TRANSCRIPT_CHARS) || 12000)
const OLLAMA_MOMENT_TRANSCRIPT_CHARS = Math.max(120, Number(process.env.OLLAMA_MOMENT_TRANSCRIPT_CHARS) || 320)
const OLLAMA_ANNOTATION_CHARS = Math.max(120, Number(process.env.OLLAMA_ANNOTATION_CHARS) || 240)
const OLLAMA_NEARBY_TEXT_ITEMS = Math.max(2, Number(process.env.OLLAMA_NEARBY_TEXT_ITEMS) || 4)
const SERVER_STARTED_AT = new Date().toISOString()
const SERVER_PID = process.pid
const GEMINI_LIVE_WS_URL =
  `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`

fs.mkdirSync(uploadDir, { recursive: true })

/** Allow browser dev (e.g. Vite on :5173) to call API on :3001 when using absolute VITE_API_URL */
app.use((req, res, next) => {
  const origin = req.headers.origin
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Credentials', 'true')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || 'Content-Type')
  if (req.method === 'OPTIONS') {
    res.sendStatus(204)
    return
  }
  next()
})

app.use(express.json({ limit: '100mb' }))
app.use(express.urlencoded({ extended: true, limit: '100mb' }))

function createRuntimeStatus({
  voiceId = process.env.ELEVENLABS_VOICE_ID || '',
  lectureMemoryMode = 'idle',
  lectureMemoryError = '',
  chapterDetectionMode = 'idle',
  chapterDetectionError = '',
  postProcessState = 'idle',
  warnings = [],
} = {}) {
  return {
    elevenLabsConfigured: Boolean(ELEVENLABS_API_KEY?.trim()),
    geminiConfigured: Boolean(GEMINI_API_KEY?.trim()),
    ollamaConfigured: Boolean(OLLAMA_URL && OLLAMA_MODEL),
    voiceConfigured: Boolean(String(voiceId || '').trim()),
    liveTextReady: Boolean(GEMINI_API_KEY?.trim()),
    liveVoiceReady: Boolean(GEMINI_API_KEY?.trim() && ELEVENLABS_API_KEY?.trim() && String(voiceId || '').trim()),
    lecturePublishReady: Boolean(ELEVENLABS_API_KEY?.trim()),
    ollamaUrl: OLLAMA_URL,
    ollamaModel: OLLAMA_MODEL,
    lectureMemoryMode,
    lectureMemoryError,
    chapterDetectionMode,
    chapterDetectionError,
    postProcessState,
    serverStartedAt: SERVER_STARTED_AT,
    serverPid: SERVER_PID,
    warnings: [...new Set((Array.isArray(warnings) ? warnings : []).filter(Boolean).map(String))],
  }
}

function createEmptySessionContext() {
  return {
    transcript: '',
    transcriptSegments: [],
    handwrittenNotesText: '',
    typedNotes: '',
    pdfBase64: null,
    pdfMimeType: 'application/pdf',
    chapters: [],
    voiceId: process.env.ELEVENLABS_VOICE_ID || '',
    annotationEvents: [],
    annotatedDocument: null,
    lectureMemory: [],
    lectureStatus: 'idle',
    documentName: '',
    publishedAt: null,
    contextVersion: 0,
    liveGroundingVersion: 0,
    updatedAt: null,
    runtimeStatus: createRuntimeStatus(),
  }
}

let sessionContext = createEmptySessionContext()
let latestLectureJobToken = 0

function refreshSessionMetadata({
  lectureMemoryMode = sessionContext.runtimeStatus?.lectureMemoryMode || 'idle',
  lectureMemoryError = sessionContext.runtimeStatus?.lectureMemoryError || '',
  chapterDetectionMode = sessionContext.runtimeStatus?.chapterDetectionMode || 'idle',
  chapterDetectionError = sessionContext.runtimeStatus?.chapterDetectionError || '',
  postProcessState = sessionContext.runtimeStatus?.postProcessState || 'idle',
  warnings = sessionContext.runtimeStatus?.warnings || [],
  groundingChanged = false,
} = {}) {
  sessionContext.contextVersion = Math.max(0, Number(sessionContext.contextVersion) || 0) + 1
  if (groundingChanged) {
    sessionContext.liveGroundingVersion = Math.max(0, Number(sessionContext.liveGroundingVersion) || 0) + 1
  }
  sessionContext.updatedAt = new Date().toISOString()
  sessionContext.runtimeStatus = createRuntimeStatus({
    voiceId: sessionContext.voiceId,
    lectureMemoryMode,
    lectureMemoryError,
    chapterDetectionMode,
    chapterDetectionError,
    postProcessState,
    warnings,
  })
}

function cleanupUpload(file) {
  if (file?.path) {
    fs.promises.unlink(file.path).catch(() => {})
  }
}

/** Readable message for the UI when ElevenLabs (or similar) returns an axios error */
function messageFromUpstream(error) {
  const data = error.response?.data
  const status = error.response?.status
  const detail = data?.detail
  if (typeof detail === 'string') return detail
  if (detail?.status === 'invalid_api_key' || detail?.message?.toLowerCase?.().includes('invalid api key')) {
    return 'Invalid ElevenLabs API key. In ElevenLabs → Profile → API keys, create a key and set ELEVENLABS_API_KEY in .env, then restart npm run dev.'
  }
  if (detail?.message) return detail.message
  if (status === 401) {
    return 'ElevenLabs rejected the API key (401). Update ELEVENLABS_API_KEY in .env and restart the server.'
  }
  if (status === 403) {
    return 'ElevenLabs denied this request (403). Speech-to-Text may require a paid plan — check your ElevenLabs subscription.'
  }
  if (status === 429) {
    return 'ElevenLabs rate limit reached. Wait a minute and try again.'
  }
  return error.message || 'Upstream request failed.'
}

/**
 * Local Gemma via Ollama. Run `ollama serve` (auto-started by `ollama run ...`) and
 * `ollama pull <OLLAMA_MODEL>` so the model is available. Returns the raw assistant
 * text content. When `json: true`, asks Ollama to constrain output to valid JSON.
 */
async function callOllama(prompt, { json = false, system = '', temperature = 0.2, timeout } = {}) {
  const messages = []
  if (system) messages.push({ role: 'system', content: system })
  messages.push({ role: 'user', content: prompt })

  const body = {
    model: OLLAMA_MODEL,
    messages,
    stream: false,
    options: { temperature },
  }
  if (json) body.format = 'json'

  const ms = typeof timeout === 'number' && timeout > 0 ? timeout : OLLAMA_TIMEOUT_MS

  const response = await axios.post(`${OLLAMA_URL}/api/chat`, body, {
    headers: { 'Content-Type': 'application/json' },
    timeout: ms,
  })
  return String(response.data?.message?.content || '').trim()
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function clipText(value, maxChars) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (!text || text.length <= maxChars) return text
  return `${text.slice(0, Math.max(1, maxChars - 1)).trim()}…`
}

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout
        error.stderr = stderr
        reject(error)
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

async function findListeningPidsOnPort(port) {
  if (process.platform === 'win32') {
    const { stdout } = await execFileAsync('cmd.exe', ['/c', 'netstat -ano -p tcp'])
    return [...new Set(
      stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => line.split(/\s+/))
        .filter((parts) => parts.length >= 5)
        .filter((parts) => parts[0].toUpperCase() === 'TCP')
        .filter((parts) => parts[1].endsWith(`:${port}`))
        .filter((parts) => parts[3]?.toUpperCase() === 'LISTENING')
        .map((parts) => Number(parts[4]))
        .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== SERVER_PID),
    )]
  }

  try {
    const { stdout } = await execFileAsync('sh', ['-lc', `lsof -ti tcp:${port}`])
    return [...new Set(
      stdout
        .split(/\r?\n/)
        .map((value) => Number(value.trim()))
        .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== SERVER_PID),
    )]
  } catch (error) {
    if (error.code === 1 && !String(error.stdout || '').trim()) {
      return []
    }
    throw error
  }
}

async function terminatePid(pid) {
  if (!pid || pid === SERVER_PID) return
  if (process.platform === 'win32') {
    await execFileAsync('taskkill', ['/PID', String(pid), '/F'])
    return
  }
  await execFileAsync('kill', ['-9', String(pid)])
}

async function freePort(port) {
  const pids = await findListeningPidsOnPort(port)
  if (!pids.length) return []
  for (const pid of pids) {
    await terminatePid(pid)
  }
  await sleep(350)
  return pids
}

function listenOnce(serverInstance, port) {
  return new Promise((resolve, reject) => {
    const onListening = () => {
      cleanup()
      resolve()
    }
    const onError = (error) => {
      cleanup()
      reject(error)
    }
    const cleanup = () => {
      serverInstance.off('listening', onListening)
      serverInstance.off('error', onError)
    }
    serverInstance.once('listening', onListening)
    serverInstance.once('error', onError)
    serverInstance.listen(port)
  })
}

async function startServerWithPortRecovery(serverInstance, port) {
  try {
    await listenOnce(serverInstance, port)
    console.log(`Ed-Assist proxy running on http://localhost:${port}`)
  } catch (error) {
    if (error?.code !== 'EADDRINUSE') {
      throw error
    }

    console.warn(`[Proxy] Port ${port} is already in use. Attempting to free it and retry.`)
    const releasedPids = await freePort(port)
    if (!releasedPids.length) {
      throw error
    }

    console.log(`[Proxy] Freed port ${port} by stopping PID${releasedPids.length === 1 ? '' : 's'} ${releasedPids.join(', ')}.`)
    await listenOnce(serverInstance, port)
    console.log(`Ed-Assist proxy running on http://localhost:${port}`)
  }
}

function normalizeModelName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
}

function modelMatches(candidate, target) {
  const left = normalizeModelName(candidate)
  const right = normalizeModelName(target)
  return Boolean(left && right) && (left === right || left.startsWith(`${right}:`) || right.startsWith(`${left}:`))
}

async function checkOllamaHealth() {
  if (!OLLAMA_URL || !OLLAMA_MODEL) {
    return {
      ok: false,
      reachable: false,
      modelAvailable: false,
      message: 'OLLAMA_URL or OLLAMA_MODEL is not configured.',
    }
  }

  try {
    const response = await axios.get(`${OLLAMA_URL}/api/tags`, {
      timeout: 5000,
      headers: { 'Content-Type': 'application/json' },
    })
    const models = Array.isArray(response.data?.models) ? response.data.models : []
    const modelAvailable = models.some((model) => modelMatches(model?.name, OLLAMA_MODEL))
    return {
      ok: modelAvailable,
      reachable: true,
      modelAvailable,
      message: modelAvailable
        ? ''
        : `Ollama is reachable, but model "${OLLAMA_MODEL}" is not installed. Run "ollama pull ${OLLAMA_MODEL}".`,
    }
  } catch (error) {
    return {
      ok: false,
      reachable: false,
      modelAvailable: false,
      message: `Ollama is not reachable at ${OLLAMA_URL}. Start the Ollama service and make sure "${OLLAMA_MODEL}" is installed.`,
      details: error?.message || 'Unknown Ollama error.',
    }
  }
}

function getGemmaEndpoint() {
  return `https://generativelanguage.googleapis.com/v1beta/models/gemma-4-27b-it:generateContent?key=${GEMINI_API_KEY}`
}

function extractTextCandidate(data) {
  return data?.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('').trim() || ''
}

function parseJsonCandidate(raw, fallback = null) {
  if (!raw) return fallback
  const cleaned = String(raw).replace(/```json|```/g, '').trim()
  try {
    return JSON.parse(cleaned)
  } catch {
    return fallback
  }
}

function formatLectureMemoryForPrompt(entries = []) {
  if (!entries.length) return '(none)'
  return entries
    .slice(0, 18)
    .map((entry, index) => {
      const timestamp = typeof entry.timestamp === 'number' ? `${Math.round(entry.timestamp / 1000)}s` : 'unknown'
      return `${index + 1}. [${timestamp}] page ${entry.page || '?'} - ${entry.summary || entry.annotation || ''}`.trim()
    })
    .join('\n')
}

function normalizeNumberish(value, fallback = 0) {
  const num = Number(value)
  return Number.isFinite(num) ? num : fallback
}

function splitTranscriptSentences(text = '') {
  return String(text)
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
}

function buildSegmentsFromWords(words = []) {
  if (!words.length) return []
  const segments = []
  let current = null

  for (const rawWord of words) {
    const text = String(rawWord.text || rawWord.word || '').trim()
    if (!text) continue
    const startMs = Math.round(normalizeNumberish(rawWord.start, 0) * 1000)
    const endMs = Math.round(normalizeNumberish(rawWord.end, rawWord.start) * 1000)
    if (!current) {
      current = { startMs, endMs, text }
    } else {
      current.text += `${/^[,.;!?]/.test(text) ? '' : ' '}${text}`
      current.endMs = endMs
    }

    const shouldClose = /[.!?]$/.test(text) || current.text.split(/\s+/).length >= 18 || current.endMs - current.startMs >= 9000
    if (shouldClose) {
      segments.push(current)
      current = null
    }
  }

  if (current) segments.push(current)
  return segments
}

function buildSegmentsFromTranscriptText(text = '', durationMs = 0) {
  const sentences = splitTranscriptSentences(text)
  if (!sentences.length) return []
  const totalDuration = Math.max(durationMs, sentences.length * 4000)
  const slice = totalDuration / sentences.length
  return sentences.map((sentence, index) => ({
    startMs: Math.round(index * slice),
    endMs: Math.round((index + 1) * slice),
    text: sentence,
  }))
}

function normalizeTranscriptSegments(payload, durationMs = 0) {
  const directSegments = Array.isArray(payload?.segments) ? payload.segments : Array.isArray(payload?.words) ? buildSegmentsFromWords(payload.words) : []
  if (directSegments.length) {
    return directSegments
      .map((segment, index) => ({
        id: segment.id || `seg-${index + 1}`,
        startMs: Math.max(0, Math.round(normalizeNumberish(segment.startMs ?? segment.start, 0) * (segment.startMs == null ? 1000 : 1))),
        endMs: Math.max(0, Math.round(normalizeNumberish(segment.endMs ?? segment.end, 0) * (segment.endMs == null ? 1000 : 1))),
        text: String(segment.text || '').trim(),
      }))
      .filter((segment) => segment.text)
  }
  return buildSegmentsFromTranscriptText(payload?.text || payload?.transcript || '', durationMs).map((segment, index) => ({
    id: `seg-${index + 1}`,
    ...segment,
  }))
}

function normalizeBounds(bounds = {}) {
  return {
    x: normalizeNumberish(bounds.x, 0),
    y: normalizeNumberish(bounds.y, 0),
    width: normalizeNumberish(bounds.width, 0),
    height: normalizeNumberish(bounds.height, 0),
  }
}

function mergeBounds(boundsList = []) {
  if (!boundsList.length) return { x: 0, y: 0, width: 0, height: 0 }
  const left = Math.min(...boundsList.map((bounds) => bounds.x))
  const top = Math.min(...boundsList.map((bounds) => bounds.y))
  const right = Math.max(...boundsList.map((bounds) => bounds.x + bounds.width))
  const bottom = Math.max(...boundsList.map((bounds) => bounds.y + bounds.height))
  return {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  }
}

function formatAnnotationAction(stroke) {
  const nearbyText = Array.isArray(stroke.nearbyText) ? stroke.nearbyText.filter(Boolean).slice(0, 5).join(' ') : ''
  if (nearbyText) {
    return stroke.tool === 'highlighter' ? `highlighted "${nearbyText}"` : `drew near "${nearbyText}"`
  }
  return stroke.tool === 'highlighter' ? 'highlighted a page region' : 'drew on a page region'
}

function groupAnnotationEvents(annotationEvents = []) {
  const normalized = annotationEvents
    .map((event, index) => ({
      id: event.id || `annotation-${index + 1}`,
      page: Number(event.page) || 1,
      tool: event.tool === 'highlighter' ? 'highlighter' : 'pen',
      points: Array.isArray(event.points) ? event.points : [],
      startedAtMs: Math.max(0, Math.round(normalizeNumberish(event.startedAtMs, 0))),
      endedAtMs: Math.max(0, Math.round(normalizeNumberish(event.endedAtMs, event.startedAtMs))),
      nearbyText: Array.isArray(event.nearbyText) ? event.nearbyText.filter(Boolean) : [],
      bounds: normalizeBounds(event.bounds),
      annotationLabel: String(event.annotationLabel || '').trim(),
    }))
    .sort((left, right) => left.startedAtMs - right.startedAtMs)

  const groups = []
  const gapMs = 7000
  for (const stroke of normalized) {
    const previous = groups[groups.length - 1]
    if (previous && previous.page === stroke.page && stroke.startedAtMs - previous.endedAtMs <= gapMs) {
      previous.events.push(stroke)
      previous.endedAtMs = Math.max(previous.endedAtMs, stroke.endedAtMs)
      continue
    }
    groups.push({
      page: stroke.page,
      startedAtMs: stroke.startedAtMs,
      endedAtMs: stroke.endedAtMs,
      events: [stroke],
    })
  }

  return groups.map((group, index) => {
    const bounds = mergeBounds(group.events.map((event) => event.bounds))
    const nearbyText = [...new Set(group.events.flatMap((event) => event.nearbyText || []))].slice(0, 8)
    const actionSummary = group.events
      .map((event) => event.annotationLabel || formatAnnotationAction(event))
      .filter(Boolean)
      .join('; ')
    return {
      id: `moment-${index + 1}`,
      timestamp: group.startedAtMs,
      page: group.page,
      startedAtMs: group.startedAtMs,
      endedAtMs: group.endedAtMs,
      bounds,
      nearbyText,
      annotation: actionSummary || 'Professor annotated this page region.',
      eventCount: group.events.length,
      tools: [...new Set(group.events.map((event) => event.tool))],
    }
  })
}

function overlapDuration(startA, endA, startB, endB) {
  return Math.max(0, Math.min(endA, endB) - Math.max(startA, startB))
}

function attachTranscriptToMoments(moments = [], transcriptSegments = []) {
  return moments.map((moment) => {
    const windowStart = Math.max(0, moment.startedAtMs - 7000)
    const windowEnd = moment.endedAtMs + 7000
    const overlapping = transcriptSegments.filter((segment) => {
      const segmentStart = normalizeNumberish(segment.startMs, 0)
      const segmentEnd = normalizeNumberish(segment.endMs, segmentStart)
      return overlapDuration(windowStart, windowEnd, segmentStart, segmentEnd) > 0
    })
    const excerpt = overlapping.map((segment) => segment.text).join(' ').trim()
    return {
      ...moment,
      transcript: clipText(excerpt, OLLAMA_MOMENT_TRANSCRIPT_CHARS),
    }
  })
}

async function generateLectureMemoryWithGemma(moments = [], transcript = '') {
  if (!moments.length) {
    return { entries: [], mode: 'idle', warning: '', error: '' }
  }

  const compactMoments = moments.map((moment) => ({
    timestamp: moment.timestamp,
    page: moment.page,
    annotation: clipText(moment.annotation, OLLAMA_ANNOTATION_CHARS),
    nearbyText: Array.isArray(moment.nearbyText) ? moment.nearbyText.filter(Boolean).slice(0, OLLAMA_NEARBY_TEXT_ITEMS) : [],
    transcript: clipText(moment.transcript, OLLAMA_MOMENT_TRANSCRIPT_CHARS),
  }))

  const prompt = `You are converting a lecture transcript plus timestamped document annotations into structured lecture memory.

Return ONLY a JSON object of the form { "entries": [ ... ] } where each entry has exactly these keys:
- timestamp (integer, milliseconds from lecture start; copy from the input moment)
- transcript (string, the words the professor was saying around that moment)
- annotation (string, what the professor drew/highlighted)
- page (integer, the page number)
- summary (one sentence explaining what the professor was likely emphasizing at that moment)

Do not invent details beyond the transcript and annotation context. Output one entry per input moment, in the same order.
Each input moment already includes the relevant local transcript excerpt, so do not expect the full lecture transcript.

Annotation moments:
${JSON.stringify(
    compactMoments,
    null,
    2,
  )}`

  let lastError = ''
  for (let attempt = 1; attempt <= OLLAMA_LECTURE_MEMORY_RETRIES; attempt += 1) {
    try {
      const raw = await callOllama(prompt, { json: true, timeout: OLLAMA_LECTURE_MEMORY_TIMEOUT_MS })
      const parsed = parseJsonCandidate(raw, null)
      const entries = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.entries)
          ? parsed.entries
          : Array.isArray(parsed?.lectureMemory)
            ? parsed.lectureMemory
            : []

      if (!entries.length) {
        lastError = `Gemma 4 returned an empty or invalid lecture-memory payload on attempt ${attempt}.`
      } else {
        return {
          entries: entries.map((entry, index) => ({
            timestamp: Math.max(0, Math.round(normalizeNumberish(entry.timestamp, moments[index]?.timestamp || 0))),
            transcript: String(entry.transcript || moments[index]?.transcript || '').trim(),
            annotation: String(entry.annotation || moments[index]?.annotation || '').trim(),
            page: Number(entry.page) || moments[index]?.page || 1,
            summary: String(entry.summary || '').trim(),
          })),
          mode: 'ready',
          warning: '',
          error: '',
        }
      }
    } catch (error) {
      console.error('Lecture memory generation failed (Ollama):', error.response?.data || error.message)
      lastError = error?.message || `Gemma 4 request failed on attempt ${attempt}.`
    }

    if (attempt < OLLAMA_LECTURE_MEMORY_RETRIES) {
      await sleep(attempt * 1200)
    }
  }

  return {
    entries: [],
    mode: 'error',
    warning: `Gemma 4 could not build lecture memory for this lecture. Current model: ${OLLAMA_MODEL}.`,
    error: lastError || 'Gemma 4 did not return a usable lecture-memory response.',
  }
}

function parseChapterArray(raw) {
  if (!raw) return []
  const cleaned = raw.replace(/```json|```/g, '').trim()
  try {
    const parsed = JSON.parse(cleaned)
    return Array.isArray(parsed) ? parsed.filter(Boolean).map(String) : []
  } catch {
    return cleaned
      .split('\n')
      .map((line) => line.replace(/^\s*[-*\d.)]+\s*/, '').trim())
      .filter(Boolean)
      .slice(0, 8)
  }
}

async function detectChaptersAsync(transcript) {
  if (!transcript?.trim()) {
    return { chapters: [], mode: 'idle', warning: '', error: '' }
  }

  try {
    const raw = await callOllama(
      `Analyze this lecture transcript and return ONLY a JSON object of the form { "chapters": [ "name 1", "name 2", ... ] } with 4 to 8 concise chapter or topic names. No markdown, no extra text.

Transcript:
${clipText(transcript, OLLAMA_CHAPTER_TRANSCRIPT_CHARS)}`,
      { json: true },
    )

    const parsed = parseJsonCandidate(raw, null)
    const chapters = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.chapters)
        ? parsed.chapters
        : Array.isArray(parsed?.topics)
          ? parsed.topics
          : []

    let nextChapters = chapters.filter(Boolean).map(String).slice(0, 8)
    if (!nextChapters.length) {
      nextChapters = parseChapterArray(raw)
    }
    return {
      chapters: nextChapters,
      mode: 'ready',
      warning: '',
      error: '',
    }
  } catch (error) {
    console.error('Chapter detection failed (Ollama):', error.response?.data || error.message)
    return {
      chapters: [],
      mode: 'error',
      warning: `Ollama was unavailable while detecting lecture chapters, so the chapter list was left empty. Current model: ${OLLAMA_MODEL}.`,
      error: error?.message || 'Gemma 4 chapter detection failed.',
    }
  }
}

function safeSend(ws, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  ws.send(JSON.stringify(payload))
  if (payload?.type === 'gemini_connected') {
    log('[Proxy] gemini_connected sent to browser')
  }
}

function socketIsActive(ws) {
  return ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
}

function closeSocket(ws, code = 1000, reason = '') {
  if (!socketIsActive(ws)) return
  ws.close(code, reason)
}

function decodeReason(reason) {
  if (!reason) return ''
  if (typeof reason === 'string') return reason
  if (Buffer.isBuffer(reason)) return reason.toString()
  return String(reason)
}

function compactSection(title, value, fallback = '(none)', maxChars = 12000) {
  const text = typeof value === 'string' ? value.trim() : ''
  const body = text ? text.slice(0, maxChars) : fallback
  return `${title}:\n${body}`
}

function buildContextSystemInstruction() {
  const chapters = sessionContext.chapters?.length
    ? sessionContext.chapters.map((chapter, index) => `${index + 1}. ${chapter}`).join('\n')
    : '(none)'

  return `You are Ed-Assist, a live course assistant helping a student understand the uploaded course materials.

Use only the available transcript, notes, seeded document context, and current conversation for factual answers. If information is missing, say so briefly.

${compactSection('Detected chapters', chapters, '(none)', 3000)}

${compactSection('Lecture transcript', sessionContext.transcript)}

${compactSection('Typed notes', sessionContext.typedNotes, '(none)', 6000)}

${compactSection('Handwritten notes', sessionContext.handwrittenNotesText, '(none)', 6000)}

${compactSection('Lecture memory', formatLectureMemoryForPrompt(sessionContext.lectureMemory), '(none)', 6000)}`
}

async function scheduleLecturePostProcessing({ transcript, transcriptSegments, annotationEvents, jobToken }) {
  const annotationMoments = attachTranscriptToMoments(groupAnnotationEvents(annotationEvents), transcriptSegments)
  const ollamaStatus = await checkOllamaHealth()

  if (jobToken !== latestLectureJobToken) return

  if (!ollamaStatus.ok) {
    sessionContext.lectureMemory = []
    sessionContext.chapters = []
    refreshSessionMetadata({
      lectureMemoryMode: annotationMoments.length ? 'error' : 'idle',
      lectureMemoryError: annotationMoments.length ? ollamaStatus.message : '',
      chapterDetectionMode: transcript ? 'error' : 'idle',
      chapterDetectionError: transcript ? ollamaStatus.message : '',
      postProcessState: 'idle',
      warnings: [ollamaStatus.message],
    })
    return
  }

  refreshSessionMetadata({
    lectureMemoryMode: annotationMoments.length ? 'pending' : 'idle',
    lectureMemoryError: '',
    chapterDetectionMode: transcript ? 'pending' : 'idle',
    chapterDetectionError: '',
    postProcessState: 'running',
    warnings: [],
  })

  const [lectureMemoryResult, chapterResult] = await Promise.all([
    annotationMoments.length ? generateLectureMemoryWithGemma(annotationMoments, transcript) : Promise.resolve({ entries: [], mode: 'idle', warning: '', error: '' }),
    transcript ? detectChaptersAsync(transcript) : Promise.resolve({ chapters: [], mode: 'idle', warning: '', error: '' }),
  ])

  if (jobToken !== latestLectureJobToken) return

  sessionContext.lectureMemory = Array.isArray(lectureMemoryResult.entries) ? lectureMemoryResult.entries : []
  sessionContext.chapters = Array.isArray(chapterResult.chapters) ? chapterResult.chapters : []

  const warnings = [lectureMemoryResult.warning, chapterResult.warning].filter(Boolean)
  refreshSessionMetadata({
    lectureMemoryMode: lectureMemoryResult.mode,
    lectureMemoryError: lectureMemoryResult.error || '',
    chapterDetectionMode: chapterResult.mode,
    chapterDetectionError: chapterResult.error || '',
    postProcessState:
      lectureMemoryResult.mode === 'pending' || chapterResult.mode === 'pending'
        ? 'running'
        : lectureMemoryResult.mode === 'error' || chapterResult.mode === 'error'
          ? 'completed_with_issues'
          : 'idle',
    warnings,
    groundingChanged: sessionContext.lectureMemory.length > 0,
  })
}

app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'Audio file is required.' })
  }

  if (!ELEVENLABS_API_KEY?.trim()) {
    cleanupUpload(req.file)
    return res.status(500).json({
      message: 'Server has no ELEVENLABS_API_KEY. Add it to .env and restart the proxy.',
    })
  }

  try {
    const formData = new FormData()
    const durationMs = Math.max(0, Math.round(normalizeNumberish(req.body?.durationMs, 0)))
    formData.append('file', fs.createReadStream(req.file.path), {
      filename: req.file.originalname || 'lecture.webm',
      contentType: req.file.mimetype || 'audio/webm',
    })
    formData.append('model_id', 'scribe_v2')

    const response = await axios.post('https://api.elevenlabs.io/v1/speech-to-text', formData, {
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        ...formData.getHeaders(),
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    })

    const transcript = response.data?.text || response.data?.transcript || ''
    const segments = normalizeTranscriptSegments(response.data, durationMs)
    res.json({ transcript, segments })
  } catch (error) {
    console.error('Transcription error:', error.response?.data || error.message)
    const message = messageFromUpstream(error)
    const code = error.response?.status
    const clientStatus = code === 401 || code === 403 ? code : 500
    res.status(clientStatus).json({ message })
  } finally {
    cleanupUpload(req.file)
  }
})

// TODO: migrate this to local Ollama once we standardize on a multimodal Gemma build
// (e.g. gemma3:4b is multimodal, but gemma4:e4b may not be on every install). For now we
// keep the cloud Gemma vision call so handwritten-notes OCR keeps working out of the box.
app.post('/api/ocr-notes', upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'Image file is required.' })
  }

  try {
    const imageBase64 = await fs.promises.readFile(req.file.path, { encoding: 'base64' })
    const response = await axios.post(
      getGemmaEndpoint(),
      {
        contents: [
          {
            parts: [
              {
                inline_data: {
                  mime_type: req.file.mimetype || 'image/png',
                  data: imageBase64,
                },
              },
              {
                text: 'Transcribe all handwritten text exactly as written. Preserve structure. Return only the transcribed text, nothing else.',
              },
            ],
          },
        ],
      },
      {
        headers: { 'Content-Type': 'application/json' },
      },
    )

    res.json({ text: extractTextCandidate(response.data) })
  } catch (error) {
    console.error('OCR error:', error.response?.data || error.message)
    res.status(500).json({ message: 'Handwriting OCR failed.' })
  } finally {
    cleanupUpload(req.file)
  }
})

app.post('/api/clone-voice', upload.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'Audio file is required.' })
  }

  if (!ELEVENLABS_API_KEY?.trim()) {
    cleanupUpload(req.file)
    return res.status(500).json({
      message: 'Server has no ELEVENLABS_API_KEY. Add it to .env and restart the proxy.',
    })
  }

  try {
    const formData = new FormData()
    formData.append('name', 'Professor Voice Clone')
    formData.append('files', fs.createReadStream(req.file.path), {
      filename: req.file.originalname || 'voice-sample.webm',
      contentType: req.file.mimetype || 'audio/webm',
    })

    const response = await axios.post('https://api.elevenlabs.io/v1/voices/add', formData, {
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        ...formData.getHeaders(),
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    })

    sessionContext.voiceId = response.data?.voice_id || ''
    refreshSessionMetadata()
    res.json({ voiceId: sessionContext.voiceId, runtimeStatus: sessionContext.runtimeStatus, contextVersion: sessionContext.contextVersion })
  } catch (error) {
    console.error('Voice clone error:', error.response?.data || error.message)
    const message = messageFromUpstream(error)
    const code = error.response?.status
    const clientStatus = code === 401 || code === 403 ? code : 500
    res.status(clientStatus).json({ message })
  } finally {
    cleanupUpload(req.file)
  }
})

app.post('/api/process-lecture', async (req, res) => {
  const transcript = String(req.body?.transcript || '').trim()
  const transcriptSegments = normalizeTranscriptSegments(
    {
      transcript,
      segments: Array.isArray(req.body?.transcriptSegments) ? req.body.transcriptSegments : [],
    },
    normalizeNumberish(req.body?.lectureDurationMs, 0),
  )
  const annotationEvents = Array.isArray(req.body?.annotationEvents) ? req.body.annotationEvents : []
  const pdfBase64 = req.body?.pdfBase64 || null
  const pdfMimeType = req.body?.pdfMimeType || 'application/pdf'
  const pageCount = Math.max(0, Number(req.body?.pageCount) || 0)
  const documentName = String(req.body?.documentName || '').trim()

  if (!transcript) {
    return res.status(400).json({ message: 'A lecture transcript is required before processing.' })
  }

  if (!pdfBase64) {
    return res.status(400).json({ message: 'Upload a lecture PDF before publishing the lecture package.' })
  }

  try {
    sessionContext.transcript = transcript
    sessionContext.transcriptSegments = transcriptSegments
    sessionContext.pdfBase64 = pdfBase64
    sessionContext.pdfMimeType = pdfMimeType
    sessionContext.annotationEvents = annotationEvents
    sessionContext.annotatedDocument = {
      type: 'overlay_annotations',
      pageCount,
      sourcePdfMimeType: pdfMimeType,
      annotationCount: annotationEvents.length,
    }
    sessionContext.lectureMemory = []
    sessionContext.chapters = []
    sessionContext.lectureStatus = 'published'
    sessionContext.documentName = documentName
    sessionContext.publishedAt = new Date().toISOString()
    latestLectureJobToken += 1
    const jobToken = latestLectureJobToken
    refreshSessionMetadata({
      lectureMemoryMode: annotationEvents.length ? 'pending' : 'idle',
      lectureMemoryError: '',
      chapterDetectionMode: transcript ? 'pending' : 'idle',
      chapterDetectionError: '',
      postProcessState: 'running',
      warnings: ['Published for students. Gemma 4 is building lecture memory in the background.'],
      groundingChanged: true,
    })

    void scheduleLecturePostProcessing({
      transcript,
      transcriptSegments,
      annotationEvents,
      jobToken,
    })

    res.json({
      ok: true,
      status: sessionContext.lectureStatus,
      lectureMemory: sessionContext.lectureMemory,
      publishedAt: sessionContext.publishedAt,
      contextVersion: sessionContext.contextVersion,
      liveGroundingVersion: sessionContext.liveGroundingVersion,
      runtimeStatus: sessionContext.runtimeStatus,
      warnings: sessionContext.runtimeStatus.warnings,
    })
  } catch (error) {
    console.error('Process lecture error:', error.response?.data || error.message)
    res.status(500).json({
      message: error?.message || 'Unable to process the lecture package.',
    })
  }
})

app.post('/api/set-context', async (req, res) => {
  const body = req.body || {}
  const previousTranscript = sessionContext.transcript

  // Merge: only overwrite fields that are explicitly provided so panels can
  // sync independently (e.g. PDF upload alone, or transcript alone).
  if (Object.prototype.hasOwnProperty.call(body, 'transcript')) {
    sessionContext.transcript = body.transcript || ''
  }
  if (Object.prototype.hasOwnProperty.call(body, 'transcriptSegments')) {
    sessionContext.transcriptSegments = Array.isArray(body.transcriptSegments) ? body.transcriptSegments : []
  }
  if (Object.prototype.hasOwnProperty.call(body, 'handwrittenNotesText')) {
    sessionContext.handwrittenNotesText = body.handwrittenNotesText || ''
  }
  if (Object.prototype.hasOwnProperty.call(body, 'typedNotes')) {
    sessionContext.typedNotes = body.typedNotes || ''
  }
  if (Object.prototype.hasOwnProperty.call(body, 'pdfBase64')) {
    sessionContext.pdfBase64 = body.pdfBase64 || null
    sessionContext.pdfMimeType = body.pdfMimeType || 'application/pdf'
  }
  if (Object.prototype.hasOwnProperty.call(body, 'voiceId')) {
    sessionContext.voiceId = body.voiceId || sessionContext.voiceId || ''
  }
  if (Object.prototype.hasOwnProperty.call(body, 'annotationEvents')) {
    sessionContext.annotationEvents = Array.isArray(body.annotationEvents) ? body.annotationEvents : []
  }
  if (Object.prototype.hasOwnProperty.call(body, 'annotatedDocument')) {
    sessionContext.annotatedDocument = body.annotatedDocument || null
  }
  if (Object.prototype.hasOwnProperty.call(body, 'lectureMemory')) {
    sessionContext.lectureMemory = Array.isArray(body.lectureMemory) ? body.lectureMemory : []
  }
  if (Object.prototype.hasOwnProperty.call(body, 'lectureStatus')) {
    sessionContext.lectureStatus = body.lectureStatus || sessionContext.lectureStatus || 'idle'
  }
  if (Object.prototype.hasOwnProperty.call(body, 'documentName')) {
    sessionContext.documentName = body.documentName || ''
  }
  if (Object.prototype.hasOwnProperty.call(body, 'publishedAt')) {
    sessionContext.publishedAt = body.publishedAt || null
  }
  if (Object.prototype.hasOwnProperty.call(body, 'runtimeStatus')) {
    sessionContext.runtimeStatus =
      body.runtimeStatus && typeof body.runtimeStatus === 'object'
        ? {
            ...createRuntimeStatus({ voiceId: sessionContext.voiceId }),
            ...body.runtimeStatus,
          }
        : createRuntimeStatus({ voiceId: sessionContext.voiceId })
  }

  let chapterResult = {
    mode: sessionContext.runtimeStatus?.chapterDetectionMode || 'idle',
    warning: '',
    error: '',
    chapters: sessionContext.chapters,
  }
  if (sessionContext.transcript && sessionContext.transcript !== previousTranscript) {
    chapterResult = await detectChaptersAsync(sessionContext.transcript)
    sessionContext.chapters = chapterResult.chapters
  }

  const warningSet = new Set(sessionContext.runtimeStatus?.warnings || [])
  if (chapterResult.warning) warningSet.add(chapterResult.warning)
  refreshSessionMetadata({
    lectureMemoryMode: sessionContext.runtimeStatus?.lectureMemoryMode || 'idle',
    lectureMemoryError: sessionContext.runtimeStatus?.lectureMemoryError || '',
    chapterDetectionMode: chapterResult.mode,
    chapterDetectionError: chapterResult.error || '',
    postProcessState: sessionContext.runtimeStatus?.postProcessState || 'idle',
    warnings: [...warningSet],
  })

  res.json({ ok: true, contextVersion: sessionContext.contextVersion, runtimeStatus: sessionContext.runtimeStatus })
})

app.post('/api/clear-context', (_req, res) => {
  sessionContext = createEmptySessionContext()
  latestLectureJobToken += 1
  refreshSessionMetadata({ groundingChanged: true })
  res.json({ ok: true, contextVersion: sessionContext.contextVersion, runtimeStatus: sessionContext.runtimeStatus })
})

app.get('/api/context', (_req, res) => {
  res.json({
    hasPdf: Boolean(sessionContext.pdfBase64),
    pdfBase64: sessionContext.pdfBase64,
    pdfMimeType: sessionContext.pdfMimeType,
    chapters: sessionContext.chapters,
    transcript: sessionContext.transcript,
    transcriptSegments: sessionContext.transcriptSegments,
    typedNotes: sessionContext.typedNotes,
    handwrittenNotesText: sessionContext.handwrittenNotesText,
    annotationEvents: sessionContext.annotationEvents,
    annotatedDocument: sessionContext.annotatedDocument,
    lectureMemory: sessionContext.lectureMemory,
    lectureStatus: sessionContext.lectureStatus,
    documentName: sessionContext.documentName,
    publishedAt: sessionContext.publishedAt,
    contextVersion: sessionContext.contextVersion,
    liveGroundingVersion: sessionContext.liveGroundingVersion,
    updatedAt: sessionContext.updatedAt,
    runtimeStatus: sessionContext.runtimeStatus,
  })
})

app.get('/api/health', async (_req, res) => {
  const ollamaHealth = await checkOllamaHealth()
  res.json({
    ok: true,
    port: PORT,
    serverPid: SERVER_PID,
    serverStartedAt: SERVER_STARTED_AT,
    geminiConfigured: Boolean(GEMINI_API_KEY?.trim()),
    elevenLabsConfigured: Boolean(ELEVENLABS_API_KEY?.trim()),
    ollama: {
      url: OLLAMA_URL,
      model: OLLAMA_MODEL,
      reachable: ollamaHealth.reachable,
      modelAvailable: ollamaHealth.modelAvailable,
      ready: ollamaHealth.ok,
      message: ollamaHealth.message || '',
    },
    lectureRuntime: sessionContext.runtimeStatus,
  })
})

/**
 * Mint a short-lived Live API auth token (v1alpha) so the browser can connect with
 * `auth_tokens/...` instead of embedding a browser API key in the WebSocket URL.
 *
 * Browser WebSocket handshakes often send Referer: empty; Google API keys restricted by
 * "HTTP referrers" then fail with "referer <empty> are blocked". Server-side keys use
 * normal HTTPS requests for token creation and are not subject to that WebSocket quirk.
 *
 * For production, protect this route (session cookie, etc.); it is open for local dev.
 */
app.post('/api/gemini-live/token', async (req, res) => {
  if (!GEMINI_API_KEY?.trim()) {
    return res.status(503).json({
      message: 'Server has no GEMINI_API_KEY. Add it to .env for server-minted Live tokens.',
    })
  }

  try {
    const { GoogleGenAI } = await import('@google/genai/node')
    const ai = new GoogleGenAI({
      apiKey: GEMINI_API_KEY,
      httpOptions: { apiVersion: 'v1alpha' },
    })
    const requestedModel = typeof req.body?.model === 'string' ? req.body.model.trim() : ''
    const requestedConfig =
      req.body?.config && typeof req.body.config === 'object' && !Array.isArray(req.body.config) ? req.body.config : null
    const tokenConfig = {
      uses: 1,
      httpOptions: { apiVersion: 'v1alpha' },
    }

    if (requestedModel || requestedConfig) {
      tokenConfig.liveConnectConstraints = {}
      if (requestedModel) tokenConfig.liveConnectConstraints.model = requestedModel
      if (requestedConfig) tokenConfig.liveConnectConstraints.config = requestedConfig
    }

    const token = await ai.authTokens.create({
      config: tokenConfig,
    })
    if (!token?.name) {
      return res.status(500).json({ message: 'Token response missing name.' })
    }
    res.json({ tokenName: token.name })
  } catch (error) {
    console.error('gemini-live token:', error)
    res.status(500).json({
      message: error?.message || 'Failed to create Live session token.',
    })
  }
})

const server = http.createServer(app)
const liveWss = new WebSocketServer({ noServer: true, perMessageDeflate: false })
liveWss.on('error', (error) => {
  if (error?.code !== 'EADDRINUSE') {
    console.error('[Live WS] Server error:', error.message)
  }
})

/**
 * Build a minimal RIFF/WAVE header for 16-bit PCM mono and prepend it to the raw
 * little-endian samples. ElevenLabs Scribe REST accepts this directly.
 */
function pcm16ToWavBuffer(pcmBuffer, sampleRate = 16000) {
  const dataSize = pcmBuffer.length
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataSize, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16) // fmt chunk size
  header.writeUInt16LE(1, 20) // PCM format
  header.writeUInt16LE(1, 22) // channels
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28) // byte rate
  header.writeUInt16LE(2, 32) // block align
  header.writeUInt16LE(16, 34) // bits per sample
  header.write('data', 36)
  header.writeUInt32LE(dataSize, 40)
  return Buffer.concat([header, pcmBuffer])
}

/**
 * Lightweight live-captions WebSocket. The browser pushes 16 kHz mono int16 PCM
 * (base64-encoded). We buffer ~3 seconds and POST it to ElevenLabs Scribe REST,
 * then stream the resulting text back as a partial caption. This is purely a UX
 * layer — the authoritative transcript still comes from the final batch upload
 * to /api/transcribe when the professor stops.
 */
const sttWss = new WebSocketServer({ noServer: true, perMessageDeflate: false })
sttWss.on('error', (error) => {
  if (error?.code !== 'EADDRINUSE') {
    console.error('[STT-Stream] Server error:', error.message)
  }
})

server.on('upgrade', (request, socket, head) => {
  const requestUrl = request.url || '/'
  const pathname = new URL(requestUrl, 'http://localhost').pathname
  const rejectUpgrade = () => {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
    socket.destroy()
  }

  if (pathname === '/api/live') {
    liveWss.handleUpgrade(request, socket, head, (ws) => {
      liveWss.emit('connection', ws, request)
    })
    return
  }

  if (pathname === '/api/stt-stream') {
    sttWss.handleUpgrade(request, socket, head, (ws) => {
      sttWss.emit('connection', ws, request)
    })
    return
  }

  rejectUpgrade()
})

sttWss.on('connection', (browserWs) => {
  let pcmChunks = []
  let pcmBytes = 0
  let flushing = false
  let flushTimer = null
  let closed = false
  // 16 kHz * 2 bytes/sample * 3 seconds ≈ 96 KB
  const FLUSH_BYTES = 16000 * 2 * 3
  const FLUSH_MS = 3500

  function safeSendCaption(payload) {
    if (browserWs.readyState !== WebSocket.OPEN) return
    browserWs.send(JSON.stringify(payload))
  }

  async function flush() {
    if (flushing || closed || !pcmChunks.length) return
    if (!ELEVENLABS_API_KEY?.trim()) {
      pcmChunks = []
      pcmBytes = 0
      safeSendCaption({ type: 'error', message: 'Server has no ELEVENLABS_API_KEY for live captions.' })
      return
    }

    flushing = true
    const merged = Buffer.concat(pcmChunks, pcmBytes)
    pcmChunks = []
    pcmBytes = 0

    try {
      const wav = pcm16ToWavBuffer(merged, 16000)
      const formData = new FormData()
      formData.append('file', wav, { filename: 'partial.wav', contentType: 'audio/wav' })
      formData.append('model_id', 'scribe_v2')

      const response = await axios.post('https://api.elevenlabs.io/v1/speech-to-text', formData, {
        headers: { 'xi-api-key': ELEVENLABS_API_KEY, ...formData.getHeaders() },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 30000,
      })

      const text = (response.data?.text || response.data?.transcript || '').trim()
      if (text) {
        safeSendCaption({ type: 'partial_transcript', text })
      }
    } catch (error) {
      log('[STT-Stream] Scribe partial failed:', error.response?.data || error.message)
    } finally {
      flushing = false
    }
  }

  function scheduleFlush() {
    if (flushTimer) return
    flushTimer = setTimeout(() => {
      flushTimer = null
      void flush()
    }, FLUSH_MS)
  }

  browserWs.on('message', (rawMessage) => {
    log('[Proxy] Browser message received')
    let message
    try {
      message = JSON.parse(rawMessage.toString())
    } catch {
      return
    }

    if (message.type === 'audio_chunk' && typeof message.audio === 'string') {
      const buf = Buffer.from(message.audio, 'base64')
      pcmChunks.push(buf)
      pcmBytes += buf.length
      if (pcmBytes >= FLUSH_BYTES) {
        if (flushTimer) {
          clearTimeout(flushTimer)
          flushTimer = null
        }
        void flush()
      } else {
        scheduleFlush()
      }
    } else if (message.type === 'flush') {
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      void flush()
    }
  })

  browserWs.on('close', () => {
    closed = true
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    pcmChunks = []
    pcmBytes = 0
  })

  browserWs.on('error', (error) => {
    log('[STT-Stream] Browser WS error:', error.message)
  })

  safeSendCaption({ type: 'ready' })
})

liveWss.on('connection', (browserWs) => {
  log('[Proxy] Browser connected to /api/live')
  let geminiWs = null
  let elevenWs = null
  let elevenReady = false
  let elevenQueue = []
  let isSpeaking = false
  let currentSource = null
  let sessionSystemInstruction = ''
  let pendingSeedTurns = []

  function buildSystemInstruction() {
    return sessionSystemInstruction.trim() || buildContextSystemInstruction()
  }

  function prepareElevenLabs() {
    const existingWs = elevenWs
    if (socketIsActive(existingWs)) {
      closeSocket(existingWs, 1000, 'Refreshing stream')
    }

    elevenWs = null
    elevenReady = false
    isSpeaking = false
    currentSource = null

    if (!ELEVENLABS_API_KEY?.trim()) {
      safeSend(browserWs, {
        type: 'error',
        message: 'Server has no ELEVENLABS_API_KEY. Add it to .env and restart the proxy.',
      })
      return
    }

    const voiceId = sessionContext.voiceId
    if (!voiceId) {
      console.warn('[ElevenLabs] No voice ID set — skipping TTS connection')
      return
    }

    const wsUrl =
      `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input` +
      `?model_id=eleven_flash_v2_5&output_format=pcm_24000&optimize_streaming_latency=3`

    const nextWs = new WebSocket(wsUrl, {
      headers: { 'xi-api-key': ELEVENLABS_API_KEY },
    })

    elevenWs = nextWs

    nextWs.on('open', () => {
      if (elevenWs !== nextWs) {
        closeSocket(nextWs, 1000, 'Superseded')
        return
      }

      log('[ElevenLabs] Connected')
      elevenReady = true

      nextWs.send(
        JSON.stringify({
          text: ' ',
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.8,
            use_speaker_boost: true,
          },
          generation_config: {
            chunk_length_schedule: [120, 160, 250, 290],
          },
        }),
      )

      if (elevenQueue.length > 0) {
        log(`[ElevenLabs] Flushing ${elevenQueue.length} queued chunks`)
        elevenQueue.forEach((chunk) => {
          nextWs.send(JSON.stringify({ text: chunk }))
        })
        elevenQueue = []
      }
    })

    nextWs.on('message', (data) => {
      if (elevenWs !== nextWs) return

      try {
        const msg = JSON.parse(data.toString())

        if (msg.audio) {
          if (!isSpeaking) {
            isSpeaking = true
            safeSend(browserWs, { type: 'speaking_start' })
          }
          safeSend(browserWs, { type: 'audio_chunk', audio: msg.audio })
        }

        if (msg.isFinal) {
          isSpeaking = false
          currentSource = null
          safeSend(browserWs, { type: 'speaking_end' })
          prepareElevenLabs()
        }

        if (msg.error) {
          console.error('[ElevenLabs] API error:', msg.error)
          safeSend(browserWs, { type: 'error', message: `ElevenLabs: ${msg.error}` })
        }
      } catch (error) {
        console.error('[ElevenLabs] Failed to parse message:', error.message)
      }
    })

    nextWs.on('error', (err) => {
      if (elevenWs !== nextWs) return
      console.error('[ElevenLabs] WS error:', err.message)
      elevenReady = false
      safeSend(browserWs, { type: 'error', message: 'TTS connection error' })
    })

    nextWs.on('close', (code, reason) => {
      if (elevenWs !== nextWs) return
      log(`[ElevenLabs] Closed: ${code} ${decodeReason(reason)}`)
      elevenReady = false
      isSpeaking = false
      currentSource = null
    })
  }

  function streamTextToElevenLabs(text) {
    if (!text || text.trim() === '') return

    currentSource = currentSource || 'gemini'

    if (!elevenReady || !elevenWs || elevenWs.readyState !== WebSocket.OPEN) {
      log(`[ElevenLabs] Not ready yet — queuing: "${text.substring(0, 30)}..."`)
      elevenQueue.push(text)
      return
    }

    elevenWs.send(JSON.stringify({ text }))
  }

  function flushElevenLabs() {
    elevenQueue = []
    currentSource = null
    if (elevenWs && elevenWs.readyState === WebSocket.OPEN) {
      elevenWs.send(JSON.stringify({ text: '' }))
      log('[ElevenLabs] Sent EOS signal')
    }
  }

  function stopElevenLabs() {
    const activeWs = elevenWs
    elevenQueue = []
    isSpeaking = false
    elevenReady = false
    currentSource = null
    elevenWs = null
    if (activeWs && socketIsActive(activeWs)) {
      closeSocket(activeWs, 1000, 'Interrupted')
    }
    safeSend(browserWs, { type: 'speaking_end' })
  }

  function sendSeedTurns() {
    if (!pendingSeedTurns.length || !geminiWs || geminiWs.readyState !== WebSocket.OPEN) return

    geminiWs.send(
      JSON.stringify({
        clientContent: {
          turns: pendingSeedTurns,
          turnComplete: false,
        },
      }),
    )
    pendingSeedTurns = []
  }

  function connectGemini() {
    log('[Gemini] Preparing upstream live connection')
    if (!GEMINI_API_KEY?.trim()) {
      safeSend(browserWs, {
        type: 'error',
        message: 'Server has no GEMINI_API_KEY. Add it to .env and restart the proxy.',
      })
      return
    }

    if (socketIsActive(geminiWs)) {
      closeSocket(geminiWs, 1000, 'Restarting session')
    }

    geminiWs = new WebSocket(GEMINI_LIVE_WS_URL)
    log('[Gemini] Opening upstream socket')

    const setup = {
      setup: {
        model: 'models/gemini-3.1-flash-live-preview',
        generationConfig: {
          responseModalities: ['AUDIO'],
        },
        systemInstruction: {
          parts: [{ text: buildSystemInstruction() }],
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        historyConfig: {
          initialHistoryInClientContent: true,
        },
      },
    }

    geminiWs.on('open', () => {
      log('[Gemini] WebSocket opened')
      geminiWs.send(JSON.stringify(setup))
      prepareElevenLabs()
      safeSend(browserWs, { type: 'gemini_connected' })
    })

    geminiWs.on('message', (rawMsg) => {
      let msg
      try {
        msg = JSON.parse(rawMsg.toString())
      } catch {
        return
      }

      if (msg.setupComplete) {
        sendSeedTurns()
        return
      }

      const content = msg.serverContent
      if (!content) return

      if (content.interrupted) {
        log('[Gemini] Turn interrupted by user')
        stopElevenLabs()
        setTimeout(() => {
          if (browserWs.readyState === WebSocket.OPEN) {
            prepareElevenLabs()
          }
        }, 300)
        safeSend(browserWs, { type: 'interrupted' })
        return
      }

      if (content.inputTranscription?.text) {
        safeSend(browserWs, {
          type: 'transcript_user',
          text: content.inputTranscription.text,
          isFinal: content.inputTranscription.finished ?? true,
        })
      }

      const hasOutputTranscript = Boolean(content.outputTranscription?.text)
      if (hasOutputTranscript) {
        safeSend(browserWs, {
          type: 'transcript_gemini',
          text: content.outputTranscription.text,
        })
        streamTextToElevenLabs(content.outputTranscription.text)
      }

      if (content.modelTurn?.parts) {
        for (const part of content.modelTurn.parts) {
          if (!part.text) continue
          if (!hasOutputTranscript) {
            safeSend(browserWs, {
              type: 'transcript_gemini',
              text: part.text,
            })
          }
          streamTextToElevenLabs(part.text)
        }
      }

      if (content.turnComplete) {
        log('[Gemini] Turn complete — flushing ElevenLabs')
        flushElevenLabs()
      }
    })

    geminiWs.on('error', (err) => {
      console.error('[Gemini] WS error:', err.message)
      safeSend(browserWs, { type: 'error', message: 'Gemini connection error' })
    })

    geminiWs.on('close', (code, reason) => {
      log(`[Gemini] Closed: ${code} ${decodeReason(reason)}`)
      stopElevenLabs()
      if (browserWs.readyState === WebSocket.OPEN && code !== 1000) {
        safeSend(browserWs, {
          type: 'error',
          message: decodeReason(reason) || 'Gemini Live session closed unexpectedly.',
        })
      }
      geminiWs = null
    })
  }

  browserWs.on('message', (rawMessage) => {
    let message
    try {
      message = JSON.parse(rawMessage.toString())
    } catch {
      return
    }

    switch (message.type) {
      case 'start_session':
        log('[Proxy] start_session received')
        sessionSystemInstruction = typeof message.systemInstruction === 'string' ? message.systemInstruction : ''
        pendingSeedTurns = Array.isArray(message.seedTurns) ? message.seedTurns : []
        connectGemini()
        break
      case 'audio_chunk':
        if (geminiWs && geminiWs.readyState === WebSocket.OPEN && typeof message.audio === 'string') {
          geminiWs.send(
            JSON.stringify({
              realtimeInput: {
                audio: {
                  data: message.audio,
                  mimeType: 'audio/pcm;rate=16000',
                },
              },
            }),
          )
        }
        break
      case 'audio_stream_end':
        if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
          geminiWs.send(
            JSON.stringify({
              realtimeInput: { audioStreamEnd: true },
            }),
          )
        }
        break
      case 'user_text': {
        const text = typeof message.text === 'string' ? message.text.trim() : ''
        if (!text || !geminiWs || geminiWs.readyState !== WebSocket.OPEN) break
        geminiWs.send(
          JSON.stringify({
            realtimeInput: {
              text,
            },
          }),
        )
        break
      }
      case 'end_session':
        log('[Proxy] Session ended by user')
        stopElevenLabs()
        if (geminiWs) {
          closeSocket(geminiWs, 1000, 'Session ended')
          geminiWs = null
        }
        safeSend(browserWs, { type: 'session_ended' })
        break
      default:
        break
    }
  })

  browserWs.on('close', (code, reason) => {
    log(`[Proxy] Browser disconnected — cleaning up (${code} ${decodeReason(reason)})`)
    stopElevenLabs()
    if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
      geminiWs.close(1000, 'Browser disconnected')
    } else if (geminiWs && geminiWs.readyState === WebSocket.CONNECTING) {
      closeSocket(geminiWs, 1000, 'Browser disconnected')
    }
    geminiWs = null
  })

  browserWs.on('error', (error) => {
    console.error('[Proxy] Browser WS error:', error.message)
  })
})

app.use(express.static(path.join(__dirname, '../dist')))

app.get('*', (_req, res) => {
  const distIndex = path.join(__dirname, '../dist/index.html')
  if (fs.existsSync(distIndex)) {
    res.sendFile(distIndex)
    return
  }

  res.status(404).json({ message: 'Build output not found.' })
})

void startServerWithPortRecovery(server, PORT).catch((error) => {
  console.error('[Proxy] Failed to start server:', error)
  process.exit(1)
})
