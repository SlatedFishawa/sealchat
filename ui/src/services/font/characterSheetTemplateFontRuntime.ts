import {
  buildPlatformFontFileUrl,
  buildPlatformFontSubsetUrl,
  getPlatformFontManifest,
  getPlatformFontMeta,
} from './platformFontApi'
import type { PlatformFontAsset } from './platformFontTypes'
import { inferPlatformFontFormat as inferFontFormat, resolvePlatformFontChunkUrl, selectPlatformFontChunksForText } from './platformFontSubsetRuntime'
import { buildGlobalFontFamilyStack, quoteFontFamilyName, sanitizeFontFamilyName } from './fontUtils'

export { selectPlatformFontChunksForText } from './platformFontSubsetRuntime'

export const CHARACTER_SHEET_FONT_MANIFEST_TYPE = 'application/sealchat-fonts+json'

export interface CharacterSheetFontEntry {
  key: string
  platformFontId: string
  family?: string
  cssVar?: string
}

export interface CharacterSheetFontManifest {
  version: number
  global?: string | false
  fonts: CharacterSheetFontEntry[]
}

export interface CharacterSheetFontCssMessage {
  type: 'SEALCHAT_FONT_CSS'
  payload: {
    cssText: string
  }
}

const DEFAULT_FONT_VAR = '--sealchat-sheet-font'
const FONT_MANIFEST_RE = /<script\b[^>]*type=["']application\/sealchat-fonts\+json["'][^>]*>([\s\S]*?)<\/script>/giu
const fontDataUrlCache = new Map<string, Promise<string>>()

const escapeCssString = (value: string): string => value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')

const normalizeCssVarName = (value: unknown, fallback: string): string => {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (/^--[A-Za-z0-9_-]+$/u.test(raw)) return raw
  return fallback
}

const normalizeFontEntry = (value: unknown, index: number): CharacterSheetFontEntry | null => {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const platformFontId = typeof raw.platformFontId === 'string' ? raw.platformFontId.trim() : ''
  if (!platformFontId) return null
  const key = typeof raw.key === 'string' && raw.key.trim() ? raw.key.trim() : `font${index + 1}`
  return {
    key,
    platformFontId,
    family: sanitizeFontFamilyName(raw.family),
    cssVar: normalizeCssVarName(raw.cssVar, index === 0 ? DEFAULT_FONT_VAR : `--sealchat-sheet-font-${index + 1}`),
  }
}

export const parseCharacterSheetFontManifest = (html: string): CharacterSheetFontManifest => {
  const fonts: CharacterSheetFontEntry[] = []
  let global: string | false | undefined
  let version = 1
  const source = String(html || '')
  for (const match of source.matchAll(FONT_MANIFEST_RE)) {
    try {
      const parsed = JSON.parse(String(match[1] || '').trim()) as Record<string, unknown>
      if (typeof parsed.version === 'number' && Number.isFinite(parsed.version)) {
        version = parsed.version
      }
      if (typeof parsed.global === 'string') {
        global = parsed.global.trim() || undefined
      } else if (parsed.global === false) {
        global = false
      }
      const nextFonts = Array.isArray(parsed.fonts)
        ? parsed.fonts.map(normalizeFontEntry).filter((item): item is CharacterSheetFontEntry => !!item)
        : []
      fonts.push(...nextFonts)
    } catch {
      // Invalid template font metadata should not break character sheet rendering.
    }
  }
  return { version, global, fonts }
}

export const buildCharacterSheetFontCssMessage = (cssText: string): CharacterSheetFontCssMessage => ({
  type: 'SEALCHAT_FONT_CSS',
  payload: {
    cssText,
  },
})

const blobToDataUrl = async (blob: Blob, fallbackMime = 'application/octet-stream'): Promise<string> => {
  const buffer = await blob.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  let binary = ''
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte)
  })
  const mime = blob.type || fallbackMime
  return `data:${mime};base64,${btoa(binary)}`
}

