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
  const resourceKind = reference.resourceKind?.trim().toLowerCase() || ''
  const resourceMimeType = reference.resourceMimeType?.trim().toLowerCase() || ''
  const animatedImage = reference.animated === true
    || resourceKind === 'animated_image'
    || (!resourceKind && resourceMimeType.startsWith('image/'))
  const legacyAnimatedImageDisplay = variant === 'display'
    && mimeType === 'video/webm'
    && animatedImage
  return {
    variant: legacyAnimatedImageDisplay ? 'original' : variant,
    mimeType: legacyAnimatedImageDisplay
      ? (resourceMimeType.startsWith('image/') ? resourceMimeType : '')
      : mimeType,
    sourceKind: legacyAnimatedImageDisplay ? 'image' : mimeType.startsWith('video/') ? 'video' : 'image',
    legacyAnimatedImageDisplay,
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
  resource?: { kind?: string, mimeType?: string },
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
      const playback = resolveTheaterMediaPlaybackReference({
        variant,
        mimeType,
        animated: imageRef.animated,
        resourceKind: resource?.kind,
        resourceMimeType: resource?.mimeType,
      })
      candidate = `${scope.urlBase.replace(/\/$/, '')}${theaterResourceContentPath(scope, imageRef.resourceId, playback.legacyAnimatedImageDisplay ? '' : variant)}`
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
