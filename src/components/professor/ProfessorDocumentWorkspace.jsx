import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { renderTextLayer } from 'pdfjs-dist/build/pdf'
import 'pdfjs-dist/web/pdf_viewer.css'
import { loadPdfFromBase64 } from '../../utils/pdfUtils'

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

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value))
}

function getStrokeBounds(points) {
  if (!points?.length) {
    return { x: 0, y: 0, width: 0, height: 0 }
  }
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  points.forEach((point) => {
    minX = Math.min(minX, point.x)
    minY = Math.min(minY, point.y)
    maxX = Math.max(maxX, point.x)
    maxY = Math.max(maxY, point.y)
  })
  return {
    x: minX,
    y: minY,
    width: Math.max(0.01, maxX - minX),
    height: Math.max(0.01, maxY - minY),
  }
}

function shouldEraseStroke(stroke, point, radius = 0.022) {
  return stroke.points?.some((candidate) => {
    const dx = candidate.x - point.x
    const dy = candidate.y - point.y
    return Math.sqrt(dx * dx + dy * dy) <= radius
  })
}

function strokeStyle(stroke) {
  if (stroke.tool === 'highlighter') {
    return {
      stroke: 'rgba(245, 198, 24, 0.38)',
      strokeWidth: stroke.width * 2.5,
      globalCompositeOperation: 'multiply',
    }
  }
  return {
    stroke: stroke.color || '#6C63FF',
    strokeWidth: stroke.width,
    globalCompositeOperation: 'source-over',
  }
}

function summariseTool(tool) {
  if (tool === 'highlighter') return 'highlighted'
  return 'drew on'
}

function buildAnnotationLabel(stroke) {
  const nearbyText = Array.isArray(stroke.nearbyText) ? stroke.nearbyText.filter(Boolean).slice(0, 6).join(' ') : ''
  if (nearbyText) {
    return `${summariseTool(stroke.tool)} "${nearbyText.slice(0, 180)}"`
  }
  return `${summariseTool(stroke.tool)} page region`
}

function ToolButton({ active, children, disabled, ...props }) {
  return (
    <button
      type="button"
      className={active ? 'btn-primary' : 'btn-secondary'}
      style={{ padding: '8px 14px', minWidth: 84, fontSize: 13, opacity: disabled ? 0.45 : 1 }}
      disabled={disabled}
      {...props}
    >
      {children}
    </button>
  )
}

