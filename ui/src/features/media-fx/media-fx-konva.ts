import Konva from 'konva'
import type { Filter as KonvaFilter } from 'konva/lib/Node'

import {
  mediaFxAdvancedHasContent,
  mediaFxAdvancedKeys,
  mediaFxFilterToCss,
  mediaFxTemporalHasContent,
  normalizeMediaFxSpec,
  prefersReducedMotion,
  resolveMediaFxMotionTrack,
  type MediaFxAdvanced,
  type MediaFxFilter,
  type MediaFxMotionFrame,
  type MediaFxMotionTrack,
  type MediaFxTemporal,
} from './media-fx'
import { canvasFilterSupported } from './media-fx-canvas'
import { createMediaFxGpuFilter, mediaFxGpuSupported } from './media-fx-gpu'
import {
  createMediaFxLiveRenderer,
  resolveMediaFxLiveRaster,
  type MediaFxLiveRenderer,
  type MediaFxLiveRendererOptions,
} from './media-fx-live'
import {
  createMediaFxTemporalPlayer,
  presentMediaFxTemporalFrame,
  resolveMediaFxTemporalRaster,
  type MediaFxTemporalPlayer,
  type MediaFxTemporalPlayerOptions,
} from './media-fx-temporal'

// Konva adapter.
//
// Layering contract:
//   object root group  -> business layout / drag / transformer / entrance tweens
//   motionNode (inner) -> Media FX motion only (x/y/scale around the content center)
//   imageNode          -> Media FX filters (cached, static images only); when the
//                         consumer enables `advanced`, the WebGL2 pass runs as the
//                         last step of the same cache filter chain. When the consumer
//                         enables `temporal`, live frames are drawn in place of the
//                         node's cached canvas (see createKonvaMediaFxTemporalController)
//   live output node   -> animated media playing through an HTMLVideoElement never enters
//                         the cache: a separate output node next to the source shows the
//                         processed frames (see createKonvaMediaFxLiveController) while the
//                         source node keeps the video, its size and lifecycle
//
// The controller never touches the root group, so continuous motion cannot fight
// with drag, rotation, entrance tweens or persisted object.transform values.

export interface KonvaMediaFxNodes {
  motionNode: Konva.Group
  imageNode?: Konva.Image | null
  // Called only when a non-looping motion reaches its natural end.
  onMotionComplete?: () => void
}

export interface KonvaMediaFxContext {
  // Content box of motionNode in its parent coordinates (0,0 .. width,height).
  width: number
  height: number
  motion?: boolean
  // Must be false for animated images / video: cache() would freeze one frame.
  filters?: boolean
  // Advanced GPU pixel effects; requires filters and is opt-in per consumer.
  advanced?: boolean
  // Temporal live pixel effects; requires filters and is opt-in per consumer. Paused /
  // reduced motion stop it like motion, the static look stays.
  temporal?: boolean
  paused?: boolean
  reducedMotion?: boolean
}

export interface KonvaMediaFxController {
  update(spec: unknown, context: KonvaMediaFxContext): void
  // Re-evaluates the filter cache after the image source or its fit changed.
  refreshFilter(): void
  isMotionActive(): boolean
  clear(): void
  dispose(): void
}

const MAX_CACHE_PIXEL_RATIO = 3
const MAX_CACHE_EDGE_PX = 4096
const MIN_SEGMENT_SECONDS = 1 / 60

const sourceIds = new WeakMap<object, number>()
let sourceSequence = 0
const sourceIdentity = (source: unknown) => {
  if (!source || typeof source !== 'object') return 0
  let id = sourceIds.get(source)
  if (!id) {
    id = ++sourceSequence
    sourceIds.set(source, id)
  }
  return id
}

const sourceWidth = (source: CanvasImageSource | undefined) => {
  if (!source) return 0
  if (typeof HTMLImageElement !== 'undefined' && source instanceof HTMLImageElement) return source.naturalWidth || source.width
  if (typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement) return source.videoWidth
  const candidate = source as { width?: unknown }
  return typeof candidate.width === 'number' ? candidate.width : 0
}

