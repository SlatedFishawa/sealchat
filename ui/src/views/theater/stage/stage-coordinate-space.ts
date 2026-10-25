import {
  STAGE_VIEWPORT_DESIGN_HEIGHT,
  STAGE_VIEWPORT_DESIGN_WIDTH,
  STAGE_VIEWPORT_POSITION_MIN,
  STAGE_VIEWPORT_POSITION_MAX,
  WORLD_UNIT_PX,
  normalizeStageObjectCoordinateSpace,
  normalizeStageViewportPosition,
  type StageObject,
  type StageObjectCoordinateSpace,
} from '../shared/stage-types'

export interface StagePoint {
  x: number
  y: number
}

export interface StageViewportSize {
  width: number
  height: number
}

// Konva absolute transform of the world camera group (world px <-> stage px). StageApp builds it from
// worldCameraGroup.getAbsoluteTransform() and its inverse, so the camera formula lives only in Konva.
export interface StageWorldCameraTransform {
  worldToScreen: (point: StagePoint) => StagePoint
  screenToWorld: (point: StagePoint) => StagePoint
  scale: number
}

// Node attrs in the parent frame of a Konva object node (and of its DOM visual): world px for world
// roots, viewport design px for viewport roots, parent-local px for descendants.
export interface StageNodeRenderTransform {
  x: number
  y: number
  rotation: number
  scaleX: number
  scaleY: number
}

// Absolute pose in stage px, as Konva absolutePosition/getAbsoluteRotation/getAbsoluteScale report it.
export type StageScreenPose = StageNodeRenderTransform

export interface StageRootPose {
  coordinateSpace: StageObjectCoordinateSpace
  // Written to object.transform; x/y are omitted for viewport roots, whose position is viewportX/Y.
  transform: Pick<StageObject['transform'], 'rotation' | 'scaleX' | 'scaleY'> & Partial<Pick<StageObject['transform'], 'x' | 'y'>>
  viewportX?: number
  viewportY?: number
}

const round = (value: number) => Number(value.toFixed(6))
export interface StageCoordinateSpaceFailure {
  error: 'scale-out-of-range' | 'position-out-of-range'
}

export const stageViewportScale = (viewport: StageViewportSize) => {
  const scale = Math.min(viewport.width / STAGE_VIEWPORT_DESIGN_WIDTH, viewport.height / STAGE_VIEWPORT_DESIGN_HEIGHT)
  return Number.isFinite(scale) && scale > 0 ? scale : 1
}

// Viewport bands use no scene camera: origin at the viewport corner, uniform design scale only.
export const stageViewportBandCamera = (viewport: StageViewportSize) => {
  const scale = stageViewportScale(viewport)
  return { position: { x: 0, y: 0 }, scale: { x: scale, y: scale } }
}

export const stageObjectIsRoot = (object: StageObject, objects: Record<string, StageObject>) => (
  !object.parentId || !objects[object.parentId]
)

export const stageObjectTreeRoot = (object: StageObject, objects: Record<string, StageObject>) => {
  let root = object
  const visited = new Set<string>([object.id])
  while (root.parentId && objects[root.parentId] && !visited.has(root.parentId)) {
    root = objects[root.parentId]
    visited.add(root.id)
  }
  return root
}

// A root's own field decides the space of its whole tree.
export const stageRootCoordinateSpace = (root: StageObject): StageObjectCoordinateSpace => (
  normalizeStageObjectCoordinateSpace(root.coordinateSpace, root.type)
)

export const stageObjectEffectiveCoordinateSpace = (
  object: StageObject,
  objects: Record<string, StageObject>,
): StageObjectCoordinateSpace => stageRootCoordinateSpace(stageObjectTreeRoot(object, objects))

export const stageViewportPointToScreen = (
  point: Pick<StageObject, 'viewportX' | 'viewportY'>,
  viewport: StageViewportSize,
): StagePoint => ({
  x: normalizeStageViewportPosition(point.viewportX) * viewport.width,
  y: normalizeStageViewportPosition(point.viewportY) * viewport.height,
})

export const stageScreenPointToViewport = (point: StagePoint, viewport: StageViewportSize) => ({
  viewportX: round(normalizeStageViewportPosition(point.x / Math.max(1, viewport.width))),
  viewportY: round(normalizeStageViewportPosition(point.y / Math.max(1, viewport.height))),
})

