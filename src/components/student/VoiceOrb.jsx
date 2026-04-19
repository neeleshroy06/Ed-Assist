const LABELS = {
  idle: 'Tap to speak',
  listening: 'Listening...',
  thinking: 'Thinking...',
  speaking: 'Professor speaking...',
}

export default function VoiceOrb({ orbState = 'idle', audioLevel = 0 }) {
  const listeningScale = 0.85 + audioLevel * 0.3

  return (
    <div style={{ width: 200, margin: '0 auto', textAlign: 'center' }}>
      <div style={{ width: 200, height: 200, position: 'relative', margin: '0 auto' }}>
        {orbState === 'listening' &&
          [0, 0.5, 1].map((delay) => (
            <div
              key={delay}
              style={{
                position: 'absolute',
                inset: 40,
                borderRadius: '50%',
                border: '2px solid rgba(56,189,248,0.45)',
                animation: `orb-ripple 1.5s ease-out ${delay}s infinite`,
              }}
            />
          ))}

        {orbState === 'thinking' && (
          <div
            className="animate-spin-slow"
            style={{
              position: 'absolute',
              inset: 40,
              borderRadius: '50%',
              padding: 3,
              background: 'conic-gradient(from 0deg, var(--primary), transparent, var(--primary))',
            }}
          >
            <div
              style={{
                width: '100%',
                height: '100%',
                borderRadius: '50%',
                background: 'var(--surface)',
              }}
            />
          </div>
        )}

        {orbState === 'speaking' &&
          Array.from({ length: 12 }).map((_, index) => (
            <div
              key={index}
              style={{
                position: 'absolute',
                top: '50%',
                left: '50%',
                width: 4,
                height: 16,
                background: 'var(--amber)',
                borderRadius: 2,
                transformOrigin: '50% -68px',
                transform: `translate(-50%, -50%) rotate(${index * 30}deg) translateY(-78px)`,
                animation: `wave-bar 0.9s ease-in-out ${index * 0.08}s infinite`,
                boxShadow: '0 0 12px rgba(245,158,11,0.4)',
              }}
            />
          ))}

        <div
          style={{
            position: 'absolute',
            inset: 40,
            borderRadius: '50%',
            transform: orbState === 'listening' ? `scale(${listeningScale})` : 'scale(1)',
            transition: 'transform 0.15s ease, box-shadow 0.2s ease, background 0.2s ease',
            background:
              orbState === 'speaking'
                ? 'radial-gradient(circle, rgba(245,158,11,0.3) 0%, rgba(245,158,11,0.05) 100%)'
                : orbState === 'listening'
                  ? 'radial-gradient(circle, rgba(56,189,248,0.38) 0%, rgba(56,189,248,0.08) 100%)'
                  : 'radial-gradient(circle, rgba(56,189,248,0.16) 0%, rgba(56,189,248,0.03) 100%)',
            border:
              orbState === 'speaking'
                ? '1px solid rgba(245,158,11,0.5)'
                : '1px solid rgba(56,189,248,0.32)',
            boxShadow:
              orbState === 'speaking'
                ? '0 0 60px rgba(245,158,11,0.2)'
                : '0 0 40px rgba(56,189,248,0.12)',
          }}
        />
      </div>

      <div style={{ marginTop: 14, fontSize: 14, color: 'var(--text-secondary)' }}>{LABELS[orbState]}</div>
    </div>
  )
}
