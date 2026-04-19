import { useEffect, useMemo, useRef, useState } from 'react'
import TranscriptPdfViewer from '../components/student/TranscriptPdfViewer'
import VoiceOrb from '../components/student/VoiceOrb'
import VoiceControls from '../components/student/VoiceControls'
import InputModeToggle from '../components/student/InputModeToggle'
import ASLCamera from '../components/student/ASLCamera'
import TranscriptPanel from '../components/student/TranscriptPanel'
import CaptionsBar from '../components/student/CaptionsBar'
import { useMicStream } from '../hooks/useAudioRecorder'
import { GeminiLiveDocumentProvider, useGeminiLiveDocumentContext } from '../context/GeminiLiveDocumentContext'

function StudentPageContent() {
  const live = useGeminiLiveDocumentContext()
  const { sendAudioStreamEnd, annotationEvents = [] } = live
  const [inputMode, setInputMode] = useState('voice')
  const [isMicMuted, setIsMicMuted] = useState(false)
  const [isPaused, setIsPaused] = useState(false)
  const [audioLevel, setAudioLevel] = useState(0.2)
  const documentViewerRef = useRef(null)
  const sessionActive = live.status === 'live'
  const hasPublishedDeck = annotationEvents.length > 0

  const orbState = useMemo(() => {
    if (live.status !== 'live') return 'idle'
    if (live.isAssistantSpeaking) return 'speaking'
    if (live.lastEvent === 'user_turn_complete') return 'thinking'
    if (inputMode === 'voice' && !isMicMuted) return 'listening'
    return 'idle'
  }, [inputMode, isMicMuted, live.isAssistantSpeaking, live.lastEvent, live.status])

  useEffect(() => {
    if (!sessionActive || orbState !== 'listening') {
      setAudioLevel(0.18)
      return undefined
    }
    const timer = setInterval(() => {
      setAudioLevel(0.2 + Math.random() * 0.7)
    }, 150)
    return () => clearInterval(timer)
  }, [orbState, sessionActive])

  const micStream = useMicStream({
    active: sessionActive && inputMode === 'voice' && !isMicMuted,
    onAudioChunk: live.sendMicPcm,
  })

  const captionSpeaker = live.isAssistantSpeaking ? 'Professor' : live.heardText ? 'You' : ''
  const captionText = live.isAssistantSpeaking ? live.replyText : live.heardText

  useEffect(() => {
    const match = captionText.match(/\[page:(\d+)\]/i)
    if (match) {
      documentViewerRef.current?.scrollToPage(Number(match[1]))
    }
  }, [captionText])

  useEffect(() => {
    if (!sessionActive) return

    if (inputMode === 'asl') {
      setIsMicMuted(true)
      sendAudioStreamEnd()
      return
    }

    setIsMicMuted(false)
  }, [inputMode, sendAudioStreamEnd, sessionActive])

  const voiceSessionState = useMemo(() => {
    if (live.status === 'live') return 'active'
    if (live.status === 'connecting' || live.status === 'closing') return 'connecting'
    return 'idle'
  }, [live.status])

  const centerPanelStyle = useMemo(
    () => ({
      width: '37%',
      flex: '1 1 37%',
      minWidth: 0,
      minHeight: 0,
      position: 'relative',
      overflow: 'hidden',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'stretch',
      padding: '24px 24px 92px',
      borderLeft: '1px solid var(--border)',
      borderRight: '1px solid var(--border)',
    }),
    [],
  )

  return (
    <div className="animate-fade-in" style={{ height: '100%', display: 'flex', overflow: 'hidden', padding: '12px 12px 12px 12px' }}>
      <div className="muted-scrollbar" style={{ width: '38%', overflowY: 'auto', padding: 12 }}>
        <TranscriptPdfViewer ref={documentViewerRef} />
      </div>

      <div style={centerPanelStyle}>
        <div style={{ display: 'flex', justifyContent: 'center', width: '100%', flexShrink: 0 }}>
          <InputModeToggle mode={inputMode} onToggle={setInputMode} />
        </div>

        {inputMode === 'voice' && (
          <div style={{ flex: '1 1 auto', display: 'grid', placeItems: 'center', width: '100%', paddingTop: 18, minHeight: 0 }}>
            <div style={{ transition: 'transform 0.2s ease' }}>
              <VoiceOrb orbState={orbState} audioLevel={audioLevel} />
            </div>
          </div>
        )}

        {inputMode === 'asl' && (
          <div
            style={{
              width: '100%',
              flex: 1,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              marginTop: 8,
            }}
          >
            <ASLCamera
              active={inputMode === 'asl'}
              sessionState={voiceSessionState}
              onStartSession={async () => {
                setIsPaused(false)
                setIsMicMuted(true)
                await live.preparePlayback()
                await live.startLive()
              }}
              onEndSession={() => {
                live.stopLive()
                setIsMicMuted(false)
                setIsPaused(false)
              }}
              onSpelledWord={(text) => {
                live.sendText(text)
              }}
            />
          </div>
        )}

        {inputMode === 'voice' && (
          <div style={{ marginTop: 20, position: 'relative', zIndex: 10, flexShrink: 0 }}>
            <VoiceControls
              isMicMuted={isMicMuted}
              onMicToggle={() =>
                setIsMicMuted((value) => {
                  if (!value && live.status === 'live') {
                    live.sendAudioStreamEnd()
                  }
                  return !value
                })
              }
              isPaused={isPaused}
              onPauseToggle={async () => {
                if (isPaused) {
                  await live.resumeAssistantAudio()
                } else {
                  live.pauseAssistantAudio()
                }
                setIsPaused((value) => !value)
              }}
              onEndSession={() => {
                live.stopLive()
                setIsMicMuted(false)
                setIsPaused(false)
              }}
              sessionState={voiceSessionState}
              onStartSession={async () => {
                setIsPaused(false)
                setIsMicMuted(false)
                await live.preparePlayback()
                await live.startLive()
              }}
            />
          </div>
        )}

        {(live.error || micStream.error) && <p style={{ color: 'var(--danger)', fontSize: 13, marginTop: 12 }}>{live.error || micStream.error}</p>}
        {live.status === 'connecting' && (
          <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginTop: 12 }}>
            {live.lastEvent === 'context_refresh' ? 'Refreshing live session with the latest lecture context...' : 'Connecting to live session...'}
          </p>
        )}
        {live.status === 'closing' && <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 12 }}>Closing live session...</p>}
        {!live.hasLiveBackend && (
          <p style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 8 }}>
            Set <code style={{ fontFamily: 'inherit' }}>GEMINI_API_KEY</code> and <code style={{ fontFamily: 'inherit' }}>ELEVENLABS_API_KEY</code> in <code style={{ fontFamily: 'inherit' }}>.env</code> so the backend live proxy can connect and speak back.
          </p>
        )}
        {live.runtimeStatus?.lectureMemoryMode === 'pending' && (
          <p style={{ color: 'var(--amber)', fontSize: 12, marginTop: 8 }}>
            The annotated PDF is ready. Background enrichment is still running—answers will improve shortly.
          </p>
        )}
        {live.runtimeStatus?.lectureMemoryMode === 'error' && (
          <p style={{ color: 'var(--amber)', fontSize: 12, marginTop: 8 }}>
            Some background services are unavailable. You can still ask about the document and slide marks.
          </p>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, flexWrap: 'wrap', justifyContent: 'center' }}>
          <span
            title={
              hasPublishedDeck
                ? `${annotationEvents.length} professor marks on the slides. Click a highlighted region to ask about it.`
                : 'No lecture has been published yet — answers will follow the document text only.'
            }
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 10px',
              borderRadius: 999,
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              border: `1px solid ${hasPublishedDeck ? 'rgba(56,189,248,0.45)' : 'var(--border)'}`,
              background: hasPublishedDeck ? 'rgba(56,189,248,0.12)' : 'rgba(56,189,248,0.04)',
              color: hasPublishedDeck ? 'var(--primary)' : 'var(--text-muted)',
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: hasPublishedDeck ? 'var(--primary)' : 'var(--text-muted)',
              }}
            />
            {live.runtimeStatus?.lectureMemoryMode === 'pending'
              ? `Enriching · ${annotationEvents.length} slide marks`
              : hasPublishedDeck
                ? `${annotationEvents.length} slide marks`
                : 'Document only (no lecture published)'}
          </span>
        </div>

        <CaptionsBar speaker={captionSpeaker} caption={(captionText || '').replace(/\[page:\d+\]\s*/i, '')} />

        {live.status === 'live' && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 10, width: '100%', maxWidth: 420, lineHeight: 1.45 }}>
            <div>
              <span style={{ color: 'var(--text-secondary)' }}>You (stream):</span> {live.heardText || '…'}
            </div>
            <div style={{ marginTop: 6 }}>
              <span style={{ color: 'var(--text-secondary)' }}>Assistant (stream):</span> {live.replyText || '…'}
            </div>
            <div style={{ marginTop: 6 }}>
              <span style={{ color: 'var(--text-secondary)' }}>Last heard:</span> {live.lastHeardText || 'Waiting for speech…'}
            </div>
          </div>
        )}
      </div>

      <div className="muted-scrollbar" style={{ width: '25%', overflowY: 'auto', padding: 12 }}>
        <TranscriptPanel entries={live.transcriptEntries} />
      </div>
    </div>
  )
}

export default function StudentPage() {
  return (
    <GeminiLiveDocumentProvider>
      <StudentPageContent />
    </GeminiLiveDocumentProvider>
  )
}
