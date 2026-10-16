<script lang="ts">
import { api } from '@/stores/_config'

// Shared across all thumbnail component instances so request deduplication,
// cache bounds, and concurrency limits apply to the whole Scene Browser.
const maxConcurrentRequests = 4
const maxCachedBlobs = 200
const thumbnailBlobCache = new Map<string, Blob>()
const thumbnailBlobRequests = new Map<string, Promise<Blob>>()
let activeRequests = 0
const requestWaiters: Array<() => void> = []

const acquireRequestSlot = () => {
  if (activeRequests < maxConcurrentRequests) {
    activeRequests += 1
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => requestWaiters.push(resolve))
}

const releaseRequestSlot = () => {
  const next = requestWaiters.shift()
  if (next) next()
  else activeRequests = Math.max(0, activeRequests - 1)
}

const fetchThumbnailBlob = (url: string) => {
  const cached = thumbnailBlobCache.get(url)
  if (cached) {
    thumbnailBlobCache.delete(url)
    thumbnailBlobCache.set(url, cached)
    return Promise.resolve(cached)
  }
  const pending = thumbnailBlobRequests.get(url)
  if (pending) return pending
  const request = (async () => {
    await acquireRequestSlot()
    try {
      const response = await api.get<Blob>(url, { responseType: 'blob' })
      if (!(response.data instanceof Blob) || response.data.size === 0) throw new Error('empty thumbnail')
      thumbnailBlobCache.set(url, response.data)
      while (thumbnailBlobCache.size > maxCachedBlobs) {
        const oldest = thumbnailBlobCache.keys().next().value
        if (typeof oldest !== 'string') break
        thumbnailBlobCache.delete(oldest)
      }
      return response.data
    } finally {
      releaseRequestSlot()
    }
  })().finally(() => {
    if (thumbnailBlobRequests.get(url) === request) thumbnailBlobRequests.delete(url)
  })
  thumbnailBlobRequests.set(url, request)
  return request
}
</script>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NIcon } from 'naive-ui'
import { Photo } from '@vicons/tabler'
import type { TheaterStageMediaLocation } from './stage-media'

// Static scene preview. Managed resources come from the server still-frame
// thumbnail; external images are painted once into a canvas so GIF/APNG
// sources never animate here.
const props = defineProps<{
  location: TheaterStageMediaLocation | null
  backgroundColor: string
}>()

const rootRef = ref<HTMLElement | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)
const objectUrl = ref('')
const status = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
const visible = ref(false)
let loadEpoch = 0
let observer: IntersectionObserver | null = null
let externalImage: HTMLImageElement | null = null

const releaseSource = () => {
  if (objectUrl.value) URL.revokeObjectURL(objectUrl.value)
  objectUrl.value = ''
  if (externalImage) {
    externalImage.onload = null
    externalImage.onerror = null
    externalImage.removeAttribute('src')
    externalImage = null
  }
}

const paintExternalImage = (image: HTMLImageElement) => {
  const canvas = canvasRef.value
  const context = canvas?.getContext('2d')
  const width = image.naturalWidth || image.width
  const height = image.naturalHeight || image.height
  if (!canvas || !context || !width || !height) return false
  const scale = Math.min(1, 360 / Math.max(width, height))
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  return true
}

const load = () => {
  const epoch = ++loadEpoch
  releaseSource()
  const location = props.location
  if (!location) {
    status.value = 'idle'
    return
  }
  status.value = 'loading'
  if (location.managed) {
    void fetchThumbnailBlob(location.url).then((blob) => {
      if (epoch !== loadEpoch) return
      objectUrl.value = URL.createObjectURL(blob)
      status.value = 'ready'
    }).catch(() => {
      if (epoch === loadEpoch) status.value = 'error'
    })
    return
  }
  const image = new Image()
  externalImage = image
  image.decoding = 'async'
  image.onload = () => {
    if (epoch !== loadEpoch) return
    status.value = paintExternalImage(image) ? 'ready' : 'error'
    image.onload = null
    image.removeAttribute('src')
    if (externalImage === image) externalImage = null
  }
  image.onerror = () => {
    if (epoch === loadEpoch) status.value = 'error'
  }
  image.src = location.url
}

watch(() => [props.location?.url, props.location?.managed, visible.value] as const, ([, , isVisible]) => {
  if (isVisible) load()
})

onMounted(() => {
  if (typeof IntersectionObserver === 'undefined' || !rootRef.value) {
    visible.value = true
    return
  }
  observer = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return
    visible.value = true
    observer?.disconnect()
    observer = null
  }, { rootMargin: '120px' })
  observer.observe(rootRef.value)
})

onBeforeUnmount(() => {
  loadEpoch += 1
  observer?.disconnect()
  observer = null
  releaseSource()
})
</script>

<template>
  <span ref="rootRef" class="theater-scene-thumb" :class="`is-${status}`" :style="{ backgroundColor }">
    <img v-if="location?.managed && objectUrl" :src="objectUrl" alt="" draggable="false" decoding="async">
    <canvas v-else-if="location && !location.managed" v-show="status === 'ready'" ref="canvasRef" aria-hidden="true" />
    <n-icon v-if="status !== 'ready'" class="theater-scene-thumb__placeholder" aria-hidden="true"><Photo /></n-icon>
  </span>
</template>

<style scoped>
.theater-scene-thumb {
  position: relative; display: block; width: 100%; aspect-ratio: 16 / 9; overflow: hidden;
  border-radius: 4px; background-image: linear-gradient(135deg, rgba(255, 255, 255, .06), rgba(0, 0, 0, .14));
}
.theater-scene-thumb img, .theater-scene-thumb canvas {
  position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; pointer-events: none; user-select: none;
}
.theater-scene-thumb__placeholder {
  position: absolute; top: 50%; left: 50%; color: rgba(255, 255, 255, .42); font-size: 18px; transform: translate(-50%, -50%);
  filter: drop-shadow(0 1px 1px rgba(0, 0, 0, .35));
}
.theater-scene-thumb.is-loading .theater-scene-thumb__placeholder { opacity: .5; }
</style>
