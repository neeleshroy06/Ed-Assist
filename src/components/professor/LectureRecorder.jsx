import { useEffect, useMemo, useRef, useState } from 'react'
import axios from 'axios'
import { useAudioRecorder } from '../../hooks/useAudioRecorder'
import { formatTime } from '../../utils/audioUtils'
import StatusDot from '../shared/StatusDot'

function MicIcon({ size = 48, color = 'var(--primary)' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 15a4 4 0 0 0 4-4V7a4 4 0 1 0-8 0v4a4 4 0 0 0 4 4Zm0 0v4m-4 0h8M5 11a7 7 0 1 0 14 0"
        stroke={color}
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export default function LectureRecorder({
  lectureStatus,
  transcriptText,
  onTranscriptChange,
  onLectureStart,
  onLectureProcessed,
  processingError,
  annotationCount,
  canStartLecture,
}) {
  const recorder = useAudioRecorder()
  const canvasRef = useRef(null)
  const audioContextRef = useRef(null)
  const analyserRef = useRef(null)
  const rafRef = useRef(null)
  const recordingStartedAtRef = useRef(0)
  const [viewState, setViewState] = useState('idle')
  const [expanded, setExpanded] = useState(false)
  const [error, setError] = useState('')
  const [progress, setProgress] = useState(0)

  useEffect(() => {
    if (!recorder.isRecording || !recorder.streamRef?.current || !canvasRef.current) return undefined

    const canvas = canvasRef.current
    const context = canvas.getContext('2d')
    const audioContext = new AudioContext()
    const source = audioContext.createMediaStreamSource(recorder.streamRef.current)
    const analyser = audioContext.createAnalyser()
    analyser.fftSize = 256
    source.connect(analyser)
    audioContextRef.current = audioContext
    analyserRef.current = analyser

    const dataArray = new Uint8Array(analyser.frequencyBinCount)

    const draw = () => {
      const { width, height } = canvas
      analyser.getByteFrequencyData(dataArray)
      context.clearRect(0, 0, width, height)

      const barCount = 60
      const barWidth = width / barCount
      for (let index = 0; index < barCount; index += 1) {
        const dataIndex = Math.floor((index / barCount) * dataArray.length)
        const value = dataArray[dataIndex] / 255
        const barHeight = Math.max(10, value * height)
        const x = index * barWidth + 2
        const y = (height - barHeight) / 2
        context.fillStyle = 'rgba(56, 189, 248, 0.88)'
        context.fillRect(x, y, Math.max(barWidth - 4, 3), barHeight)
      }

      rafRef.current = requestAnimationFrame(draw)
    }

    draw()

    return () => {
      cancelAnimationFrame(rafRef.current)
      source.disconnect()
      analyser.disconnect()
      audioContext.close().catch(() => {})
    }
  }, [recorder.isRecording, recorder.streamRef])

  useEffect(() => {
    if (viewState !== 'processing') return undefined
    setProgress(5)
    const startedAt = Date.now()
    const interval = setInterval(() => {
      const elapsed = Date.now() - startedAt
      setProgress(Math.min(90, 5 + (elapsed / 8000) * 85))
    }, 120)
    return () => clearInterval(interval)
  }, [viewState])

  const processBlob = async (blob, durationMs) => {
    if (!blob) return
    if (blob.size < 256) {
      setError('No usable audio was captured. Check the mic permission, try another browser, or record for a few seconds.')
      setViewState('idle')
      return
    }
    setError('')
    setViewState('processing')

    try {
      const formData = new FormData()
      const ext = blob.type?.includes('mp4') ? 'm4a' : 'webm'
      formData.append('audio', blob, `lecture.${ext}`)
      formData.append('durationMs', String(Math.round(durationMs)))
      const response = await axios.post('/api/transcribe', formData)
      const nextTranscript = response.data?.transcript || ''
      const nextSegments = Array.isArray(response.data?.segments) ? response.data.segments : []
      onTranscriptChange?.(nextTranscript)
      setProgress(100)
      await onLectureProcessed?.({
        transcript: nextTranscript,
        transcriptSegments: nextSegments,
        durationMs: Math.round(durationMs),
      })
      setViewState('done')
    } catch (requestError) {
      setError(requestError.response?.data?.message || 'Transcription failed.')
      setViewState('idle')
    }
  }

  const handleStart = async () => {
    setError('')
    onTranscriptChange?.('')
    try {
      await recorder.start()
      recordingStartedAtRef.current = performance.now()
      await onLectureStart?.()
      setViewState('recording')
    } catch (startError) {
      setError(startError.message || 'Microphone access failed.')
      setViewState('idle')
    }
  }

  const handleStop = async () => {
    const durationMs = Math.max(recorder.elapsed * 1000, performance.now() - recordingStartedAtRef.current)
    const blob = await recorder.stop()
    setViewState('processing')
    await processBlob(blob, durationMs)
  }

  const status = useMemo(() => {
    if (viewState === 'paused') return 'Paused'
    if (viewState === 'recording') return 'Recording...'
    return ''
  }, [viewState])

  return (
    <section className="glass-card" style={{ padding: 24, minHeight: 360 }}>
      {viewState === 'idle' && !transcriptText && (
        <div style={{ minHeight: 310, display: 'grid', placeItems: 'center', textAlign: 'center' }}>
          <div>
            <MicIcon />
            <h2 style={{ margin: '16px 0 8px', fontSize: 20 }}>Start Lecture</h2>
            <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: 14 }}>
              Speak naturally while annotating the PDF. ElevenLabs will transcribe every word.
            </p>

            <button
              type="button"
              aria-label="Start lecture recording"
              onClick={handleStart}
              disabled={!canStartLecture}
              style={{
                width: 72,
                height: 72,
                borderRadius: '50%',
                border: 'none',
                marginTop: 28,
                background: canStartLecture ? 'var(--primary)' : 'rgba(255,255,255,0.12)',
                color: 'white',
                cursor: canStartLecture ? 'pointer' : 'not-allowed',
                boxShadow: '0 0 36px rgba(255,77,106,0.22)',
                opacity: canStartLecture ? 1 : 0.5,
              }}
            >
              <MicIcon size={28} color="white" />
            </button>
            {!canStartLecture && (
              <p style={{ marginTop: 14, fontSize: 13, color: 'var(--text-muted)' }}>
                Upload a lecture PDF first so your annotations can be published with the transcript.
              </p>
            )}
            {error && <p style={{ color: 'var(--danger)', marginTop: 12 }}>{error}</p>}
          </div>
        </div>
      )}

      {(viewState === 'recording' || recorder.isPaused) && (
        <div className="animate-fade-in">
          <canvas
            ref={canvasRef}
            width={800}
            height={80}
            style={{ width: '100%', height: 80, borderRadius: 14, background: 'rgba(255,255,255,0.03)' }}
          />

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, marginTop: 20 }}>
            <StatusDot color="var(--danger)" />
            <span style={{ fontWeight: 600 }}>{status}</span>
            <span className="transcript-mono" style={{ fontSize: 24 }}>
              {formatTime(recorder.elapsed)}
            </span>
          </div>

          <div style={{ display: 'flex', gap: 12, justifyContent: 'center', marginTop: 22 }}>
            <button
              type="button"
              aria-label={recorder.isPaused ? 'Resume recording' : 'Pause recording'}
              className="btn-secondary"
              onClick={() => {
                if (recorder.isPaused) {
                  recorder.resume()
                  setViewState('recording')
                } else {
                  recorder.pause()
                  setViewState('paused')
                }
              }}
            >
              {recorder.isPaused ? 'Resume' : 'Pause'}
            </button>
            <button type="button" aria-label="Stop and transcribe lecture" className="btn-danger" onClick={handleStop}>
              ⏹ Stop &amp; Transcribe
            </button>
          </div>
        </div>
      )}

      {viewState === 'processing' && (
        <div style={{ minHeight: 310, display: 'grid', placeItems: 'center', textAlign: 'center' }}>
          <div style={{ width: '100%', maxWidth: 460 }}>
            <div
              className="animate-spin-slow"
              style={{
                width: 40,
                height: 40,
                borderRadius: '50%',
                border: '3px solid rgba(56,189,248,0.22)',
                borderTopColor: 'var(--primary)',
                margin: '0 auto 16px',
              }}
            />
            <p style={{ fontWeight: 600 }}>
              {lectureStatus === 'processing' ? 'Publishing lecture package…' : 'Transcribing with ElevenLabs Scribe...'}
            </p>
            <div style={{ marginTop: 20, height: 8, borderRadius: 999, background: 'rgba(255,255,255,0.05)' }}>
              <div
                style={{
                  width: `${progress}%`,
                  height: '100%',
                  borderRadius: 999,
                  background: 'linear-gradient(90deg, var(--primary), var(--secondary))',
                  transition: 'width 0.2s ease',
                }}
              />
            </div>
          </div>
        </div>
      )}

      {(viewState === 'done' || transcriptText) && (
        <div className="animate-fade-in">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'start' }}>
            <div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                Lecture status
              </div>
              <h2 style={{ margin: '8px 0 4px', fontSize: 22 }}>
                {lectureStatus === 'published' ? 'Published for students' : 'Transcript ready'}
              </h2>
              <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: 13 }}>
                {lectureStatus === 'published'
                  ? `${annotationCount} slide ${annotationCount === 1 ? 'annotation' : 'annotations'} included in the published package.`
                  : 'Review the transcript before students receive the lecture package.'}
              </p>
            </div>
            <div
              className="glass-card"
              style={{
                padding: 14,
                minWidth: 180,
                display: 'grid',
                gap: 6,
                textAlign: 'left',
              }}
            >
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Professor workflow</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <StatusDot color={lectureStatus === 'published' ? 'var(--secondary)' : 'var(--amber)'} />
                <span style={{ fontSize: 13 }}>
                  {lectureStatus === 'published' ? 'Auto-published' : lectureStatus === 'processing' ? 'Processing' : 'Awaiting publish'}
                </span>
              </div>
            </div>
          </div>

          <button
            type="button"
            aria-label="Expand or collapse transcript"
            onClick={() => setExpanded((value) => !value)}
            style={{
              width: '100%',
              marginTop: 18,
              border: '1px solid var(--border)',
              background: 'rgba(255,255,255,0.03)',
              color: 'var(--text-secondary)',
              borderRadius: 12,
              padding: 12,
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            {expanded ? 'Hide transcript' : 'Preview transcript'}
          </button>

          <textarea
            aria-label="Editable lecture transcript"
            rows={expanded ? 12 : 4}
            className="input-surface transcript-mono"
            style={{ marginTop: 12, fontSize: 12, lineHeight: 1.6 }}
            value={transcriptText}
            onChange={(event) => onTranscriptChange?.(event.target.value)}
          />

          <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
            <button type="button" aria-label="Edit transcript" className="btn-secondary" onClick={() => setExpanded(true)}>
              ✎ Edit
            </button>
            <button
              type="button"
              aria-label="Record a new lecture"
              className="btn-secondary"
              onClick={() => {
                onTranscriptChange?.('')
                setViewState('idle')
              }}
            >
              ↺ New Lecture
            </button>
          </div>
          {(error || processingError) && (
            <p style={{ marginTop: 12, color: 'var(--danger)', fontSize: 13 }}>{error || processingError}</p>
          )}
        </div>
      )}
    </section>
  )
}