// Fallback for browsers without CanvasRenderingContext2D.filter: only Konva built-in
// filters with a stable mapping are used. Partial grayscale / sepia have no
// one-to-one built-in equivalent and are skipped in this mode.
const fallbackKonvaFilters = (imageNode: Konva.Image, filter: MediaFxFilter) => {
  const filters: KonvaFilter[] = []
  if (filter.brightness !== 1) {
    imageNode.brightness(filter.brightness)
    filters.push(Konva.Filters.Brightness)
  }
  if (filter.contrast !== 1) {
    imageNode.contrast(100 * (Math.sqrt(filter.contrast) - 1))
    filters.push(Konva.Filters.Contrast)
  }
  if (filter.saturation !== 1 || filter.hueRotate !== 0) {
    imageNode.saturation(Math.max(-8, Math.log2(Math.max(0.004, filter.saturation))))
    imageNode.hue(filter.hueRotate)
    imageNode.luminance(0)
    filters.push(Konva.Filters.HSL)
  }
  if (filter.grayscale >= 1) filters.push(Konva.Filters.Grayscale)
  if (filter.sepia >= 1) filters.push(Konva.Filters.Sepia)
  if (filter.blurPx > 0) {
    imageNode.blurRadius(Math.round(filter.blurPx))
    filters.push(Konva.Filters.Blur)
  }
  return filters
}

// Canvas2D CSS filter applied to the filter ImageData. Only used when a function step
// (the GPU pass) follows: Konva would otherwise run string filters through its own
// limited CSS fallback parser instead of the native canvas filter.
let cssScratch: { source: HTMLCanvasElement, target: HTMLCanvasElement } | null = null
const cssImageDataFilter = (css: string): KonvaFilter => (imageData) => {
  if (typeof document === 'undefined') return
  cssScratch ??= { source: document.createElement('canvas'), target: document.createElement('canvas') }
  const { source, target } = cssScratch
  const { width, height } = imageData
  source.width = target.width = width
  source.height = target.height = height
  const sourceContext = source.getContext('2d')
  const targetContext = target.getContext('2d', { willReadFrequently: true })
  if (sourceContext && targetContext) {
    sourceContext.putImageData(imageData, 0, 0)
    targetContext.filter = css
    targetContext.drawImage(source, 0, 0)
    targetContext.filter = 'none'
    imageData.data.set(targetContext.getImageData(0, 0, width, height).data)
  }
  source.width = source.height = target.width = target.height = 1
}

export const mediaFxAdvancedSignature = (advanced: MediaFxAdvanced) => (
  mediaFxAdvancedKeys.map((key) => advanced[key]).join('|')
)

// Basic Media FX first, advanced GPU pixel effect last.
export const composeKonvaMediaFxFilters = (basic: KonvaFilter[], gpu: KonvaFilter | null): KonvaFilter[] => (
  gpu ? [...basic, gpu] : basic
)

// ---------------------------------------------------------------------------
// Temporal live output on a cached Konva.Image
// ---------------------------------------------------------------------------

export interface KonvaMediaFxTemporalController {
  // Call after the image node cache was rebuilt or cleared: the static final look (the
  // temporal baseline) changed. The next update() reads it again.
  invalidateBaseline(): void
  // `active` is the consumer's gate (capability, pause, reduced motion, ...). Live output
  // additionally needs a cached node and at least one temporal effect.
  update(temporal: MediaFxTemporal | null | undefined, active: boolean): void
  readonly live: boolean
  dispose(): void
}

export interface KonvaMediaFxTemporalDeps {
  createPlayer?: (options: MediaFxTemporalPlayerOptions) => MediaFxTemporalPlayer
  createCanvas?: () => HTMLCanvasElement
}

