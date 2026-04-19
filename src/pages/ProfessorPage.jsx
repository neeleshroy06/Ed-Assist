import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import axios from 'axios'
import ProfessorLectureControls from '../components/professor/ProfessorLectureControls'
import ProfessorDocumentWorkspace from '../components/professor/ProfessorDocumentWorkspace'
import { apiRequestUrl, getApiErrorMessage } from '../utils/apiClient'

export default function ProfessorPage() {
  const lectureControlsRef = useRef(null)
  const lectureStartedAtRef = useRef(0)
  const [lectureStatus, setLectureStatus] = useState('idle')
  const [processingError, setProcessingError] = useState('')
  const [processingNotice, setProcessingNotice] = useState('')
  const [runtimeStatus, setRuntimeStatus] = useState(null)
  const [transcriptText, setTranscriptText] = useState('')
  const [transcriptSegments, setTranscriptSegments] = useState([])
  const [annotationEvents, setAnnotationEvents] = useState([])
  const [documentState, setDocumentState] = useState({
    fileName: '',
    pdfBase64: null,
    pdfMimeType: 'application/pdf',
    pageCount: 0,
  })

  const lectureStats = useMemo(() => {
    const highlightedCount = annotationEvents.filter((event) => event.tool === 'highlighter').length
    return {
      annotationCount: annotationEvents.length,
      highlightedCount,
      penCount: annotationEvents.length - highlightedCount,
    }
  }, [annotationEvents])

  const getCurrentTimestampMs = useCallback(() => {
    if (!lectureStartedAtRef.current) return 0
    return Math.max(0, Math.round(performance.now() - lectureStartedAtRef.current))
  }, [])

  const handleDocumentStateChange = useCallback((patch) => {
    setDocumentState((current) => ({
      ...current,
      ...patch,
    }))
  }, [])

  const handleNewLecture = useCallback(() => {
    setLectureStatus('idle')
    setTranscriptText('')
    setTranscriptSegments([])
    setAnnotationEvents([])
    setProcessingError('')
    setProcessingNotice('')
    setRuntimeStatus(null)
  }, [])

  const handleLectureStart = async () => {
    lectureStartedAtRef.current = performance.now()
    setLectureStatus('recording')
    setProcessingError('')
    setProcessingNotice('')
    setTranscriptText('')
    setTranscriptSegments([])
    setAnnotationEvents([])
    setRuntimeStatus(null)
    try {
      const response = await axios.post(apiRequestUrl('/api/clear-context'))
      setRuntimeStatus(response.data?.runtimeStatus || null)
    } catch {
      // non-fatal
    }
  }

  useEffect(() => {
    let cancelled = false
    const loadHealth = async () => {
      try {
        const response = await axios.get(apiRequestUrl('/api/health'))
        if (cancelled) return
        const health = response.data || {}
        if (!health?.ollama?.ready) {
          setProcessingNotice(health.ollama?.message || 'Gemma 4 is not ready on the active backend yet.')
        }
      } catch {
        // best-effort preflight
      }
    }
    void loadHealth()
    return () => {
      cancelled = true
    }
  }, [])

  const handleLectureProcessed = useCallback(
    async ({ transcript, transcriptSegments: nextSegments, durationMs }) => {
      setTranscriptText(transcript)
      setTranscriptSegments(nextSegments)
      setProcessingError('')
      setProcessingNotice('')

      if (!documentState.pdfBase64) {
        setLectureStatus('idle')
        const message =
          'No PDF was uploaded during this lecture, so slides were not published. Upload a PDF before you stop the next lecture.'
        setProcessingError(message)
        try {
          await axios.post(apiRequestUrl('/api/set-context'), {
            transcript,
            transcriptSegments: nextSegments,
            lectureStatus: 'idle',
            publishedAt: null,
          })
        } catch {
          // non-fatal
        }
        return { ok: false, stage: 'publish', message }
      }

      setLectureStatus('processing')
      try {
        const response = await axios.post(apiRequestUrl('/api/process-lecture'), {
          transcript,
          transcriptSegments: nextSegments,
          annotationEvents,
          documentName: documentState.fileName,
          pdfBase64: documentState.pdfBase64,
          pdfMimeType: documentState.pdfMimeType,
          pageCount: documentState.pageCount,
          lectureDurationMs: durationMs,
        })
        setLectureStatus(response.data?.status || 'published')
        setRuntimeStatus(response.data?.runtimeStatus || null)
        const warnings = Array.isArray(response.data?.warnings) ? response.data.warnings.filter(Boolean) : []
        const nextNotice =
          response.data?.runtimeStatus?.lectureMemoryMode === 'pending'
            ? 'Published for students. Enrichment is still running in the background.'
            : warnings.join(' ')
        setProcessingNotice(nextNotice)
        return {
          ok: true,
          status: response.data?.status || 'published',
          publishedAt: response.data?.publishedAt || null,
          warnings,
        }
      } catch (error) {
        const message = getApiErrorMessage(error, {
          action: 'publish the lecture package',
          fallback: 'Lecture processing failed.',
        })
        setProcessingError(message)
        setLectureStatus('idle')
        return { ok: false, stage: 'publish', message }
      }
    },
    [annotationEvents, documentState.fileName, documentState.pageCount, documentState.pdfBase64, documentState.pdfMimeType],
  )

  const showStartLecture = lectureStatus === 'idle' && !transcriptText
  const allowPdfUpload = lectureStatus === 'recording'

  const handleHeaderStart = async () => {
    try {
      await lectureControlsRef.current?.beginLecture()
    } catch {
      // beginLecture handles mic errors internally
    }
  }

  return (
    <div
      className="animate-fade-in"
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: 'linear-gradient(180deg, rgba(5,10,18,0.98) 0%, var(--bg) 38%)',
      }}
    >
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'grid',
          gridTemplateColumns: 'minmax(380px, 520px) minmax(0, 1fr)',
          gap: 16,
          padding: 16,
        }}
      >
        <aside
          style={{
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
            overflow: 'hidden',
          }}
        >
          <section
            className="glass-card"
            style={{
              padding: 20,
              borderRadius: 18,
              flex: 1,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    letterSpacing: '0.14em',
                    color: 'var(--secondary)',
                    textTransform: 'uppercase',
                  }}
                >
                  Professor
                </div>
                <h1 style={{ margin: '6px 0 0', fontSize: 22, fontWeight: 700, letterSpacing: '-0.03em' }}>Lecture Studio</h1>
                <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.45 }}>
                  Start the session, upload your PDF, annotate while you speak, then stop to transcribe and publish.
                </p>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                {lectureStatus === 'recording' && (
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '8px 14px',
                      borderRadius: 999,
                      fontSize: 12,
                      fontWeight: 600,
                      color: 'var(--danger)',
                      border: '1px solid rgba(244,114,182,0.45)',
                      background: 'rgba(244,114,182,0.08)',
                    }}
                  >
                    <span className="pulse-dot" style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--danger)' }} />
                    Lecture live
                  </span>
                )}

                {lectureStatus === 'processing' && (
                  <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 500 }}>Publishing...</span>
                )}

                {lectureStatus === 'published' && (
                  <span style={{ fontSize: 12, color: 'var(--secondary)', fontWeight: 600 }}>Published</span>
                )}

                {showStartLecture && (
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={() => void handleHeaderStart()}
                    style={{
                      padding: '14px 24px',
                      fontSize: 15,
                      fontWeight: 600,
                      borderRadius: 14,
                      boxShadow: '0 8px 32px rgba(56,189,248,0.35)',
                    }}
                  >
                    Start Lecture
                  </button>
                )}
              </div>
            </div>

            <div style={{ marginTop: 18, paddingTop: 18, borderTop: '1px solid rgba(56,189,248,0.1)' }}>
              <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Session & transcription</h2>
              <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                Record, pause, stop, and review the full transcript in this panel.
              </p>
            </div>

            <div className="muted-scrollbar" style={{ marginTop: 16, flex: 1, minHeight: 0, overflowY: 'auto', paddingRight: 4 }}>
              <ProfessorLectureControls
                ref={lectureControlsRef}
                hideIdlePlaceholder
                lectureStatus={lectureStatus}
                transcriptText={transcriptText}
                onTranscriptChange={setTranscriptText}
                onLectureStart={handleLectureStart}
                onLectureProcessed={handleLectureProcessed}
                onNewLecture={handleNewLecture}
                processingError={processingError}
                processingNotice={processingNotice}
                runtimeStatus={runtimeStatus}
                annotationCount={lectureStats.annotationCount}
              />
            </div>
          </section>
        </aside>

        <main style={{ minHeight: 0, height: '100%', display: 'flex', flexDirection: 'column' }}>
          <ProfessorDocumentWorkspace
            lectureStatus={lectureStatus}
            allowUpload={allowPdfUpload}
            documentState={documentState}
            annotationEvents={annotationEvents}
            onDocumentStateChange={handleDocumentStateChange}
            onAnnotationEventsChange={setAnnotationEvents}
            getCurrentTimestampMs={getCurrentTimestampMs}
          />
        </main>
      </div>
    </div>
  )
}