function PdfAnnotatorPage({
  pdfDocument,
  pageNum,
  scale,
  strokes,
  activeStroke,
  canAnnotate,
  onPageRefsChange,
  onDrawStart,
  onDrawMove,
  onDrawEnd,
}) {
  const wrapRef = useRef(null)
  const pageCanvasRef = useRef(null)
  const textLayerRef = useRef(null)
  const overlayCanvasRef = useRef(null)
  const [renderSize, setRenderSize] = useState({ width: 0, height: 0 })
  const pointerActiveRef = useRef(false)

  const syncOverlayToPdfCanvas = useCallback(() => {
    const canvas = pageCanvasRef.current
    if (!canvas) return
    const width = Math.max(1, Math.round(canvas.clientWidth))
    const height = Math.max(1, Math.round(canvas.clientHeight))
    setRenderSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }))
  }, [])

  useEffect(() => {
    if (!pdfDocument) return undefined
    let cancelled = false

    const run = async () => {
      const page = await pdfDocument.getPage(pageNum)
      const viewport = page.getViewport({ scale })
      const canvas = pageCanvasRef.current
      const textLayer = textLayerRef.current
      if (!canvas || !textLayer || cancelled) return

      const context = canvas.getContext('2d')
      canvas.width = viewport.width
      canvas.height = viewport.height

      await page.render({ canvasContext: context, viewport }).promise
      if (cancelled) return

      textLayer.innerHTML = ''
      textLayer.style.setProperty('--scale-factor', String(viewport.scale))
      const textContent = await page.getTextContent()
      if (cancelled) return

      const task = renderTextLayer({
        textContentSource: textContent,
        container: textLayer,
        viewport,
        textDivs: [],
      })
      await task.promise
      if (cancelled) return

      onPageRefsChange(pageNum, {
        wrap: wrapRef.current,
        textLayer,
      })

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!cancelled) syncOverlayToPdfCanvas()
        })
      })
    }

    run().catch((error) => {
      console.error('Professor PDF page render failed', pageNum, error)
    })

    return () => {
      cancelled = true
      onPageRefsChange(pageNum, null)
    }
  }, [onPageRefsChange, pageNum, pdfDocument, scale, syncOverlayToPdfCanvas])

  useEffect(() => {
    const canvas = pageCanvasRef.current
    if (!canvas) return undefined

    const observer = new ResizeObserver(() => {
      syncOverlayToPdfCanvas()
    })

    observer.observe(canvas)
    return () => observer.disconnect()
  }, [syncOverlayToPdfCanvas])

  useEffect(() => {
    const overlay = overlayCanvasRef.current
    if (!overlay || !renderSize.width || !renderSize.height) return
    overlay.width = renderSize.width
    overlay.height = renderSize.height
    const context = overlay.getContext('2d')
    context.clearRect(0, 0, overlay.width, overlay.height)
    const allStrokes = activeStroke ? [...strokes, activeStroke] : strokes

    allStrokes.forEach((stroke) => {
      if (!stroke?.points?.length) return
      const style = strokeStyle(stroke)
      context.save()
      context.globalCompositeOperation = style.globalCompositeOperation
      context.strokeStyle = style.stroke
      context.lineWidth = style.strokeWidth
      context.lineCap = 'round'
      context.lineJoin = 'round'
      context.beginPath()
      stroke.points.forEach((point, index) => {
        const x = point.x * overlay.width
        const y = point.y * overlay.height
        if (index === 0) context.moveTo(x, y)
        else context.lineTo(x, y)
      })
      context.stroke()
      context.restore()
    })
  }, [activeStroke, renderSize.height, renderSize.width, strokes])

  const getPoint = useCallback((event) => {
    const rect = event.currentTarget.getBoundingClientRect()
    return {
      x: clamp((event.clientX - rect.left) / rect.width),
      y: clamp((event.clientY - rect.top) / rect.height),
    }
  }, [])

  const handlePointerDown = (event) => {
    if (!canAnnotate) return
    pointerActiveRef.current = true
    event.currentTarget.setPointerCapture?.(event.pointerId)
    onDrawStart(pageNum, getPoint(event))
  }

  const handlePointerMove = (event) => {
    if (!pointerActiveRef.current || !canAnnotate) return
    onDrawMove(pageNum, getPoint(event))
  }

  const handlePointerUp = (event) => {
    if (!pointerActiveRef.current || !canAnnotate) return
    pointerActiveRef.current = false
    onDrawEnd(pageNum, getPoint(event))
  }

  return (
    <div
      ref={wrapRef}
      data-page-number={pageNum}
      style={{
        position: 'relative',
        width: '100%',
        marginBottom: 16,
        border: '1px solid var(--border)',
        borderRadius: 12,
        overflow: 'hidden',
        background: '#ffffff',
        boxShadow: '0 12px 40px rgba(0,0,0,0.35)',
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: 10,
          right: 10,
          zIndex: 4,
          borderRadius: 999,
          padding: '5px 10px',
          background: 'rgba(10,10,18,0.92)',
          border: '1px solid var(--border)',
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: '0.04em',
          color: 'var(--text-secondary)',
        }}
      >
        Page {pageNum}
      </div>
      <canvas ref={pageCanvasRef} style={{ display: 'block', width: '100%' }} />
      <div
        ref={textLayerRef}
        className="textLayer"
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: '100%',
          height: '100%',
          color: 'transparent',
          opacity: 0,
          pointerEvents: 'none',
          zIndex: 1,
        }}
      />
      <canvas
        ref={overlayCanvasRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: '100%',
          height: '100%',
          cursor: canAnnotate ? 'crosshair' : 'default',
          touchAction: 'none',
          zIndex: 2,
          pointerEvents: canAnnotate ? 'auto' : 'none',
          background: 'transparent',
        }}
      />
    </div>
  )
}

