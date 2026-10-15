import {
  mediaFxAdvancedHasContent,
  mediaFxAdvancedKeys,
  mediaFxTemporalHasContent,
  mediaFxTemporalKeys,
  normalizeMediaFxAdvanced,
  normalizeMediaFxTemporal,
  type MediaFxAdvanced,
  type MediaFxTemporal,
} from './media-fx'
import {
  createMediaFxLiveGpuSession,
  mediaFxGpuSupported,
  type MediaFxLiveGpuSession,
  type MediaFxTemporalGpuFrame,
} from './media-fx-gpu'
import {
  mediaFxTemporalClock,
  resolveMediaFxTemporalRaster,
  type MediaFxTemporalClock,
  type MediaFxTemporalRaster,
  type MediaFxTemporalTick,
} from './media-fx-temporal'

// Live Media FX for media that already plays through an HTMLVideoElement (videos and the
// transparent WebM playback variant of animated images). One renderer per visual; every
// renderer shares the page-wide GPU processor (media-fx-gpu) and temporal clock.
//
// Pixel order of every live frame:
//   video frame -> consumer geometry (fit / crop / surface rect) + basic filter, drawn by
//   the consumer's `stage` into a Canvas2D staging raster (native canvas filter, no CPU
//   pixel access) -> advanced GPU -> temporal GPU -> `present` (an immediate copy of the
//   shared GPU canvas into the consumer's own output).
// Motion is never part of this: it stays on the consumer's wrapper / motion group.
//
// Scheduling:
// - advanced only: a frame is processed only when the video produced a new frame
//   (requestVideoFrameCallback), or when the geometry / filter / params changed;
// - temporal on: the shared temporal clock draws (at most its max fps); a new video frame
//   only marks the source dirty, so ticks between two video frames reuse the uploaded
//   texture and the advanced result;
// - without requestVideoFrameCallback the shared clock polls `currentTime` instead (no
//   per-visual RAF loop).
// Nothing runs while the visual is inactive (paused, off screen, hidden page), and no
// work at all exists while neither advanced nor temporal has content.
//
// Failures (GPU unavailable, context loss, raster too large, a staging step that cannot
// reproduce the basic filter, ...) turn live output off: the consumer shows its original
// media again with its existing CSS basic filter / motion. The stored spec is untouched;
// a new source, geometry or spec tries again.

// Live frames are processed many times per second: the raster follows the displayed size
// x DPR within this budget, never the (possibly 4K) source resolution.
export const MEDIA_FX_LIVE_MAX_RASTER_PIXELS = 1920 * 1080
export const MEDIA_FX_LIVE_MAX_RASTER_EDGE = 2048

export const resolveMediaFxLiveRaster = (
  layoutWidth: number,
  layoutHeight: number,
  devicePixelRatio: number,
): MediaFxTemporalRaster | null => resolveMediaFxTemporalRaster(layoutWidth, layoutHeight, devicePixelRatio, {
  maxPixels: MEDIA_FX_LIVE_MAX_RASTER_PIXELS,
  maxEdge: MEDIA_FX_LIVE_MAX_RASTER_EDGE,
})

// HAVE_CURRENT_DATA: a frame can be drawn.
const HAVE_CURRENT_DATA = 2

// The part of HTMLVideoElement the renderer reads.
export interface MediaFxLiveVideo {
  readonly readyState: number
  readonly videoWidth: number
  readonly videoHeight: number
  readonly currentTime: number
  requestVideoFrameCallback?: (callback: (now: number, metadata: unknown) => void) => number
  cancelVideoFrameCallback?: (handle: number) => void
}

export interface MediaFxLiveRendererOptions<TVideo extends MediaFxLiveVideo = MediaFxLiveVideo> {
  // Draws the current frame of `video` into the cleared staging context (raster size):
  // the consumer's geometry and basic filter. false when it cannot do so faithfully, e.g.
  // a basic filter without Canvas2D filter support; live output then falls back.
  stage: (context: CanvasRenderingContext2D, video: TVideo, raster: MediaFxTemporalRaster) => boolean
  // Copies a finished frame into the consumer's output right away; false when it cannot.
  present: (frame: MediaFxTemporalGpuFrame) => boolean
  // true once a live frame is shown (hide the original media); false when live output
  // stops and the original media must be shown again.
  onLiveChange?: (live: boolean) => void
  // Cheap per-frame gate (e.g. a Konva node hidden by an ancestor).
  canRender?: () => boolean
  clock?: MediaFxTemporalClock
  session?: MediaFxLiveGpuSession
  gpuSupported?: () => boolean
  createCanvas?: () => HTMLCanvasElement
  isHidden?: () => boolean
}

