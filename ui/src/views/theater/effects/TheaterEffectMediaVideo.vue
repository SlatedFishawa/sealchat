<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch, type CSSProperties } from 'vue'
import {
  mediaFxAdvancedKeys,
  mediaFxFilterToCss,
  mediaFxTemporalKeys,
  normalizeMediaFxSpec,
  resolveMediaFxCapabilities,
} from '@/features/media-fx/media-fx'
import { canvasFilterSupported } from '@/features/media-fx/media-fx-canvas'
import { mediaFxGpuSupported, subscribeMediaFxGpuAvailability } from '@/features/media-fx/media-fx-gpu'
import { createMediaFxLiveRenderer, mediaFxLiveWanted, resolveMediaFxLiveRaster } from '@/features/media-fx/media-fx-live'
import { presentMediaFxTemporalFrame } from '@/features/media-fx/media-fx-temporal'
import { resolveTheaterMediaFitRect } from '@/components/theater-presentation/theaterMediaFxAdvanced'

// Video asset of a media-only effect. The <video> keeps its src, autoplay, loop / loop
// count (`ended` is forwarded to the overlay) and the asset's mediaTransform style; Media
// FX motion stays on the overlay's wrapper. With advanced / temporal content the shared
// live renderer processes its frames (contain fit + basic filter -> advanced -> temporal)
// into a canvas that carries the same mediaTransform style and replaces the video only
// after its first frame; any failure shows the video with its CSS basic filter again.

const props = withDefaults(defineProps<{
  src: string
  loop: boolean
  // Asset style from the overlay: mediaTransform variables and the CSS basic filter.
  mediaStyle: Record<string, string | number>
  mediaFx?: unknown
  animated?: boolean
  // Overlay design-stage scale (layout px -> screen px).
  displayScale?: number
  reducedMotion?: boolean
}>(), { animated: true, displayScale: 1, reducedMotion: false })
const emit = defineEmits<{ ended: [event: Event] }>()

const rootRef = ref<HTMLElement | null>(null)
const videoRef = ref<HTMLVideoElement | null>(null)
const outputRef = ref<HTMLCanvasElement | null>(null)
const gpuAvailable = ref(mediaFxGpuSupported())
const unsubscribeGpuAvailability = subscribeMediaFxGpuAvailability((available) => {
  gpuAvailable.value = available
})
const loadedVideo = shallowRef<HTMLVideoElement | null>(null)
const liveReady = ref(false)
const box = ref<{ width: number, height: number } | null>(null)
const pixelRatio = ref(typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1)

const liveSpec = computed(() => {
  // The <video> is the live-frame input of this effect asset.
  const capabilities = resolveMediaFxCapabilities('dom', props.animated, gpuAvailable.value, gpuAvailable.value, true)
  const spec = normalizeMediaFxSpec(props.mediaFx)
  const advanced = capabilities.advanced ? spec.advanced : null
  const temporal = capabilities.temporal && !props.reducedMotion ? spec.temporal : null
  if (!mediaFxLiveWanted(advanced, temporal)) return null
  const basicCss = mediaFxFilterToCss(spec.filter)
  if (basicCss && !canvasFilterSupported()) return null
  return { advanced, temporal, filter: spec.filter, basicCss }
})
const liveSignature = computed(() => {
  const spec = liveSpec.value
  if (!spec) return ''
  return [
    spec.basicCss,
    spec.advanced ? mediaFxAdvancedKeys.map((key) => spec.advanced![key]).join(',') : '',
    spec.temporal ? mediaFxTemporalKeys.map((key) => spec.temporal![key]).join(',') : '',
  ].join('|')
})

const outputStyle = computed<CSSProperties>(() => {
  const { filter: _filter, ...style } = props.mediaStyle
  return style as CSSProperties
})
const videoStyle = computed<CSSProperties>(() => (
  liveReady.value ? { ...outputStyle.value, visibility: 'hidden' } : props.mediaStyle as CSSProperties
))