// The cached canvas of a Konva node is its static final look (basic filters + the
// advanced GPU step, or just the scene when it has no filter), so it is reused as the
// temporal baseline: one downscaled copy per cache rebuild, uploaded once by the shared
// GPU session. Live frames are drawn exactly where Konva draws the cached canvas, with
// the node's own opacity / composite operation, so the node keeps its transform, hit
// region, z-order and Layer; only that Layer is redrawn per frame. Konva cache and
// filters are never rebuilt for a temporal frame.
export const createKonvaMediaFxTemporalController = (
  imageNode: Konva.Image,
  deps: KonvaMediaFxTemporalDeps = {},
): KonvaMediaFxTemporalController => {
  const createCanvas = deps.createCanvas ?? (() => document.createElement('canvas'))
  let output: HTMLCanvasElement | null = null
  let baselineDirty = true
  let installed = false
  let disposed = false

  const requestDraw = () => imageNode.getLayer()?.batchDraw()

  function drawLiveCachedCanvas(this: Konva.Image, context: Konva.Context) {
    const cache = this._getCanvasCache()
    const scene = cache?.scene as { width: number, height: number, pixelRatio: number } | undefined
    if (!output || !scene) {
      Konva.Image.prototype._drawCachedSceneCanvas.call(this, context)
      return
    }
    const ratio = scene.pixelRatio || 1
    context.save()
    context._applyOpacity(this)
    context._applyGlobalCompositeOperation(this)
    context.translate(cache.x, cache.y)
    context.drawImage(output, 0, 0, scene.width / ratio, scene.height / ratio)
    context.restore()
  }

  const install = () => {
    if (installed) return
    installed = true
    imageNode._drawCachedSceneCanvas = drawLiveCachedCanvas
  }

  const uninstall = () => {
    if (!installed) return
    installed = false
    delete (imageNode as unknown as { _drawCachedSceneCanvas?: unknown })._drawCachedSceneCanvas
  }

  const player = (deps.createPlayer ?? createMediaFxTemporalPlayer)({
    present: (frame) => {
      output ??= createCanvas()
      if (!presentMediaFxTemporalFrame(output, frame)) return false
      install()
      requestDraw()
      return true
    },
    onLiveChange: (live) => {
      if (live) return
      uninstall()
      requestDraw()
    },
    canRender: () => imageNode.isCached() && imageNode.isVisible() && Boolean(imageNode.getLayer()),
  })

  const readBaseline = () => {
    baselineDirty = false
    if (!imageNode.isCached()) {
      player.setBaseline(null)
      return
    }
    // Same lazily filtered canvas Konva draws next; reading it here does not filter twice.
    const cached = imageNode._getCachedSceneCanvas()
    const ratio = cached.pixelRatio || 1
    const raster = resolveMediaFxTemporalRaster(
      cached.width / ratio,
      cached.height / ratio,
      Math.min(ratio, Konva.pixelRatio || 1),
    )
    const baseline = raster ? createCanvas() : null
    const drawContext = baseline?.getContext('2d')
    if (!raster || !baseline || !drawContext) {
      player.setBaseline(null)
      return
    }
    baseline.width = raster.width
    baseline.height = raster.height
    drawContext.drawImage(cached._canvas, 0, 0, raster.width, raster.height)
    player.setBaseline({ source: baseline, width: raster.width, height: raster.height, pixelRatio: raster.pixelRatio })
  }

  return {
    invalidateBaseline() {
      if (disposed) return
      baselineDirty = true
      // Never stretch a frame of the previous geometry over the new cache.
      uninstall()
    },
    update(temporal, active) {
      if (disposed) return
      const run = active && mediaFxTemporalHasContent(temporal) && imageNode.isCached()
      if (run && baselineDirty) readBaseline()
      player.update({ temporal, active: run })
    },
    get live() {
      return player.live
    },
    dispose() {
      if (disposed) return
      disposed = true
      uninstall()
      player.dispose()
      if (output) output.width = output.height = 0
      output = null
    },
  }
}