const fetchFontDataUrl = async (url: string, fallbackMime?: string): Promise<string> => {
  const cacheKey = `${url}::${fallbackMime || ''}`
  const cached = fontDataUrlCache.get(cacheKey)
  if (cached) return cached
  const task = (async () => {
    const resp = await fetch(url, { credentials: 'include' })
    if (!resp.ok) {
      throw new Error(`字体请求失败（HTTP ${resp.status}）`)
    }
    return blobToDataUrl(await resp.blob(), fallbackMime)
  })()
  fontDataUrlCache.set(cacheKey, task)
  try {
    return await task
  } catch (error) {
    fontDataUrlCache.delete(cacheKey)
    throw error
  }
}

const buildFontFace = (
  family: string,
  src: string,
  item: Pick<PlatformFontAsset, 'weight' | 'style'>,
  options?: { format?: string; unicodeRange?: string },
): string => {
  const format = options?.format ? ` format("${escapeCssString(options.format)}")` : ''
  const unicodeRange = options?.unicodeRange ? `unicode-range:${options.unicodeRange};` : ''
  return `@font-face{font-family:${quoteFontFamilyName(family)};src:url("${src}")${format};font-weight:${item.weight || '400'};font-style:${item.style || 'normal'};font-display:swap;${unicodeRange}}`
}

const buildSingleFontFace = async (fontId: string, family: string, meta: PlatformFontAsset): Promise<string> => {
  const dataUrl = await fetchFontDataUrl(buildPlatformFontFileUrl(fontId), meta.sourceMimeType)
  return buildFontFace(family, dataUrl, meta, {
    format: inferFontFormat(meta.sourceFileName || '', meta.sourceMimeType),
  })
}

const buildSubsetFontFaces = async (
  fontId: string,
  family: string,
  meta: PlatformFontAsset,
  text: string,
): Promise<string> => {
  const manifest = await getPlatformFontManifest(fontId)
  const selected = selectPlatformFontChunksForText(manifest.chunks || [], text)
  if (selected.length === 0) return ''
  const faces = await Promise.all(selected.map(async (chunk) => {
    const dataUrl = await fetchFontDataUrl(resolvePlatformFontChunkUrl(chunk, name => buildPlatformFontSubsetUrl(fontId, name)), chunk.mimeType)
    return buildFontFace(family, dataUrl, meta, {
      format: inferFontFormat(chunk.name, chunk.mimeType),
      unicodeRange: chunk.unicodeRange,
    })
  }))
  return faces.join('\n')
}

export const resolveCharacterSheetFontCss = async (html: string, visibleText: string): Promise<string> => {
  const manifest = parseCharacterSheetFontManifest(html)
  if (manifest.fonts.length === 0) return ''
  const fontFaces: string[] = []
  const vars: string[] = []
  for (const entry of manifest.fonts) {
    const meta = await getPlatformFontMeta(entry.platformFontId)
    const family = sanitizeFontFamilyName(entry.family || meta.family || meta.displayName)
    if (!family) continue
    const cssVar = entry.cssVar || DEFAULT_FONT_VAR
    vars.push(`${cssVar}:${buildGlobalFontFamilyStack(family)};`)
    if (meta.deliveryMode === 'subset') {
      const subsetFaces = await buildSubsetFontFaces(entry.platformFontId, family, meta, visibleText)
      if (subsetFaces) {
        fontFaces.push(subsetFaces)
        continue
      }
      if (!String(visibleText || '').trim()) {
        continue
      }
    }
    fontFaces.push(await buildSingleFontFace(entry.platformFontId, family, meta))
  }
  if (vars.length === 0 && fontFaces.length === 0) return ''
  const rootVars = vars.length > 0 ? `:root{${vars.join('')}}` : ''
  const firstVar = manifest.fonts[0]?.cssVar || DEFAULT_FONT_VAR
  const globalCss = typeof manifest.global === 'string' && manifest.global
    ? `${manifest.global}{font-family:var(${firstVar}), sans-serif;}`
    : ''
  return [rootVars, globalCss, ...fontFaces].filter(Boolean).join('\n')
}