export interface MediaFxLiveRendererInput<TVideo extends MediaFxLiveVideo = MediaFxLiveVideo> {
  // The element that decodes / loops / plays the media; null while there is none (e.g.
  // the consumer shows a static fallback candidate).
  video: TVideo | null
  // Identity of the decoded resource; a new key never shows frames of the previous one.
  sourceKey: string
  // Signature of everything `stage` draws besides the video frame (geometry, basic
  // filter); a change re-stages the current frame.
  stageKey: string
  raster: MediaFxTemporalRaster | null
  // The staging step itself changes the final look (currently Basic filters). This lets
  // the renderer present that staged frame even when no GPU effect is enabled.
  basic?: boolean
  // Already gated by the consumer's capability (null / all-default = off).
  advanced: MediaFxAdvanced | null | undefined
  // Already gated by capability, pause and reduced motion.
  temporal: MediaFxTemporal | null | undefined
  // Visual is active and on screen.
  active: boolean
}

export interface MediaFxLiveRenderer<TVideo extends MediaFxLiveVideo = MediaFxLiveVideo> {
  update(input: MediaFxLiveRendererInput<TVideo>): void
  readonly live: boolean
  readonly running: boolean
  dispose(): void
}

// Advanced or temporal would actually draw something (all-default specs never start a renderer).
export const mediaFxLiveWanted = (
  advanced: MediaFxAdvanced | null | undefined,
  temporal: MediaFxTemporal | null | undefined,
) => mediaFxAdvancedHasContent(advanced) || mediaFxTemporalHasContent(temporal)

const defaultIsHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden'

