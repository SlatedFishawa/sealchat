import type Konva from 'konva'
import { shallowReactive } from 'vue'

import type { StageObject } from '../shared/stage-types'
import { stageObjectNodeRenderTransform, type StageNodeRenderTransform, type StageViewportSize } from './stage-coordinate-space'

// Edit-view-only placement of a DOM visual while a Konva drag/transform is in progress, in node render
// units (parent-frame px: world, viewport design or parent-local). Never written to StageStore; the
// coordinate-space module commits the node back to transform.x/y or viewportX/Y.
export type StageDomVisualTransform = StageNodeRenderTransform

// Konva object nodes carry exactly the render transform updateObjectNode sets, so reading them back
// mirrors the DOM style without baking width/height. Keeping width/height untouched during a resize
// means the iframe/text box is only CSS-scaled per frame and reflows once, when the formal transform
// is committed.
export const stageDomVisualTransformFromNode = (node: Konva.Node): StageDomVisualTransform => ({
  x: node.x(),
  y: node.y(),
  rotation: node.rotation(),
  scaleX: node.scaleX(),
  scaleY: node.scaleY(),
})

export const resolveStageDomVisualTransform = (
  object: StageObject,
  objects: Record<string, StageObject>,
  viewport: StageViewportSize,
  previews: Readonly<Record<string, StageDomVisualTransform>> | undefined,
): StageDomVisualTransform => previews?.[object.id] || stageObjectNodeRenderTransform(object, objects, viewport)

export interface StageDomVisualPreviewOptions {
  getNode: (objectId: string) => Konva.Node | undefined
  // Only roots rendered by the DOM visual overlay need a preview; pure canvas objects skip it.
  hasDomVisual: (objectId: string) => boolean
  requestFrame?: (callback: () => void) => number
  cancelFrame?: (handle: number) => void
}

export const createStageDomVisualPreview = ({
  getNode,
  hasDomVisual,
  requestFrame = callback => window.requestAnimationFrame(callback),
  cancelFrame = handle => window.cancelAnimationFrame(handle),
}: StageDomVisualPreviewOptions) => {
  const transforms = shallowReactive<Record<string, StageDomVisualTransform>>({})
  // DOM-visual membership cannot change mid-gesture; cache it until the gesture clears.
  const domVisualIds = new Map<string, boolean>()
  const pendingIds = new Set<string>()
  let frame: number | null = null

  const flush = () => {
    frame = null
    pendingIds.forEach((objectId) => {
      const node = getNode(objectId)
      if (node) transforms[objectId] = stageDomVisualTransformFromNode(node)
    })
    pendingIds.clear()
  }

  // Coalesces high-frequency dragmove/transform events into one sync per animation frame.
  const schedule = (objectIds: Iterable<string>) => {
    for (const objectId of objectIds) {
      let domVisual = domVisualIds.get(objectId)
      if (domVisual === undefined) {
        domVisual = hasDomVisual(objectId)
        domVisualIds.set(objectId, domVisual)
      }
      if (domVisual) pendingIds.add(objectId)
    }
    if (pendingIds.size && frame === null) frame = requestFrame(flush)
  }

  // Call in the same task as the formal commit/cancel so the next render uses store state.
  const clear = () => {
    if (frame !== null) cancelFrame(frame)
    frame = null
    pendingIds.clear()
    domVisualIds.clear()
    Object.keys(transforms).forEach((objectId) => {
      delete transforms[objectId]
    })
  }

  return { transforms, schedule, clear }
}
