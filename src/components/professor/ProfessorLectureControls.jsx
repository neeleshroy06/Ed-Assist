import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import axios from 'axios'
import { useAudioRecorder } from '../../hooks/useAudioRecorder'
import { formatTime } from '../../utils/audioUtils'
import StatusDot from '../shared/StatusDot'

const ProfessorLectureControls = forwardRef(function ProfessorLectureControls(
  {
    lectureStatus,
    transcriptText,
    onTranscriptChange,
    onLectureStart,
    onLectureProcessed,
    onNewLecture,
    processingError,
    lectureMemoryCount,
    annotationCount,
    hideIdlePlaceholder,
  },
  ref,
) {
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

  const endLecture = useCallback(async () => {
    const durationMs = Math.max(recorder.elapsed * 1000, performance.now() - recordingStartedAtRef.current)
    const blob = await recorder.stop()
    setViewState('processing')
    if (!blob || blob.size < 256) {
      setError('No usable audio was captured. Check the mic permission and try again.')
      setViewState('idle')
      return
    }
    setError('')
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
  }, [onLectureProcessed, onTranscriptChange, recorder])

  const beginLecture = useCallback(async () => {
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
  }, [onLectureStart, onTranscriptChange, recorder])

  useImperativeHandle(ref, () => ({ beginLecture, endLecture }), [beginLecture, endLecture])

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
        context.fillStyle = 'rgba(108, 99, 255, 0.85)'
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

  const status = useMemo(() => {
    if (viewState === 'paused') return 'Paused'
    if (viewState === 'recording') return 'Recording'
    return ''
  }, [viewState])

  if (hideIdlePlaceholder && viewState === 'idle' && !transcriptText) {
    return null
  }

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {viewState === 'idle' && !transcriptText && !hideIdlePlaceholder && (
        <div
          style={{
            minHeight: 100,
            display: 'grid',
            placeItems: 'center',
            textAlign: 'center',
            borderRadius: 14,
            border: '1px dashed var(--border)',
            background: 'rgba(255,255,255,0.02)',
            padding: 18,
          }}
        >
          <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 13 }}>
            Press <strong style={{ color: 'var(--text-secondary)' }}>Start Lecture</strong> in the header to begin.
          </p>
        </div>
      )}

      {(viewState === 'recording' || recorder.isPaused) && (
        <div className="animate-fade-in" style={{ display: 'grid', gap: 14 }}>
          <canvas
            ref={canvasRef}
            width={800}
            height={72}
            style={{ width: '100%', height: 72, borderRadius: 12, background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border)' }}
          />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <StatusDot color="var(--danger)" />
              <span style={{ fontWeight: 600, fontSize: 14 }}>{status}</span>
              <span className="transcript-mono" style={{ fontSize: 22, color: 'var(--text-primary)' }}>
                {formatTime(recorder.elapsed)}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                type="button"
                aria-label={recorder.isPaused ? 'Resume recording' : 'Pause recording'}
                className="btn-secondary"
                style={{ padding: '10px 18px' }}
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
              <button type="button" aria-label="Stop lecture" className="btn-danger" style={{ padding: '10px 22px' }} onClick={() => void endLecture()}>
                Stop lecture
              </button>
            </div>
          </div>
        </div>
      )}

      {viewState === 'processing' && (
        <div style={{ minHeight: 140, display: 'grid', placeItems: 'center', textAlign: 'center', padding: 16 }}>
          <div style={{ width: '100%', maxWidth: 400 }}>
            <div
              className="animate-spin-slow"
              style={{
                width: 36,
                height: 36,
                borderRadius: '50%',
                border: '3px solid rgba(108,99,255,0.18)',
                borderTopColor: 'var(--primary)',
                margin: '0 auto 12px',
              }}
            />
            <p style={{ fontWeight: 600, margin: 0, fontSize: 14 }}>
              {lectureStatus === 'processing' ? 'Publishing lecture package…' : 'Transcribing audio…'}
            </p>
            <div style={{ marginTop: 16, height: 6, borderRadius: 999, background: 'rgba(255,255,255,0.06)' }}>
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
        <div className="animate-fade-in" style={{ display: 'grid', gap: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Result</div>
              <h3 style={{ margin: '6px 0 0', fontSize: 18, fontWeight: 600 }}>
                {lectureStatus === 'published' ? 'Published' : 'Transcript ready'}
              </h3>
              <p style={{ margin: '6px 0 0', color: 'var(--text-secondary)', fontSize: 13, maxWidth: 420 }}>
                {lectureStatus === 'published'
                  ? `${lectureMemoryCount} memory ${lectureMemoryCount === 1 ? 'entry' : 'entries'} · ${annotationCount} annotations`
                  : 'Review the transcript below.'}
              </p>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-muted)' }}>
              <StatusDot color={lectureStatus === 'published' ? 'var(--secondary)' : 'var(--amber)'} />
              {lectureStatus === 'published' ? 'Live for students' : lectureStatus}
            </div>
          </div>

          <button
            type="button"
            className="btn-secondary"
            style={{ width: '100%', justifySelf: 'start', maxWidth: 200, padding: '10px 14px' }}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? 'Hide transcript' : 'Show transcript'}
          </button>

          <textarea
            aria-label="Lecture transcript"
            rows={expanded ? 10 : 3}
            className="input-surface transcript-mono"
            style={{ fontSize: 12, lineHeight: 1.6 }}
            value={transcriptText}
            onChange={(e) => onTranscriptChange?.(e.target.value)}
          />

          <button
            type="button"
            className="btn-secondary"
            style={{ alignSelf: 'start', padding: '10px 18px' }}
            onClick={() => {
              onNewLecture?.()
              onTranscriptChange?.('')
              setViewState('idle')
            }}
          >
            New lecture
          </button>

          {(error || processingError) && <p style={{ margin: 0, color: 'var(--danger)', fontSize: 13 }}>{error || processingError}</p>}
        </div>
      )}
    </div>
  )
})

export default ProfessorLectureControls