export const createMediaFxLiveRenderer = <TVideo extends MediaFxLiveVideo = MediaFxLiveVideo>(
  options: MediaFxLiveRendererOptions<TVideo>,
): MediaFxLiveRenderer<TVideo> => {
  const clock = options.clock ?? mediaFxTemporalClock()
  const gpuSupported = options.gpuSupported ?? mediaFxGpuSupported
  const isHidden = options.isHidden ?? defaultIsHidden
  const createCanvas = options.createCanvas ?? (() => document.createElement('canvas'))
  // Lazily created: a renderer that never draws owns no GPU state.
  let session: MediaFxLiveGpuSession | null = options.session ?? null
  let video: TVideo | null = null
  let sourceKey = ''
  let stageKey = ''
  let raster: MediaFxTemporalRaster | null = null
  let rasterKey = ''
  let advanced: MediaFxAdvanced | null = null
  let temporal: MediaFxTemporal | null = null
  let basic = false
  let paramsKey = ''
  let active = false
  let failed = false
  let live = false
  let disposed = false
  // The staging raster holds frame `frameId`; `dirty` = it must be redrawn (new video
  // frame / geometry / filter) before the next draw; `pending` = the shown output is
  // outdated although the staged frame is not (new advanced / temporal params).
  let staging: HTMLCanvasElement | null = null
  let frameId = 0
  let dirty = true
  let pending = true
  let lastVideoTime = Number.NaN
  // Pending requestVideoFrameCallback, bound to the element it was requested on.
  let videoCallback: { video: TVideo, handle: number } | null = null
  let unsubscribe: (() => void) | null = null
  // Speed-scaled temporal time of this visual; it pauses while the renderer does.
  let elapsed = 0

  const setLive = (next: boolean) => {
    if (live === next) return
    live = next
    options.onLiveChange?.(next)
  }

  const wantAdvanced = () => mediaFxAdvancedHasContent(advanced)
  const wantTemporal = () => mediaFxTemporalHasContent(temporal)
  const wantBasic = () => basic
  const wantGpu = () => wantAdvanced() || wantTemporal()

  const shouldRun = () => !disposed
    && active
    && Boolean(video)
    && Boolean(raster)
    && (wantBasic() || wantGpu())
    && !failed
    && (!wantGpu() || gpuSupported())

  const hasFrame = (target: TVideo) => target.readyState >= HAVE_CURRENT_DATA && target.videoWidth > 0 && target.videoHeight > 0
  const playbackActive = (target: TVideo | null) => {
    if (!target) return false
    const state = target as TVideo & { paused?: boolean; ended?: boolean }
    return state.paused !== true && state.ended !== true
  }

  type PlaybackEventTarget = TVideo & {
    addEventListener?: (type: string, listener: () => void) => void
    removeEventListener?: (type: string, listener: () => void) => void
  }
  let playbackEventTarget: PlaybackEventTarget | null = null

  const supportsFrameCallbacks = (target: TVideo | null) => Boolean(
    target
    && typeof target.requestVideoFrameCallback === 'function'
    && typeof target.cancelVideoFrameCallback === 'function',
  )

  const cancelVideoCallback = () => {
    if (!videoCallback) return
    videoCallback.video.cancelVideoFrameCallback?.(videoCallback.handle)
    videoCallback = null
  }

  const unsubscribeClock = () => {
    unsubscribe?.()
    unsubscribe = null
  }

  const onPlaybackStateChange = () => {
    if (disposed || !video || video !== playbackEventTarget) return
    pending = true
    sync()
  }

  const syncPlaybackEvents = () => {
    const target = video as PlaybackEventTarget | null
    if (target === playbackEventTarget) return
    if (playbackEventTarget?.removeEventListener) {
      playbackEventTarget.removeEventListener('play', onPlaybackStateChange)
      playbackEventTarget.removeEventListener('pause', onPlaybackStateChange)
      playbackEventTarget.removeEventListener('ended', onPlaybackStateChange)
    }
    playbackEventTarget = target
    if (playbackEventTarget?.addEventListener) {
      playbackEventTarget.addEventListener('play', onPlaybackStateChange)
      playbackEventTarget.addEventListener('pause', onPlaybackStateChange)
      playbackEventTarget.addEventListener('ended', onPlaybackStateChange)
    }
  }

  const releaseGpu = () => {
    session?.release()
    // The next start re-stages and re-uploads instead of trusting released textures.
    dirty = true
    pending = true
  }

  // Draws the staging raster when dirty, then source -> advanced -> temporal -> present.
  const draw = (withTemporal: boolean) => {
    const target = video
    const size = raster
    if (!target || !size || !hasFrame(target)) return null
    if (dirty || !staging) {
      staging ??= createCanvas()
      if (staging.width !== size.width || staging.height !== size.height) {
        staging.width = size.width
        staging.height = size.height
      }
      const context = staging.getContext('2d')
      if (!context) return false
      context.clearRect(0, 0, size.width, size.height)
      context.save()
      let staged = false
      try {
        staged = options.stage(context, target, size)
      } catch {
        staged = false
      } finally {
        context.restore()
      }
      if (!staged) return false
      frameId += 1
      dirty = false
    }
    pending = false
    if (!wantAdvanced() && !withTemporal) {
      try {
        return Boolean(options.present({ canvas: staging, x: 0, y: 0, width: size.width, height: size.height }))
      } catch {
        return false
      }
    }
    session ??= createMediaFxLiveGpuSession()
    let frame: MediaFxTemporalGpuFrame | null = null
    try {
      frame = session.render(
        { source: staging, width: size.width, height: size.height, pixelRatio: size.pixelRatio, frameId },
        advanced,
        withTemporal ? temporal : null,
        elapsed,
      )
      return Boolean(frame && options.present(frame))
    } catch {
      return false
    }
  }

  const fail = () => {
    failed = true
    stop()
  }

  // One live frame now. Skipped (not failed) while the visual is gated or has no frame.
  const renderFrame = () => {
    if (!shouldRun()) return
    if (isHidden() || (options.canRender && !options.canRender())) return
    const withTemporal = wantTemporal() && playbackActive(video)
    if (!withTemporal && !wantBasic() && !wantAdvanced()) {
      setLive(false)
      return
    }
    const result = draw(withTemporal)
    if (result === null) return
    if (!result) {
      fail()
      return
    }
    setLive(true)
  }

  const watchVideo = () => {
    const target = video
    if (!target || videoCallback || !supportsFrameCallbacks(target) || !playbackActive(target)) return
    const handle = target.requestVideoFrameCallback!(() => {
      if (videoCallback?.video !== target || videoCallback.handle !== handle) return
      videoCallback = null
      if (disposed || video !== target) return
      // A new decoded frame: the staging raster is stale from now on.
      dirty = true
      if (!shouldRun()) return
      // Temporal ticks pick the new frame up; advanced-only draws exactly once per frame.
      if (!wantTemporal()) renderFrame()
      if (shouldRun()) watchVideo()
    })
    videoCallback = { video: target, handle }
  }

  const tick = (frameTick: MediaFxTemporalTick) => {
    if (disposed || !video) return
    if (!playbackActive(video)) {
      pending = true
      sync()
      return
    }
    if (!supportsFrameCallbacks(video)) {
      // Fallback for browsers without requestVideoFrameCallback: detect new frames from
      // the playback position on the shared clock.
      const time = video.currentTime
      if (time !== lastVideoTime) {
        lastVideoTime = time
        dirty = true
      }
    }
    if (wantTemporal()) {
      if (options.canRender && !options.canRender()) return
      elapsed += frameTick.delta * (temporal?.speed ?? 1)
      renderFrame()
      return
    }
    if (dirty || pending) renderFrame()
  }

  function stop() {
    cancelVideoCallback()
    unsubscribeClock()
    if (!live) {
      releaseGpu()
      return
    }
    // Inactive / paused output may keep one processed frame only when Basic or Advanced
    // can produce a complete static look. Temporal is stripped before that frame is kept;
    // temporal-only output returns to the original media.
    const keep = !disposed
      && !failed
      && Boolean(video)
      && Boolean(raster)
      && (wantBasic() || (wantAdvanced() && gpuSupported()))
    let kept = false
    if (keep) {
      const result = wantTemporal() || pending ? draw(false) : true
      kept = result === true
    }
    if (!kept) setLive(false)
    releaseGpu()
  }

  function sync() {
    syncPlaybackEvents()
    if (!shouldRun()) {
      stop()
      return
    }
    if (!playbackActive(video)) {
      stop()
      return
    }
    // Temporal (or a browser without frame callbacks) is driven by the shared clock.
    const useClock = wantTemporal() || !supportsFrameCallbacks(video)
    if (useClock) unsubscribe ??= clock.subscribe(tick)
    else unsubscribeClock()
    watchVideo()
    // A new frame / geometry / params with no clock tick coming is drawn immediately.
    // Paused / ended media has already taken the static stop path above.
    if (!useClock && (dirty || pending)) renderFrame()
  }

  return {
    update(next) {
      if (disposed) return
      const nextVideo = next.video
      const nextAdvanced = mediaFxAdvancedHasContent(next.advanced) ? normalizeMediaFxAdvanced(next.advanced) : null
      const nextTemporal = mediaFxTemporalHasContent(next.temporal) ? normalizeMediaFxTemporal(next.temporal) : null
      const nextBasic = next.basic === true
      const nextRasterKey = next.raster ? `${next.raster.width}x${next.raster.height}@${next.raster.pixelRatio}` : ''
      const nextParamsKey = [
        nextBasic ? 'basic' : '',
        nextAdvanced ? mediaFxAdvancedKeys.map((key) => nextAdvanced[key]).join(',') : '',
        nextTemporal ? mediaFxTemporalKeys.map((key) => nextTemporal[key]).join(',') : '',
      ].join('|')
      if (nextVideo !== video || next.sourceKey !== sourceKey) {
        // Another resource: never let a frame of the previous one stand in for it.
        cancelVideoCallback()
        unsubscribeClock()
        setLive(false)
        releaseGpu()
        video = nextVideo
        syncPlaybackEvents()
        sourceKey = next.sourceKey
        lastVideoTime = Number.NaN
        failed = false
      }
      if (next.stageKey !== stageKey || nextRasterKey !== rasterKey) {
        stageKey = next.stageKey
        rasterKey = nextRasterKey
        dirty = true
        failed = false
      }
      if (nextParamsKey !== paramsKey) {
        paramsKey = nextParamsKey
        // Same staged frame, new params: one more draw (no re-stage, no re-upload; the
        // session re-runs advanced only because its params key changed).
        pending = true
        failed = false
      }
      raster = next.raster
      basic = nextBasic
      advanced = nextAdvanced
      temporal = nextTemporal
      active = next.active
      sync()
    },
    get live() {
      return live
    },
    get running() {
      return Boolean(unsubscribe || videoCallback)
    },
    dispose() {
      if (disposed) return
      disposed = true
      cancelVideoCallback()
      unsubscribeClock()
      video = null
      syncPlaybackEvents()
      live = false
      session?.dispose()
      session = null
      if (staging) staging.width = staging.height = 0
      staging = null
    },
  }
}
