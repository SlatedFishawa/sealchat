import { compactMediaFxSpec, resolveMediaFxCapabilities, type MediaFxCapabilities } from '../../features/media-fx/media-fx'
import type { MediaFxDirectiveValue } from '../../features/media-fx/media-fx-dom'
import type { TheaterMediaRef } from '../../types/theaterPresentation'

export type TheaterMediaCandidate = { kind: 'image' | 'video'; attachmentId: string }

// Older multiplayer worlds stored the effect on the public controller style.
export const resolveMultiplayerPortraitMediaFx = (personal: unknown, legacy: unknown) => (
  compactMediaFxSpec(personal) || compactMediaFxSpec(legacy)
)

export const resolveTheaterMediaCandidates = (
  media: TheaterMediaRef,
  options: { preferStatic?: boolean; supportsVideo?: boolean } = {},
): TheaterMediaCandidate[] => {
  const fallback = media.fallbackAttachmentId
    ? [{ kind: 'image' as const, attachmentId: media.fallbackAttachmentId }]
    : []
  if (media.mimeType === 'video/webm') {
    const primary = { kind: 'video' as const, attachmentId: media.resourceAttachmentId }
    if (options.preferStatic || options.supportsVideo === false) return [...fallback, primary]
    return [primary, ...fallback]
  }
  return [{ kind: 'image', attachmentId: media.resourceAttachmentId }, ...fallback]
}

export const isAnimatedTheaterMedia = (media: TheaterMediaRef | null | undefined) => Boolean(media && media.kind !== 'static_image')

// Animated media stored as WebM (videos and the transparent WebM playback of animated
// images) is shown by a <video> candidate, which is the live-frame input of Media FX.
// Animated WebP has no such input and keeps the plain DOM path.
export const theaterMediaHasLiveFrames = (media: TheaterMediaRef | null | undefined) => (
  isAnimatedTheaterMedia(media) && media?.mimeType === 'video/webm'
)

// Capabilities follow the stored media kind, never the candidate currently shown: an
// animated / video layer that falls back to its static PNG renders no advanced or
// temporal effects (the live renderer only runs on the video candidate). Static images
// use the static raster path, WebM media the live path. Both additionally need
// page-level GPU availability; when it is off the stored values are kept, only not
// rendered.
export const resolveTheaterMediaFxCapabilities = (
  media: TheaterMediaRef | null | undefined,
  gpuAvailable: boolean,
): MediaFxCapabilities => {
  const livePixels = theaterMediaHasLiveFrames(media)
  const pixels = gpuAvailable && (media?.kind === 'static_image' || livePixels)
  return resolveMediaFxCapabilities('dom', isAnimatedTheaterMedia(media), pixels, pixels, livePixels)
}

// v-media-fx binding for one theater visual layer. DOM CSS basic filters preserve
// animated media playback; reduced motion stops motion but keeps basic filters.
// The directive must sit on a wrapper inside the layout element so
// WAAPI motion never replaces the layer's own transform.
export const resolveTheaterMediaFxBinding = (
  spec: unknown,
  media: TheaterMediaRef | null | undefined,
  reducedMotion: boolean,
): MediaFxDirectiveValue => ({
  spec: spec ?? null,
  filters: resolveMediaFxCapabilities('dom', isAnimatedTheaterMedia(media)).filters,
  reducedMotion,
})
