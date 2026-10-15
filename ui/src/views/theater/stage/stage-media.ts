import { resolveStageImageUrl, type StageImageRef } from '../shared/stage-types'

export interface TheaterStageMediaScope {
  urlBase: string
  worldId: string
  channelId: string
  scopeType?: 'channel' | 'world'
}

export interface TheaterStageMediaLocation {
  url: string
  managed: boolean
  sourceKind: 'image' | 'video'
}

export interface TheaterMediaPlaybackReference {
  variant?: string
  mimeType?: string
  animated?: boolean
  resourceKind?: string
  resourceMimeType?: string
}

export interface TheaterMediaPlaybackResolution {
  variant: string
  mimeType: string
  sourceKind: 'image' | 'video'
  legacyAnimatedImageDisplay: boolean
}

export const resolveTheaterMediaPlaybackReference = (
  reference: TheaterMediaPlaybackReference,
): TheaterMediaPlaybackResolution => {
  const variant = reference.variant?.trim() || 'original'
  const mimeType = reference.mimeType?.trim().toLowerCase() || ''
  return {
    variant,
    mimeType,
    sourceKind: mimeType.startsWith('video/') ? 'video' : 'image',
    legacyAnimatedImageDisplay: false,
  }
}

const managedTheaterContentPath = /\/api\/v1\/worlds\/[^/]+(?:\/channels\/[^/]+)?\/theater\/resources\/[^/]+(?:\/variants\/([^/]+))?\/content\/?$/

const decodedPathSegment = (value: string | undefined) => {
  if (!value) return ''
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export const theaterResourcePath = (scope: TheaterStageMediaScope, resourceId = '') => {
  const base = scope.scopeType === 'world'
    ? `api/v1/worlds/${encodeURIComponent(scope.worldId)}/theater/resources`
    : `api/v1/worlds/${encodeURIComponent(scope.worldId)}/channels/${encodeURIComponent(scope.channelId)}/theater/resources`
  return resourceId ? `${base}/${encodeURIComponent(resourceId)}` : base
}

export const theaterResourceContentPath = (scope: TheaterStageMediaScope, resourceId: string, variant = '') => {
  const base = theaterResourcePath(scope, resourceId)
  const suffix = variant ? `/variants/${encodeURIComponent(variant)}/content` : '/content'
  return `/${base}${suffix}`
}

export const resolveTheaterStageMediaLocation = (
  imageRef: StageImageRef,
  scope: TheaterStageMediaScope,
  baseHref = typeof window !== 'undefined' ? window.location.href : 'https://sealchat.invalid/',
  resource?: { kind?: string, mimeType?: string, playbackVariant?: string, playbackMimeType?: string },
): TheaterStageMediaLocation | null => {
  const normalized = imageRef.url.trim()
  if (!normalized) return null

  const mimeType = imageRef.mimeType?.trim().toLowerCase()
  let candidate = normalized
  let managed = false
  let sourceKind: TheaterStageMediaLocation['sourceKind'] = mimeType?.startsWith('video/') ? 'video' : 'image'
  try {
    const parsed = new URL(normalized, baseHref)
    const match = parsed.pathname.match(managedTheaterContentPath)
    if (match && imageRef.resourceId.trim()) {
      const variant = decodedPathSegment(match[1])
      const preferResourcePlayback = resource?.kind?.trim().toLowerCase() === 'animated_image'
      const playback = resolveTheaterMediaPlaybackReference({
        variant: preferResourcePlayback ? resource?.playbackVariant || variant : variant,
        mimeType: preferResourcePlayback ? resource?.playbackMimeType || mimeType : mimeType,
        animated: imageRef.animated,
        resourceKind: resource?.kind,
        resourceMimeType: resource?.mimeType,
      })
      candidate = `${scope.urlBase.replace(/\/$/, '')}${theaterResourceContentPath(scope, imageRef.resourceId, playback.variant === 'original' ? '' : playback.variant)}`
      sourceKind = playback.sourceKind
      managed = true
    } else if (normalized.startsWith('/api/')) {
      candidate = `${scope.urlBase.replace(/\/$/, '')}${normalized}`
    }
  } catch {
    return null
  }

  const url = resolveStageImageUrl(candidate, baseHref)
  return url ? { url, managed, sourceKind } : null
}
