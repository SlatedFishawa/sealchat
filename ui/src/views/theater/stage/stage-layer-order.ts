import { normalizeStageObjectCoordinateSpace, type StageObject, type StageObjectCoordinateSpace } from '../shared/stage-types'

const finiteLayerValue = (value: number) => Number.isFinite(value) ? value : 0
const compareObjectIds = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0

export const compareStageLayersBottomToTop = (left: StageObject, right: StageObject) => (
  finiteLayerValue(left.transform.z) - finiteLayerValue(right.transform.z)
  || finiteLayerValue(left.transform.order) - finiteLayerValue(right.transform.order)
  || compareObjectIds(left.id, right.id)
)

export const compareStageLayersTopToBottom = (left: StageObject, right: StageObject) => (
  -compareStageLayersBottomToTop(left, right)
)

const OBJECT_ROOT_LAYER_Z_BASE = 100

export const stageObjectHasDomVisualDescendant = (
  object: StageObject,
  objects: Record<string, StageObject>,
  visited = new Set<string>(),
): boolean => {
  if (object.type === 'text' || object.type === 'iframe') return true
  if (visited.has(object.id)) return false
  visited.add(object.id)
  return Object.values(objects).some((child) => (
    child.parentId === object.id && stageObjectHasDomVisualDescendant(child, objects, visited)
  ))
}

export interface StageObjectRenderBandPlan {
  roots: StageObject[]
  canvasZIndex: number
  // World bands follow the scene camera; viewport bands use the viewport frame. Band 0 is always world.
  space: StageObjectCoordinateSpace
}

export const planStageObjectRenderBands = (objects: Record<string, StageObject>) => {
  const roots = Object.values(objects)
    .filter((object) => !object.parentId || !objects[object.parentId])
    .sort(compareStageLayersBottomToTop)
  const bands: StageObjectRenderBandPlan[] = [{ roots: [], canvasZIndex: OBJECT_ROOT_LAYER_Z_BASE, space: 'world' }]
  const rootStackingOrder: Record<string, number> = {}
  roots.forEach((object, index) => {
    const space = normalizeStageObjectCoordinateSpace(object.coordinateSpace, object.type)
    const current = bands[bands.length - 1]
    if (current.space !== space) {
      // A band opened after a DOM visual is still empty and can take the next root's space;
      // band 0 keeps hosting the world grid/camera, so a leading viewport root opens a new band.
      if (bands.length > 1 && !current.roots.length) current.space = space
      else bands.push({ roots: [], canvasZIndex: OBJECT_ROOT_LAYER_Z_BASE + index * 2, space })
    }
    bands[bands.length - 1].roots.push(object)
    rootStackingOrder[object.id] = OBJECT_ROOT_LAYER_Z_BASE + index * 2 + 1
    // The root's canvas stays below its DOM visual. Only the next root starts a band.
    if (index < roots.length - 1 && stageObjectHasDomVisualDescendant(object, objects)) {
      bands.push({ roots: [], canvasZIndex: OBJECT_ROOT_LAYER_Z_BASE + (index + 1) * 2, space })
    }
  })
  return { bands, rootStackingOrder }
}

export interface StageLayerRank {
  z: number
  order: number
}

export const stageLayerRankBetween = (
  above: StageObject | undefined,
  below: StageObject | undefined,
): StageLayerRank | null => {
  if (above && below) {
    if (above.transform.z > below.transform.z) {
      const z = (above.transform.z + below.transform.z) / 2
      if (Number.isFinite(z) && z !== above.transform.z && z !== below.transform.z) return { z, order: z }
    } else if (above.transform.z === below.transform.z && above.transform.order > below.transform.order) {
      const order = (above.transform.order + below.transform.order) / 2
      if (Number.isFinite(order) && order !== above.transform.order && order !== below.transform.order) {
        return { z: above.transform.z, order }
      }
    }
    return null
  }

  const z = above ? above.transform.z - 1 : below ? below.transform.z + 1 : 1
  return Number.isFinite(z) ? { z, order: z } : null
}
