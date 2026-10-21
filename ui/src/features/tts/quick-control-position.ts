export interface QuickPosition { x: number; y: number }
export interface QuickPoint { left: number; top: number }
export interface QuickViewport { width: number; height: number; left?: number; top?: number }
export interface QuickSize { width: number; height: number }
export type QuickLayout = 'desktop' | 'compact'

const unit = (value: number) => Math.max(0, Math.min(1, value))
const positionKey = (layout: QuickLayout) => `sealchat:tts:quick-control-position:${layout}:v1`

export function readQuickPosition(layout: QuickLayout): QuickPosition | null {
  try {
    const value = JSON.parse(localStorage.getItem(positionKey(layout)) ?? 'null')
    if (value && typeof value.x === 'number' && Number.isFinite(value.x) && typeof value.y === 'number' && Number.isFinite(value.y)) {
      return { x: unit(value.x), y: unit(value.y) }
    }
  } catch { /* UI preferences also work without browser storage. */ }
  return null
}

export function saveQuickPosition(layout: QuickLayout, position: QuickPosition) {
  try { localStorage.setItem(positionKey(layout), JSON.stringify(position)) } catch { /* Keep the in-memory position. */ }
}

function travel(viewport: QuickViewport, size: QuickSize) {
  const marginX = Math.min(8, Math.max(0, (viewport.width - size.width) / 2))
  const marginY = Math.min(8, Math.max(0, (viewport.height - size.height) / 2))
  return {
    left: (viewport.left ?? 0) + marginX,
    top: (viewport.top ?? 0) + marginY,
    width: Math.max(0, viewport.width - size.width - marginX * 2),
    height: Math.max(0, viewport.height - size.height - marginY * 2),
  }
}

export function clampQuickPoint(point: QuickPoint, viewport: QuickViewport, size: QuickSize): QuickPoint {
  const area = travel(viewport, size)
  return { left: Math.max(area.left, Math.min(point.left, area.left + area.width)), top: Math.max(area.top, Math.min(point.top, area.top + area.height)) }
}

// Coordinates describe the available travel area, excluding the control and safe margins.
export function normalizeQuickPoint(point: QuickPoint, viewport: QuickViewport, size: QuickSize): QuickPosition {
  const area = travel(viewport, size)
  return { x: area.width ? unit((point.left - area.left) / area.width) : 0, y: area.height ? unit((point.top - area.top) / area.height) : 0 }
}

export function restoreQuickPoint(position: QuickPosition, viewport: QuickViewport, size: QuickSize): QuickPoint {
  const area = travel(viewport, size)
  return clampQuickPoint({ left: area.left + area.width * position.x, top: area.top + area.height * position.y }, viewport, size)
}

export function defaultQuickPoint(viewport: QuickViewport, size: QuickSize, layout: QuickLayout): QuickPoint {
  return clampQuickPoint({ left: (viewport.left ?? 0) + viewport.width - size.width - 16, top: (viewport.top ?? 0) + viewport.height - size.height - (layout === 'compact' ? 112 : 140) }, viewport, size)
}
