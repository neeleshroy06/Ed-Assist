import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { renderTextLayer } from 'pdfjs-dist/build/pdf'
import 'pdfjs-dist/web/pdf_viewer.css'
import { drawStrokeOnCanvas } from '../../utils/strokeStyle'

function getStrokeBounds(points) {
  if (!points?.length) return { x: 0, y: 0, width: 0, height: 0 }
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const point of points) {
    if (point.x < minX) minX = point.x
    if (point.y < minY) minY = point.y
    if (point.x > maxX) maxX = point.x
    if (point.y > maxY) maxY = point.y
  }
  const padding = 0.012
  return {
    x: Math.max(0, minX - padding),
    y: Math.max(0, minY - padding),
    width: Math.min(1, maxX - minX + padding * 2),
    height: Math.min(1, maxY - minY + padding * 2),
  }
}

/**
 * Read-only PDF page that renders any professor strokes on top of it and
 * exposes each annotation as a clickable hit target the student can ask about.
 */
export default function AnnotatedPdfPage({
  pdfDocument,
  pageNum,
  scale,
  strokes = [],
  memoryByAnnotationId,
  onAnnotationClick,
}) {
  const wrapRef = useRef(null)
  const pageCanvasRef = useRef(null)
  const textLayerRef = useRef(null)
  const overlayCanvasRef = useRef(null)
  const [renderSize, setRenderSize] = useState({ width: 0, height: 0 })

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

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!cancelled) syncOverlayToPdfCanvas()
        })
      })
    }

    run().catch((error) => {
      console.error('Annotated PDF page render failed', pageNum, error)
    })

    return () => {
      cancelled = true
    }
  }, [pageNum, pdfDocument, scale, syncOverlayToPdfCanvas])

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
    for (const stroke of strokes) {
      drawStrokeOnCanvas(context, stroke, overlay.width, overlay.height)
    }
  }, [renderSize.height, renderSize.width, strokes])

  const hitTargets = useMemo(() => {
    return strokes.map((stroke) => ({
      stroke,
      bounds: stroke.bounds && stroke.bounds.width > 0 ? stroke.bounds : getStrokeBounds(stroke.points),
    }))
  }, [strokes])

  return (
    <div
      ref={wrapRef}
      data-page-number={pageNum}
      className="pdf-live-page"
      style={{
        position: 'relative',
        border: '1px solid var(--border)',
        borderRadius: 8,
        overflow: 'hidden',
        background: '#0f0f18',
        marginBottom: 12,
      }}
    >
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
          lineHeight: 1,
          pointerEvents: 'none',
        }}
      />
      <canvas
        ref={overlayCanvasRef}
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
        }}
      />
      {hitTargets.map(({ stroke, bounds }) => {
        const memory = memoryByAnnotationId?.get?.(stroke.id)
        const tooltipText = memory?.summary
          || stroke.annotationLabel
          || (stroke.tool === 'highlighter' ? 'Highlighted by professor' : 'Drawn by professor')
        return (
          <button
            key={stroke.id}
            type="button"
            title={`${tooltipText}${memory?.transcript ? ` — "${memory.transcript.slice(0, 120)}…"` : ''}`}
            aria-label={`Ask about: ${tooltipText}`}
            onClick={() => onAnnotationClick?.(stroke.id)}
            className="annotation-hit"
            style={{
              position: 'absolute',
              left: `${bounds.x * 100}%`,
              top: `${bounds.y * 100}%`,
              width: `${Math.max(2.5, bounds.width * 100)}%`,
              height: `${Math.max(2.5, bounds.height * 100)}%`,
              borderRadius: 6,
              border: '1px solid transparent',
              background: 'transparent',
              cursor: 'pointer',
              padding: 0,
              transition: 'background 120ms ease, border-color 120ms ease',
            }}
            onMouseEnter={(event) => {
              event.currentTarget.style.background = 'rgba(56,189,248,0.2)'
              event.currentTarget.style.borderColor = 'rgba(56,189,248,0.55)'
            }}
            onMouseLeave={(event) => {
              event.currentTarget.style.background = 'transparent'
              event.currentTarget.style.borderColor = 'transparent'
            }}
          />
        )
      })}
    </div>
  )
}