const renderer = createMediaFxLiveRenderer<HTMLVideoElement>({
  stage: (context, video, raster) => {
    const spec = liveSpec.value
    if (!spec || !(video.videoWidth > 0 && video.videoHeight > 0)) return false
    // Same geometry as the asset's `object-fit: contain` (centered).
    const rect = resolveTheaterMediaFitRect({ width: video.videoWidth, height: video.videoHeight }, raster, 'contain')
    context.filter = mediaFxFilterToCss(spec.filter, { blurScale: raster.pixelRatio }) || 'none'
    context.imageSmoothingQuality = 'high'
    context.drawImage(video, rect.x, rect.y, rect.width, rect.height)
    return true
  },
  present: (frame) => presentMediaFxTemporalFrame(outputRef.value, frame),
  onLiveChange: (live) => {
    liveReady.value = live
    if (!live && outputRef.value) outputRef.value.width = outputRef.value.height = 0
  },
})

const updateLive = () => {
  const spec = liveSpec.value
  const video = loadedVideo.value
  const scale = Number.isFinite(props.displayScale) && props.displayScale > 0 ? props.displayScale : 1
  renderer.update({
    video: spec ? video : null,
    sourceKey: video ? props.src : '',
    stageKey: spec?.basicCss ?? '',
    raster: spec && box.value ? resolveMediaFxLiveRaster(box.value.width, box.value.height, pixelRatio.value * scale) : null,
    advanced: spec?.advanced,
    temporal: spec?.temporal,
    active: true,
  })
}

const handleLoaded = () => {
  loadedVideo.value = videoRef.value
}

watch(() => props.src, () => {
  loadedVideo.value = null
}, { flush: 'sync' })

let resizeObserver: ResizeObserver | null = null
const setTracking = (enabled: boolean) => {
  if (!enabled) {
    resizeObserver?.disconnect()
    resizeObserver = null
    return
  }
  const root = rootRef.value
  if (!root || resizeObserver || typeof ResizeObserver === 'undefined') return
  // contentRect is the untransformed layout size, like the asset's own box.
  box.value = { width: root.clientWidth, height: root.clientHeight }
  pixelRatio.value = window.devicePixelRatio || 1
  resizeObserver = new ResizeObserver((entries) => {
    const rect = entries[entries.length - 1]?.contentRect
    if (rect) box.value = { width: rect.width, height: rect.height }
  })
  resizeObserver.observe(root)
}

onMounted(() => {
  setTracking(Boolean(liveSpec.value))
  watch(() => Boolean(liveSpec.value), setTracking)
  watch(() => [liveSignature.value, loadedVideo.value, box.value, pixelRatio.value, props.displayScale], updateLive, { flush: 'post' })
  updateLive()
})

onBeforeUnmount(() => {
  renderer.dispose()
  unsubscribeGpuAvailability()
  setTracking(false)
})
</script>

<template>
  <div ref="rootRef" class="theater-effect-media-video">
    <video
      ref="videoRef"
      class="theater-effect-media-video__asset"
      :style="videoStyle"
      :src="src"
      autoplay
      :loop="loop"
      muted
      playsinline
      @loadeddata="handleLoaded"
      @ended="emit('ended', $event)"
    />
    <canvas v-if="liveSpec" v-show="liveReady" ref="outputRef" class="theater-effect-media-video__asset theater-effect-media-video__output" :style="outputStyle" aria-hidden="true" />
  </div>
</template>

<style scoped>
.theater-effect-media-video { position: relative; width: 100%; height: 100%; }
/* Same box and mediaTransform as .theater-effect-media-only__asset in the overlay. */
.theater-effect-media-video__asset {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: contain;
  transform: translate(var(--effect-media-x, 0), var(--effect-media-y, 0)) rotate(var(--effect-media-rotation, 0deg)) scale(var(--effect-media-scale-x, 1), var(--effect-media-scale-y, 1));
}
.theater-effect-media-video__output { position: absolute; inset: 0; pointer-events: none; }
</style>
