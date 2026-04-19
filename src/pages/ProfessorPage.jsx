import { useCallback, useMemo, useRef, useState } from 'react'
import axios from 'axios'
import ProfessorLectureControls from '../components/professor/ProfessorLectureControls'
import ProfessorDocumentWorkspace from '../components/professor/ProfessorDocumentWorkspace'

export default function ProfessorPage() {
  const lectureControlsRef = useRef(null)
  const lectureStartedAtRef = useRef(0)
  const [lectureStatus, setLectureStatus] = useState('idle')
  const [processingError, setProcessingError] = useState('')
  const [transcriptText, setTranscriptText] = useState('')
  const [transcriptSegments, setTranscriptSegments] = useState([])
  const [annotationEvents, setAnnotationEvents] = useState([])
  const [lectureMemory, setLectureMemory] = useState([])
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
      memoryCount: lectureMemory.length,
    }
  }, [annotationEvents, lectureMemory.length])

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
    setLectureMemory([])
    setAnnotationEvents([])
    setProcessingError('')
  }, [])

  const handleLectureStart = async () => {
    lectureStartedAtRef.current = performance.now()
    setLectureStatus('recording')
    setProcessingError('')
    setTranscriptText('')
    setTranscriptSegments([])
    setLectureMemory([])
    setAnnotationEvents([])
    try {
      await axios.post('/api/clear-context')
    } catch {
      // non-fatal
    }
  }

  const handleLectureProcessed = useCallback(
    async ({ transcript, transcriptSegments: nextSegments, durationMs }) => {
      setTranscriptText(transcript)
      setTranscriptSegments(nextSegments)

      if (!documentState.pdfBase64) {
        setLectureStatus('idle')
        setLectureMemory([])
        setProcessingError(
          'No PDF was uploaded during this lecture, so slides and lecture memory were not published. Upload a PDF next time before you stop, or start a new lecture.',
        )
        try {
          await axios.post('/api/set-context', { transcript })
        } catch {
          // non-fatal
        }
        return
      }

      setLectureStatus('processing')
      setProcessingError('')
      try {
        const response = await axios.post('/api/process-lecture', {
          transcript,
          transcriptSegments: nextSegments,
          annotationEvents,
          documentName: documentState.fileName,
          pdfBase64: documentState.pdfBase64,
          pdfMimeType: documentState.pdfMimeType,
          pageCount: documentState.pageCount,
          lectureDurationMs: durationMs,
        })
        setLectureMemory(Array.isArray(response.data?.lectureMemory) ? response.data.lectureMemory : [])
        setLectureStatus(response.data?.status || 'published')
      } catch (error) {
        setProcessingError(error.response?.data?.message || error.message || 'Lecture processing failed.')
        setLectureStatus('idle')
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
        background: 'linear-gradient(180deg, rgba(18,18,26,0.98) 0%, var(--bg) 38%)',
      }}
    >
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'grid',
          gridTemplateColumns: 'minmax(340px, 420px) minmax(0, 1fr)',
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
              flex: '1 1 58%',
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
                <h1 style={{ margin: '6px 0 0', fontSize: 22, fontWeight: 700, letterSpacing: '-0.03em' }}>Lecture studio</h1>
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
                      border: '1px solid rgba(255,77,106,0.45)',
                      background: 'rgba(255,77,106,0.08)',
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
                      boxShadow: '0 8px 32px rgba(108,99,255,0.35)',
                    }}
                  >
                    Start Lecture
                  </button>
                )}
              </div>
            </div>

            <div style={{ marginTop: 18, paddingTop: 18, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
              <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Session & transcription</h2>
              <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                Record, pause, stop, and review the transcript in this panel.
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
                lectureMemoryCount={lectureStats.memoryCount}
                annotationCount={lectureStats.annotationCount}
              />
            </div>
          </section>

          <section
            className="glass-card"
            style={{
              padding: 18,
              borderRadius: 18,
              flex: '1 1 42%',
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
              <div>
                <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Lecture memory</h2>
                <p style={{ margin: '6px 0 0', color: 'var(--text-secondary)', fontSize: 12, lineHeight: 1.45 }}>
                  Built when you stop, from your transcript and timed marks on the PDF.
                </p>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8, marginTop: 14 }}>
              <div style={{ padding: 12, borderRadius: 12, background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border)' }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Annotations</div>
                <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>{lectureStats.annotationCount}</div>
              </div>
              <div style={{ padding: 12, borderRadius: 12, background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border)' }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Memory</div>
                <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>{lectureStats.memoryCount}</div>
              </div>
            </div>

            <div className="muted-scrollbar" style={{ marginTop: 14, flex: 1, minHeight: 0, display: 'grid', gap: 10, overflowY: 'auto' }}>
              {!lectureMemory.length && (
                <div
                  style={{
                    padding: 14,
                    borderRadius: 12,
                    border: '1px dashed var(--border)',
                    color: 'var(--text-secondary)',
                    fontSize: 12,
                    lineHeight: 1.5,
                  }}
                >
                  Entries appear after you stop the lecture (with a PDF uploaded during recording).
                </div>
              )}

              {lectureMemory.map((entry, index) => (
                <article
                  key={`${entry.timestamp}-${index}`}
                  style={{
                    padding: 12,
                    borderRadius: 12,
                    border: '1px solid var(--border)',
                    background: 'rgba(255,255,255,0.03)',
                    display: 'grid',
                    gap: 6,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11, color: 'var(--text-muted)' }}>
                    <span>Page {entry.page || '?'}</span>
                    <span>{Math.round((entry.timestamp || 0) / 1000)}s</span>
                  </div>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{entry.summary || '—'}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{entry.annotation || ''}</div>
                  <div className="transcript-mono" style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.45 }}>
                    {entry.transcript || ''}
                  </div>
                </article>
              ))}
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
