import { api, urlBase } from '@/stores/_config'
import { getUploadTimeoutMs } from '@/utils/uploadTimeout'
import type {
  PlatformFontAsset,
  PlatformFontCreatePayload,
  PlatformFontListResponse,
  PlatformFontSubsetPackagePayload,
  PlatformFontSubsetManifest,
  PlatformFontUpdatePayload,
} from './platformFontTypes'

export const buildPlatformFontFileUrl = (fontId: string): string =>
  `${urlBase}/api/v1/platform-fonts/${encodeURIComponent(fontId)}/file`

export const buildPlatformFontManifestUrl = (fontId: string): string =>
  `${urlBase}/api/v1/platform-fonts/${encodeURIComponent(fontId)}/subset-manifest`

export const buildPlatformFontSubsetUrl = (fontId: string, name: string): string =>
  `${urlBase}/api/v1/platform-fonts/${encodeURIComponent(fontId)}/subset/${name.split('/').map(encodeURIComponent).join('/')}`

const fetchPublicPlatformFontJson = async <T>(url: string): Promise<T> => {
  const resp = await fetch(url, { credentials: 'omit' })
  if (!resp.ok) throw new Error(`平台字体请求失败（HTTP ${resp.status}）`)
  return await resp.json() as T
}

export const listPlatformFonts = async (): Promise<PlatformFontAsset[]> => {
  const resp = await api.get('/api/v1/platform-fonts')
  return ((resp.data as PlatformFontListResponse)?.items || []) as PlatformFontAsset[]
}

export const getPlatformFontMeta = async (fontId: string): Promise<PlatformFontAsset> => {
  const resp = await api.get(`/api/v1/platform-fonts/${encodeURIComponent(fontId)}/meta`)
  return resp.data as PlatformFontAsset
}

export const getPublicPlatformFontMeta = (fontId: string): Promise<PlatformFontAsset> =>
  fetchPublicPlatformFontJson(`${urlBase}/api/v1/platform-fonts/${encodeURIComponent(fontId)}/meta`)

export const getPlatformFontManifest = async (fontId: string): Promise<PlatformFontSubsetManifest> => {
  const resp = await api.get(`/api/v1/platform-fonts/${encodeURIComponent(fontId)}/subset-manifest`)
  return resp.data as PlatformFontSubsetManifest
}

export const getPublicPlatformFontManifest = (fontId: string): Promise<PlatformFontSubsetManifest> =>
  fetchPublicPlatformFontJson(buildPlatformFontManifestUrl(fontId))

export const listAdminPlatformFonts = async (params?: {
  query?: string
  includeDisabled?: boolean
  page?: number
  pageSize?: number
}): Promise<PlatformFontListResponse> => {
  const resp = await api.get('/api/v1/admin/platform-fonts', { params })
  return resp.data as PlatformFontListResponse
}

export const getAdminPlatformFont = async (fontId: string): Promise<PlatformFontAsset> => {
  const resp = await api.get(`/api/v1/admin/platform-fonts/${encodeURIComponent(fontId)}`)
  return (resp.data?.item || resp.data) as PlatformFontAsset
}

export const createAdminPlatformFont = async (payload: PlatformFontCreatePayload): Promise<PlatformFontAsset> => {
  const form = new FormData()
  form.append('file', payload.file)
  if (payload.displayName) form.append('displayName', payload.displayName)
  if (payload.family) form.append('family', payload.family)
  if (payload.weight) form.append('weight', payload.weight)
  if (payload.style) form.append('style', payload.style)
  const resp = await api.post('/api/v1/admin/platform-fonts', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: getUploadTimeoutMs(),
  })
  return (resp.data?.item || resp.data) as PlatformFontAsset
}

export const updateAdminPlatformFont = async (
  fontId: string,
  payload: PlatformFontUpdatePayload,
): Promise<PlatformFontAsset> => {
  const resp = await api.patch(`/api/v1/admin/platform-fonts/${encodeURIComponent(fontId)}`, payload)
  return (resp.data?.item || resp.data) as PlatformFontAsset
}

export const deleteAdminPlatformFont = async (fontId: string): Promise<void> => {
  await api.delete(`/api/v1/admin/platform-fonts/${encodeURIComponent(fontId)}`)
}

export const uploadAdminPlatformFontSubsetPackage = async (
  fontId: string,
  payload: PlatformFontSubsetPackagePayload,
): Promise<PlatformFontAsset> => {
  const form = new FormData()
  form.append('manifest', JSON.stringify(payload.manifest || {}))
  payload.files.forEach((file) => {
    const blob = file.contentType && file.blob.type !== file.contentType
      ? new Blob([file.blob], { type: file.contentType })
      : file.blob
    form.append('files', blob, file.name)
  })
  const resp = await api.post(`/api/v1/admin/platform-fonts/${encodeURIComponent(fontId)}/subset-package`, form, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: getUploadTimeoutMs(),
  })
  return (resp.data?.item || resp.data) as PlatformFontAsset
}