export const createKonvaMediaFxController = (nodes: KonvaMediaFxNodes): KonvaMediaFxController => {
  const { motionNode, onMotionComplete } = nodes
  const imageNode = nodes.imageNode || null
  let filter: MediaFxFilter | null = null
  let filtersEnabled = true
  let advanced: MediaFxAdvanced | null = null
  let advancedEnabled = false
  let temporal: MediaFxTemporal | null = null
  let temporalActive = false
  let temporalController: KonvaMediaFxTemporalController | null = null
  let filterSignature = ''
  let motionSignature = ''
  let track: MediaFxMotionTrack | null = null
  let tween: Konva.Tween | null = null
  let segmentToken = 0
  let layout = { width: 0, height: 0 }
  let disposed = false

  const requestDraw = () => motionNode.getLayer()?.batchDraw()

  const applyLayout = (width: number, height: number) => {
    if (layout.width === width && layout.height === height) return
    layout = { width, height }
    motionNode.setAttrs({ offsetX: width / 2, offsetY: height / 2 })
    if (!tween) applyFrame(null)
  }

  const applyFrame = (frame: Pick<MediaFxMotionFrame, 'x' | 'y' | 'scale'> | null) => {
    motionNode.setAttrs({
      x: layout.width / 2 + (frame ? frame.x * layout.width : 0),
      y: layout.height / 2 + (frame ? frame.y * layout.height : 0),
      scaleX: frame?.scale ?? 1,
      scaleY: frame?.scale ?? 1,
    })
  }

  const stopMotion = () => {
    segmentToken += 1
    tween?.destroy()
    tween = null
    track = null
    motionSignature = ''
    applyFrame(null)
  }

  const playSegment = (index: number, token: number) => {
    if (disposed || token !== segmentToken || !track) return
    const from = track.frames[index]
    const to = track.frames[index + 1]
    if (!from) return
    if (!to) {
      if (track.loop) playSegment(0, token)
      else {
        tween?.destroy()
        tween = null
        track = null
        applyFrame(null)
        requestDraw()
        onMotionComplete?.()
      }
      return
    }
    tween?.destroy()
    applyFrame(from)
    const current = new Konva.Tween({
      node: motionNode,
      duration: Math.max(MIN_SEGMENT_SECONDS, ((to.offset - from.offset) * track.durationMs) / 1_000),
      easing: track.easing === 'linear' ? Konva.Easings.Linear : Konva.Easings.EaseInOut,
      x: layout.width / 2 + to.x * layout.width,
      y: layout.height / 2 + to.y * layout.height,
      scaleX: to.scale,
      scaleY: to.scale,
      onUpdate: requestDraw,
      onFinish: () => {
        if (tween !== current) return
        playSegment(index + 1, token)
      },
    })
    tween = current
    current.play()
  }

  const applyMotion = (spec: ReturnType<typeof normalizeMediaFxSpec>, context: KonvaMediaFxContext) => {
    const reduced = context.reducedMotion ?? prefersReducedMotion()
    const nextTrack = context.motion === false || context.paused || reduced ? null : resolveMediaFxMotionTrack(spec.motion)
    const signature = nextTrack
      ? `${spec.motion.preset}|${spec.motion.intensity}|${spec.motion.durationMs}|${spec.motion.loop}|${layout.width}x${layout.height}`
      : ''
    // Same spec: keep the running loop and never replay a finished one-shot motion.
    if (signature === motionSignature) return
    stopMotion()
    if (!nextTrack) {
      requestDraw()
      return
    }
    motionSignature = signature
    track = nextTrack
    playSegment(0, segmentToken)
  }

  const applyFilter = () => {
    if (!imageNode) return
    const source = imageNode.image() as CanvasImageSource | undefined
    const css = filter && filtersEnabled && source ? mediaFxFilterToCss(filter) : ''
    // WebGL2 support is checked independently of Canvas2D filter support.
    const gpuAdvanced = advanced && advancedEnabled && filtersEnabled && source
      && mediaFxAdvancedHasContent(advanced) && mediaFxGpuSupported()
      ? advanced
      : null
    // Live temporal output needs a cached static look even without any static filter.
    const temporalBaseline = Boolean(temporalActive && source)
    const signature = css || gpuAdvanced || temporalBaseline
      ? [
          css,
          gpuAdvanced ? mediaFxAdvancedSignature(gpuAdvanced) : '',
          sourceIdentity(source),
          imageNode.width(),
          imageNode.height(),
          imageNode.cropX(),
          imageNode.cropY(),
          imageNode.cropWidth(),
          imageNode.cropHeight(),
        ].join('|')
      : ''
    // cache() only reruns when the filter, the source or the fitted geometry changed.
    if (signature === filterSignature) return
    const hadFilter = Boolean(filterSignature)
    filterSignature = signature
    if (!css && !gpuAdvanced && !temporalBaseline) {
      if (hadFilter) {
        imageNode.clearCache()
        imageNode.filters([])
        temporalController?.invalidateBaseline()
        requestDraw()
      }
      return
    }
    imageNode.clearCache()
    const nodeWidth = Math.max(1, imageNode.width())
    const nodeHeight = Math.max(1, imageNode.height())
    const sourceEdge = imageNode.cropWidth() || sourceWidth(source)
    const pixelRatio = Math.max(0.25, Math.min(
      MAX_CACHE_PIXEL_RATIO,
      MAX_CACHE_EDGE_PX / Math.max(nodeWidth, nodeHeight),
      Math.max(Konva.pixelRatio || 1, sourceEdge / nodeWidth, 1),
    ))
    const gpuFilter = gpuAdvanced ? createMediaFxGpuFilter(gpuAdvanced, { pixelRatio }) : null
    let basic: KonvaFilter[] = []
    if (css) {
      if (!canvasFilterSupported()) basic = fallbackKonvaFilters(imageNode, filter!)
      else basic = [gpuFilter ? cssImageDataFilter(css) : css]
    }
    imageNode.filters(composeKonvaMediaFxFilters(basic, gpuFilter))
    imageNode.cache({ pixelRatio })
    temporalController?.invalidateBaseline()
    requestDraw()
  }

  const applyTemporal = () => {
    if (!imageNode) return
    if (temporalActive && !temporalController) {
      temporalController = createKonvaMediaFxTemporalController(imageNode)
    }
    // Hidden Konva targets keep their warm baseline but leave the page-wide clock, so
    // an otherwise idle scene has zero Media FX RAF work. canRender remains the cheap
    // per-tick safety gate for visibility changes between controller updates.
    temporalController?.update(temporal, temporalActive && imageNode.isVisible())
  }

  const clear = () => {
    stopMotion()
    filter = null
    advanced = null
    temporal = null
    temporalActive = false
    applyFilter()
    temporalController?.dispose()
    temporalController = null
  }

  return {
    update(input, context) {
      if (disposed) return
      const spec = normalizeMediaFxSpec(input)
      applyLayout(Math.max(0, context.width), Math.max(0, context.height))
      filter = spec.filter
      filtersEnabled = context.filters !== false
      advanced = spec.advanced
      advancedEnabled = context.advanced === true
      temporal = spec.temporal
      // Temporal is a dynamic effect: pause and reduced motion stop it like motion.
      temporalActive = Boolean(imageNode)
        && context.temporal === true
        && filtersEnabled
        && !context.paused
        && !(context.reducedMotion ?? prefersReducedMotion())
        && mediaFxTemporalHasContent(spec.temporal)
        && mediaFxGpuSupported()
      applyFilter()
      applyTemporal()
      applyMotion(spec, context)
    },
    refreshFilter() {
      if (disposed) return
      applyFilter()
      applyTemporal()
    },
    isMotionActive() {
      return Boolean(track)
    },
    clear,
    dispose() {
      if (disposed) return
      clear()
      disposed = true
    },
  }
}

