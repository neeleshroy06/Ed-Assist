import { useEffect, useMemo, useRef } from 'react'
import { formatTime } from '../../utils/audioUtils'

const ROLE_META = {
  user: { icon: '🎤', label: 'You', color: 'var(--text-secondary)' },
  gemini: { icon: '🎓', label: 'Professor', color: 'var(--primary)' },
  asl: { icon: '🤟', label: 'ASL', color: 'var(--secondary)' },
}

export default function TranscriptPanel({ entries }) {
  const scrollRef = useRef(null)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [entries])

  const transcriptText = useMemo(
    () =>
      entries
        .map((entry) => `[${formatTime(entry.timestamp)}] ${ROLE_META[entry.role]?.label || entry.role}: ${entry.text}`)
        .join('\n\n'),
    [entries],
  )

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div className="glass-card" style={{ padding: 14, marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <div style={{ fontSize: 16, fontWeight: 600 }}>Session Transcript</div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button
              type="button"
              aria-label="Copy transcript"
              className="icon-button"
              onClick={() => navigator.clipboard.writeText(transcriptText)}
            >
              ⧉
            </button>
            <button
              type="button"
              aria-label="Download transcript as text file"
              className="icon-button"
              onClick={() => {
                const blob = new Blob([transcriptText], { type: 'text/plain' })
                const url = URL.createObjectURL(blob)
                const link = document.createElement('a')
                link.href = url
                link.download = 'lecture-studio-session.txt'
                link.click()
                URL.revokeObjectURL(url)
              }}
            >
              ↓
            </button>
          </div>
        </div>
      </div>

      <div ref={scrollRef} className="muted-scrollbar" style={{ flex: 1, overflow: 'auto', paddingRight: 6 }}>
        {!entries.length ? (
          <div className="glass-card" style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)' }}>
            Your conversation will appear here...
          </div>
        ) : (
          entries.map((entry) => {
            const meta = ROLE_META[entry.role] || ROLE_META.user
            return (
              <div
                key={entry.id}
                style={{
                  marginBottom: 16,
                  padding: 12,
                  background: 'var(--surface-raised)',
                  borderRadius: 10,
                  animation: 'fade-in 0.3s ease',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: meta.color, marginBottom: 8 }}>
                  <span>{meta.icon}</span>
                  <span style={{ fontWeight: 600 }}>{meta.label}</span>
                  <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>· {formatTime(entry.timestamp)}</span>
                </div>
                <div className="transcript-mono" style={{ fontSize: 12, lineHeight: 1.6 }}>
                  {entry.text}
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
