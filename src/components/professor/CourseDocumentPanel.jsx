import { useRef, useState } from 'react'
import axios from 'axios'

function DocIcon({ size = 48 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z"
        stroke="var(--primary)"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M14 3v5h5" stroke="var(--primary)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result?.toString() || ''
      const base64 = result.includes(',') ? result.split(',')[1] : result
      resolve(base64)
    }
    reader.onerror = () => reject(reader.error || new Error('Unable to read file.'))
    reader.readAsDataURL(file)
  })
}

export default function CourseDocumentPanel() {
  const inputRef = useRef(null)
  const [file, setFile] = useState(null)
  const [status, setStatus] = useState('idle') // idle | uploading | ready | error
  const [error, setError] = useState('')
  const [isDragging, setIsDragging] = useState(false)

  const handleFile = async (incoming) => {
    if (!incoming) return
    if (incoming.type && incoming.type !== 'application/pdf' && !incoming.name?.toLowerCase().endsWith('.pdf')) {
      setError('Please upload a PDF file.')
      setStatus('error')
      return
    }

    setError('')
    setStatus('uploading')
    setFile(incoming)

    try {
      const base64 = await readFileAsBase64(incoming)
      await axios.post('/api/set-context', {
        pdfBase64: base64,
        pdfMimeType: incoming.type || 'application/pdf',
      })
      setStatus('ready')
    } catch (uploadError) {
      setError(uploadError.response?.data?.message || uploadError.message || 'Upload failed.')
      setStatus('error')
    }
  }

  const handleClear = async () => {
    setFile(null)
    setStatus('idle')
    setError('')
    try {
      await axios.post('/api/set-context', { pdfBase64: null })
    } catch {}
  }

  return (
    <section className="glass-card" style={{ padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
        <DocIcon size={32} />
        <div>
          <h2 style={{ margin: 0, fontSize: 20 }}>Course Document</h2>
          <p style={{ margin: '4px 0 0', color: 'var(--text-secondary)', fontSize: 13 }}>
            Upload a PDF — students will see it on their tab.
          </p>
        </div>
      </div>

      {!file && (
        <button
          type="button"
          aria-label="Upload course PDF"
          onClick={() => inputRef.current?.click()}
          onDragOver={(event) => {
            event.preventDefault()
            setIsDragging(true)
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(event) => {
            event.preventDefault()
            setIsDragging(false)
            const dropped = event.dataTransfer.files?.[0]
            if (dropped) handleFile(dropped)
          }}
          style={{
            width: '100%',
            minHeight: 220,
            borderRadius: 14,
            border: `2px dashed ${isDragging ? 'var(--primary)' : 'var(--border)'}`,
            background: isDragging ? 'rgba(56,189,248,0.1)' : 'rgba(255,255,255,0.02)',
            color: 'var(--text-secondary)',
            display: 'grid',
            placeItems: 'center',
            cursor: 'pointer',
            padding: 20,
            textAlign: 'center',
            transition: 'all 0.15s ease',
          }}
        >
          <div>
            <DocIcon size={56} />
            <div style={{ marginTop: 14, fontSize: 15, color: 'var(--text-primary)' }}>
              Drop your PDF here
            </div>
            <div style={{ marginTop: 6, fontSize: 13, color: 'var(--text-muted)' }}>
              or click to browse
            </div>
          </div>
        </button>
      )}

      {file && (
        <div className="glass-card" style={{ padding: 16, display: 'flex', alignItems: 'center', gap: 14 }}>
          <span
            style={{
              fontSize: 22,
              color: status === 'ready' ? 'var(--secondary)' : status === 'error' ? 'var(--danger)' : 'var(--text-muted)',
            }}
          >
            {status === 'ready' ? '✓' : status === 'error' ? '⚠' : '…'}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.name}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {(file.size / 1024 / 1024).toFixed(2)} MB ·{' '}
              {status === 'uploading' && 'Sharing with students…'}
              {status === 'ready' && 'Live for students'}
              {status === 'error' && 'Upload failed'}
            </div>
          </div>
          <button
            type="button"
            aria-label="Replace course PDF"
            className="btn-secondary"
            onClick={handleClear}
            style={{ padding: '8px 14px', fontSize: 13 }}
          >
            Replace
          </button>
        </div>
      )}

      {error && (
        <p style={{ marginTop: 12, color: 'var(--danger)', fontSize: 13 }}>{error}</p>
      )}

      <input
        ref={inputRef}
        type="file"
        hidden
        accept="application/pdf,.pdf"
        onChange={(event) => {
          const picked = event.target.files?.[0]
          if (picked) handleFile(picked)
          event.target.value = ''
        }}
      />
    </section>
  )
}