// ---------------------------------------------------------------------------
// Live media output (video sources): a separate render node
// ---------------------------------------------------------------------------

export interface KonvaMediaFxLiveInput {
  // The playing source of the original node; null while there is none / it is no video.
  video: HTMLVideoElement | null
  sourceKey: string
  // Signature of the geometry / filters `stage` draws besides the video frame.
  stageKey: string
  // Content rect of the output node in its parent's coordinates (= the source's drawn rect).
  rect: { x: number, y: number, width: number, height: number }
  // Device pixels per unit of `rect` (Konva.pixelRatio x the absolute display scale).
  displayScale: number
  opacity?: number
  basic?: boolean
  advanced: MediaFxAdvanced | null | undefined
  temporal: MediaFxTemporal | null | undefined
  active: boolean
}

export interface KonvaMediaFxLiveController {
  update(input: KonvaMediaFxLiveInput): void
  readonly live: boolean
  readonly outputNode: Konva.Image
  dispose(): void
}

export interface KonvaMediaFxLiveOptions {
  // The output node is inserted right above this node, in the same parent (so it shares
  // the motion group and clip of the source).
  sourceNode: Konva.Node
  // Draws the current frame (geometry + filters) into the staging raster.
  stage: MediaFxLiveRendererOptions<HTMLVideoElement>['stage']
  // Suppresses / restores drawing of the original source while live output is shown. The
  // source node keeps its image, size, hit region and lifecycle either way.
  setSourceHidden: (hidden: boolean) => void
  name?: string
  createRenderer?: (options: MediaFxLiveRendererOptions<HTMLVideoElement>) => MediaFxLiveRenderer<HTMLVideoElement>
  createCanvas?: () => HTMLCanvasElement
}

