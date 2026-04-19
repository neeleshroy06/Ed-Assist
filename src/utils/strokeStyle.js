/**
 * Canvas stroke style for an annotation, used by both the professor's
 * editable canvas and the student's read-only annotated viewer.
 */
export function strokeStyle(stroke) {
  if (stroke?.tool === 'highlighter') {
    return {
      stroke: 'rgba(245, 198, 24, 0.38)',
      strokeWidth: (stroke.width || 12) * 2.5,
      globalCompositeOperation: 'multiply',
    }
  }
  return {
    stroke: stroke?.color || '#38bdf8',
    strokeWidth: stroke?.width || 4,
    globalCompositeOperation: 'source-over',
  }
}

/** Draw a single stroke (normalized [0,1] points) onto a canvas 2D context. */
export function drawStrokeOnCanvas(context, stroke, width, height) {
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
    const x = point.x * width
    const y = point.y * height
    if (index === 0) context.moveTo(x, y)
    else context.lineTo(x, y)
  })
  context.stroke()
  context.restore()
}