export default function ProfessorDocumentWorkspace({
  lectureStatus,
  allowUpload,
  documentState,
  annotationEvents,
  onDocumentStateChange,
  onAnnotationEventsChange,
  getCurrentTimestampMs,
}) {
  const [status, setStatus] = useState('idle')
  const [error, setError] = useState('')
  const [pdfDoc, setPdfDoc] = useState(null)
  const [scale, setScale] = useState(1.25)
  const [tool, setTool] = useState('pen')
  const [activeStroke, setActiveStroke] = useState(null)
  const [isDragging, setIsDragging] = useState(false)
  const pageRefsRef = useRef({})
  const inputRef = useRef(null)

  const canAnnotate = lectureStatus === 'recording'
  const strokesByPage = useMemo(() => {
    const map = new Map()
    annotationEvents.forEach((stroke) => {
      if (!map.has(stroke.page)) map.set(stroke.page, [])
      map.get(stroke.page).push(stroke)
    })
    return map
  }, [annotationEvents])

  useEffect(() => {
    if (!documentState?.pdfBase64) {
      setPdfDoc(null)
      setStatus('idle')
      return
    }
    let cancelled = false

    const loadPdf = async () => {
      try {
        setStatus('loading')
        setError('')
        const pdf = await loadPdfFromBase64(documentState.pdfBase64, documentState.pdfMimeType)
        if (cancelled) return
        setPdfDoc(pdf)
        setStatus('ready')
        onDocumentStateChange({
          pageCount: pdf.numPages,
        })
      } catch (loadError) {
        if (cancelled) return
        setError(loadError.message || 'Unable to load PDF.')
        setStatus('error')
      }
    }

    loadPdf()
    return () => {
      cancelled = true
    }
  }, [documentState?.pdfBase64, documentState?.pdfMimeType, onDocumentStateChange])

  const handleFile = async (file) => {
    if (!file) return
    if (file.type && file.type !== 'application/pdf' && !file.name?.toLowerCase().endsWith('.pdf')) {
      setError('Please upload a PDF file.')
      setStatus('error')
      return
    }
    try {
      setStatus('loading')
      setError('')
      const pdfBase64 = await readFileAsBase64(file)
      onAnnotationEventsChange([])
      onDocumentStateChange({
        fileName: file.name || 'Lecture document.pdf',
        pdfBase64,
        pdfMimeType: file.type || 'application/pdf',
        pageCount: 0,
      })
    } catch (uploadError) {
      setError(uploadError.message || 'Unable to read file.')
      setStatus('error')
    }
  }

  const onPageRefsChange = useCallback((pageNum, refs) => {
    if (!refs) {
      delete pageRefsRef.current[pageNum]
      return
    }
    pageRefsRef.current[pageNum] = refs
  }, [])

  const collectNearbyText = useCallback((pageNum, bounds) => {
    const refs = pageRefsRef.current[pageNum]
    if (!refs?.wrap || !refs?.textLayer) return []
    const { wrap, textLayer } = refs
    const wrapRect = wrap.getBoundingClientRect()
    const target = {
      left: wrapRect.left + bounds.x * wrapRect.width,
      top: wrapRect.top + bounds.y * wrapRect.height,
      right: wrapRect.left + (bounds.x + bounds.width) * wrapRect.width,
      bottom: wrapRect.top + (bounds.y + bounds.height) * wrapRect.height,
    }
    const matches = []
    textLayer.querySelectorAll('span').forEach((node) => {
      const text = node.textContent?.trim()
      if (!text) return
      const rect = node.getBoundingClientRect()
      const overlaps =
        rect.right >= target.left &&
        rect.left <= target.right &&
        rect.bottom >= target.top &&
        rect.top <= target.bottom
      if (overlaps) matches.push(text)
    })
    return [...new Set(matches)].slice(0, 12)
  }, [])

  const commitStroke = useCallback(
    (stroke) => {
      if (!stroke?.points?.length) return
      const bounds = getStrokeBounds(stroke.points)
      const nearbyText = collectNearbyText(stroke.page, bounds)
      const nextStroke = {
        ...stroke,
        bounds,
        nearbyText,
        annotationLabel: buildAnnotationLabel({
          ...stroke,
          nearbyText,
        }),
      }
      onAnnotationEventsChange((current) => [...current, nextStroke])
    },
    [collectNearbyText, onAnnotationEventsChange],
  )

  const handleEraseAtPoint = useCallback(
    (pageNum, point) => {
      onAnnotationEventsChange((current) => {
        const remaining = current.filter((stroke) => {
          if (stroke.page !== pageNum) return true
          return !shouldEraseStroke(stroke, point)
        })
        return remaining
      })
    },
    [onAnnotationEventsChange],
  )

  const handleDrawStart = useCallback(
    (pageNum, point) => {
      if (tool === 'eraser') {
        handleEraseAtPoint(pageNum, point)
        return
      }
      const startedAtMs = getCurrentTimestampMs()
      setActiveStroke({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        page: pageNum,
        tool,
        color: tool === 'highlighter' ? '#F5C618' : '#6C63FF',
        width: tool === 'highlighter' ? 12 : 4,
        points: [point],
        startedAtMs,
        endedAtMs: startedAtMs,
      })
    },
    [getCurrentTimestampMs, handleEraseAtPoint, tool],
  )

  const handleDrawMove = useCallback(
    (pageNum, point) => {
      if (tool === 'eraser') {
        handleEraseAtPoint(pageNum, point)
        return
      }
      setActiveStroke((current) => {
        if (!current || current.page !== pageNum) return current
        return {
          ...current,
          points: [...current.points, point],
          endedAtMs: getCurrentTimestampMs(),
        }
      })
    },
    [getCurrentTimestampMs, handleEraseAtPoint, tool],
  )

  const handleDrawEnd = useCallback(
    (pageNum, point) => {
      if (tool === 'eraser') {
        handleEraseAtPoint(pageNum, point)
        return
      }
      setActiveStroke((current) => {
        if (!current || current.page !== pageNum) return null
        const nextStroke = {
          ...current,
          points: [...current.points, point],
          endedAtMs: getCurrentTimestampMs(),
        }
        commitStroke(nextStroke)
        return null
      })
    },
    [commitStroke, getCurrentTimestampMs, handleEraseAtPoint, tool],
  )

  const annotationSummary = useMemo(() => {
    if (!annotationEvents.length) return 'No annotations yet.'
    const pages = new Set(annotationEvents.map((stroke) => stroke.page)).size
    const highlights = annotationEvents.filter((stroke) => stroke.tool === 'highlighter').length
    const drawings = annotationEvents.length - highlights
    return `${annotationEvents.length} marks across ${pages} pages · ${drawings} pen · ${highlights} highlighter`
  }, [annotationEvents])

  return (
    <section
      className="glass-card"
      style={{
        padding: 0,
        flex: 1,
        minHeight: 0,
        width: '100%',
        display: 'grid',
        gridTemplateRows: 'auto auto 1fr',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '18px 20px 14px',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 14,
          flexWrap: 'wrap',
        }}
      >
        <div>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, letterSpacing: '-0.02em' }}>Slides</h2>
          <p style={{ margin: '6px 0 0', color: 'var(--text-secondary)', fontSize: 13, maxWidth: 420 }}>
            After you start the lecture, upload your PDF here and annotate while you speak.
          </p>
        </div>
        <div
          style={{
            fontSize: 11,
            color: 'var(--text-muted)',
            padding: '6px 10px',
            borderRadius: 999,
            border: '1px solid var(--border)',
            background: 'rgba(255,255,255,0.03)',
            whiteSpace: 'nowrap',
          }}
        >
          {annotationSummary}
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '12px 20px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <button
          type="button"
          className="btn-secondary"
          style={{ padding: '8px 14px', fontSize: 13 }}
          disabled={!allowUpload}
          onClick={() => inputRef.current?.click()}
        >
          {documentState?.pdfBase64 ? 'Replace PDF' : 'Upload PDF'}
        </button>
        <ToolButton active={tool === 'pen'} disabled={!canAnnotate} onClick={() => setTool('pen')}>
          Pen
        </ToolButton>
        <ToolButton active={tool === 'highlighter'} disabled={!canAnnotate} onClick={() => setTool('highlighter')}>
          Highlighter
        </ToolButton>
        <ToolButton active={tool === 'eraser'} disabled={!canAnnotate} onClick={() => setTool('eraser')}>
          Eraser
        </ToolButton>
        <button
          type="button"
          className="btn-secondary"
          style={{ padding: '8px 14px', fontSize: 13 }}
          disabled={!annotationEvents.length || !canAnnotate}
          onClick={() => onAnnotationEventsChange([])}
        >
          Clear marks
        </button>
        <button
          type="button"
          className="btn-secondary"
          style={{ padding: '8px 14px', fontSize: 13 }}
          onClick={() => setScale((value) => Math.min(1.8, value + 0.1))}
        >
          Zoom +
        </button>
        <button
          type="button"
          className="btn-secondary"
          style={{ padding: '8px 14px', fontSize: 13 }}
          onClick={() => setScale((value) => Math.max(0.9, value - 0.1))}
        >
          Zoom -
        </button>
      </div>

      {!documentState?.pdfBase64 && (
        <button
          type="button"
          disabled={!allowUpload}
          onClick={() => allowUpload && inputRef.current?.click()}
          onDragOver={(event) => {
            if (!allowUpload) return
            event.preventDefault()
            setIsDragging(true)
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(event) => {
            if (!allowUpload) return
            event.preventDefault()
            setIsDragging(false)
            const dropped = event.dataTransfer.files?.[0]
            if (dropped) handleFile(dropped)
          }}
          style={{
            margin: 16,
            minHeight: 280,
            borderRadius: 14,
            border: `2px dashed ${isDragging ? 'var(--primary)' : 'var(--border)'}`,
            background: isDragging ? 'rgba(108,99,255,0.1)' : 'rgba(255,255,255,0.02)',
            color: 'var(--text-secondary)',
            cursor: allowUpload ? 'pointer' : 'not-allowed',
            padding: 24,
            opacity: allowUpload ? 1 : 0.55,
          }}
        >
          <div style={{ maxWidth: 380, margin: '0 auto', textAlign: 'center' }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>
              {allowUpload ? 'Drop PDF here or click to browse' : 'Start lecture to upload'}
            </div>
            <div style={{ marginTop: 10, fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5 }}>
              {allowUpload
                ? 'Pages render below. Annotations are saved when you stop the lecture.'
                : 'Press Start Lecture in the left panel first, then add your slides.'}
            </div>
          </div>
        </button>
      )}

      {documentState?.pdfBase64 && (
        <div style={{ minHeight: 0, overflow: 'hidden', display: 'grid', gridTemplateRows: 'auto 1fr', gap: 0 }}>
          <div
            style={{
              padding: '12px 20px',
              display: 'flex',
              flexWrap: 'wrap',
              gap: 10,
              alignItems: 'center',
              justifyContent: 'space-between',
              borderBottom: '1px solid rgba(255,255,255,0.06)',
              background: 'rgba(0,0,0,0.15)',
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {documentState.fileName || 'Lecture document.pdf'}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                {status === 'loading' ? 'Rendering…' : `${documentState.pageCount || pdfDoc?.numPages || 0} pages`}
              </div>
            </div>
            <div style={{ fontSize: 11, color: canAnnotate ? 'var(--secondary)' : 'var(--text-muted)', fontWeight: 500 }}>
              {canAnnotate ? 'Annotations are timestamped' : 'Recording paused or idle'}
            </div>
          </div>

          <div
            className="muted-scrollbar"
            style={{
              minHeight: 0,
              overflowY: 'auto',
              overflowX: 'hidden',
              overscrollBehavior: 'contain',
              padding: '16px 20px 20px',
              background: 'rgba(0,0,0,0.25)',
            }}
          >
            {pdfDoc &&
              Array.from({ length: pdfDoc.numPages }, (_, index) => {
                const pageNum = index + 1
                return (
                  <PdfAnnotatorPage
                    key={pageNum}
                    pdfDocument={pdfDoc}
                    pageNum={pageNum}
                    scale={scale}
                    strokes={strokesByPage.get(pageNum) || []}
                    activeStroke={activeStroke?.page === pageNum ? activeStroke : null}
                    canAnnotate={canAnnotate}
                    onPageRefsChange={onPageRefsChange}
                    onDrawStart={handleDrawStart}
                    onDrawMove={handleDrawMove}
                    onDrawEnd={handleDrawEnd}
                  />
                )
              })}
          </div>
        </div>
      )}

      {error && (
        <p style={{ margin: '0 20px 16px', color: 'var(--danger)', fontSize: 13 }}>
          {error}
        </p>
      )}

      <input
        ref={inputRef}
        type="file"
        hidden
        accept="application/pdf,.pdf"
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) handleFile(file)
          event.target.value = ''
        }}
      />
    </section>
  )
}