// Live output for an animated Konva source (Stage objects and surfaces): the original
// node keeps decoding / looping / sizing the video and stays the fallback; the output node
// only displays processed frames (copied from the shared GPU canvas into its own canvas).
// It is shown only after the first frame was presented, and hidden again on any stop or
// failure. It never uses cache(): animated sources never reach the static filter path.
export const createKonvaMediaFxLiveController = (options: KonvaMediaFxLiveOptions): KonvaMediaFxLiveController => {
  const createCanvas = options.createCanvas ?? (() => document.createElement('canvas'))
  const outputNode = new Konva.Image({
    name: options.name ?? 'media-fx-live-output',
    image: undefined,
    visible: false,
    listening: false,
  })
  const parent = options.sourceNode.getParent()
  if (parent) {
    parent.add(outputNode)
    outputNode.zIndex(options.sourceNode.zIndex() + 1)
  }
  let output: HTMLCanvasElement | null = null
  let disposed = false

  const requestDraw = () => outputNode.getLayer()?.batchDraw()

  const renderer = (options.createRenderer ?? createMediaFxLiveRenderer)({
    stage: options.stage,
    present: (frame) => {
      output ??= createCanvas()
      if (!presentMediaFxTemporalFrame(output, frame)) return false
      if (outputNode.image() !== output) outputNode.image(output)
      requestDraw()
      return true
    },
    onLiveChange: (live) => {
      if (disposed) return
      outputNode.visible(live)
      options.setSourceHidden(live)
      if (!live && output) {
        // Never keep (or later flash) a frame of a previous source.
        output.width = output.height = 0
        outputNode.image(undefined)
        output = null
      }
      requestDraw()
    },
    canRender: () => Boolean(outputNode.getLayer()) && Boolean(outputNode.getParent()?.isVisible()),
  })

  return {
    update(input) {
      if (disposed) return
      const { rect } = input
      outputNode.position({ x: rect.x, y: rect.y })
      outputNode.size({ width: rect.width, height: rect.height })
      outputNode.opacity(input.opacity ?? 1)
      renderer.update({
        video: input.video,
        sourceKey: input.sourceKey,
        stageKey: input.stageKey,
        raster: resolveMediaFxLiveRaster(rect.width, rect.height, input.displayScale),
        basic: input.basic,
        advanced: input.advanced,
        temporal: input.temporal,
        active: input.active,
      })
    },
    get live() {
      return renderer.live
    },
    outputNode,
    dispose() {
      if (disposed) return
      const wasLive = renderer.live
      disposed = true
      renderer.dispose()
      if (wasLive) options.setSourceHidden(false)
      if (output) output.width = output.height = 0
      output = null
      const layer = outputNode.getLayer()
      outputNode.destroy()
      layer?.batchDraw()
    },
  }
}

// Device pixels per local unit of a Konva node (Konva.pixelRatio x absolute scale).
export const konvaMediaFxDisplayScale = (node: Konva.Node) => {
  const scale = node.getAbsoluteScale()
  const ratio = Konva.pixelRatio || 1
  const value = Math.max(Math.abs(scale.x), Math.abs(scale.y)) * ratio
  return Number.isFinite(value) && value > 0 ? value : ratio
}