export const stageObjectNodeRenderTransform = (
  object: StageObject,
  objects: Record<string, StageObject>,
  viewport: StageViewportSize,
): StageNodeRenderTransform => {
  const { rotation, scaleX, scaleY } = object.transform
  if (stageObjectIsRoot(object, objects) && stageRootCoordinateSpace(object) === 'viewport') {
    const scale = stageViewportScale(viewport)
    const screen = stageViewportPointToScreen(object, viewport)
    return { x: screen.x / scale, y: screen.y / scale, rotation, scaleX, scaleY }
  }
  return { x: object.transform.x * WORLD_UNIT_PX, y: object.transform.y * WORLD_UNIT_PX, rotation, scaleX, scaleY }
}

// Writes a node position (parent-frame px) back to the field that owns it for this object.
export const commitStageNodePosition = (
  object: StageObject,
  objects: Record<string, StageObject>,
  position: StagePoint,
  viewport: StageViewportSize,
) => {
  if (stageObjectIsRoot(object, objects) && stageRootCoordinateSpace(object) === 'viewport') {
    const scale = stageViewportScale(viewport)
    Object.assign(object, stageScreenPointToViewport({ x: position.x * scale, y: position.y * scale }, viewport))
    return
  }
  object.transform.x = round(position.x / WORLD_UNIT_PX)
  object.transform.y = round(position.y / WORLD_UNIT_PX)
}

// Pose of a top-level root in the target space that keeps its on-screen position, rotation and size.
export const stageScreenPoseToRootPose = (
  pose: StageScreenPose,
  coordinateSpace: StageObjectCoordinateSpace,
  camera: StageWorldCameraTransform,
  viewport: StageViewportSize,
): StageRootPose | StageCoordinateSpaceFailure => {
  const rotation = round(pose.rotation)
  const scale = coordinateSpace === 'viewport' ? stageViewportScale(viewport) : camera.scale
  const scaleX = pose.scaleX / scale
  const scaleY = pose.scaleY / scale
  if (![scaleX, scaleY].every(value => Number.isFinite(value) && value >= 0.01 && value <= 100)) {
    return { error: 'scale-out-of-range' }
  }
  if (coordinateSpace === 'viewport') {
    const viewportX = pose.x / viewport.width
    const viewportY = pose.y / viewport.height
    if (![viewportX, viewportY].every(value => Number.isFinite(value)
      && value >= STAGE_VIEWPORT_POSITION_MIN && value <= STAGE_VIEWPORT_POSITION_MAX)) {
      return { error: 'position-out-of-range' }
    }
    return {
      coordinateSpace,
      transform: { rotation, scaleX: round(scaleX), scaleY: round(scaleY) },
      viewportX: round(viewportX), viewportY: round(viewportY),
    }
  }
  const world = camera.screenToWorld(pose)
  if (![world.x, world.y].every(Number.isFinite)) return { error: 'position-out-of-range' }
  return {
    coordinateSpace,
    transform: {
      x: round(world.x / WORLD_UNIT_PX),
      y: round(world.y / WORLD_UNIT_PX),
      rotation,
      scaleX: round(scaleX),
      scaleY: round(scaleY),
    },
  }
}

// Screen pose of a top-level root as currently rendered from store state.
export const stageRootScreenPose = (
  root: StageObject,
  camera: StageWorldCameraTransform,
  viewport: StageViewportSize,
): StageScreenPose => {
  const { rotation, scaleX, scaleY } = root.transform
  if (stageRootCoordinateSpace(root) === 'viewport') {
    const scale = stageViewportScale(viewport)
    return { ...stageViewportPointToScreen(root, viewport), rotation, scaleX: scaleX * scale, scaleY: scaleY * scale }
  }
  const screen = camera.worldToScreen({ x: root.transform.x * WORLD_UNIT_PX, y: root.transform.y * WORLD_UNIT_PX })
  return { ...screen, rotation, scaleX: scaleX * camera.scale, scaleY: scaleY * camera.scale }
}

// Visual-stable world <-> viewport switch for a top-level root. Only fields of the target space and the
// root scale change. Reject unrepresentable target poses before editing; null is a no-op.
export const convertStageRootCoordinateSpace = (
  root: StageObject,
  coordinateSpace: StageObjectCoordinateSpace,
  camera: StageWorldCameraTransform,
  viewport: StageViewportSize,
): StageRootPose | StageCoordinateSpaceFailure | null => {
  const target = normalizeStageObjectCoordinateSpace(coordinateSpace, root.type)
  if (target === stageRootCoordinateSpace(root)) return null
  return stageScreenPoseToRootPose(stageRootScreenPose(root, camera, viewport), target, camera, viewport)
}

export const applyStageRootPose = (object: StageObject, pose: StageRootPose) => {
  object.coordinateSpace = pose.coordinateSpace
  Object.assign(object.transform, pose.transform)
  if (pose.viewportX !== undefined) object.viewportX = pose.viewportX
  if (pose.viewportY !== undefined) object.viewportY = pose.viewportY
}
