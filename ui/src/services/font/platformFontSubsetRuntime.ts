import type { PlatformFontSubsetManifest } from './platformFontTypes'

export type PlatformFontChunk = NonNullable<PlatformFontSubsetManifest['chunks']>[number]

const parseUnicodeRange = (value: string): Array<[number, number]> | null => {
  const ranges: Array<[number, number]> = []
  for (const part of value.split(',')) {
    const match = /^U\+([0-9A-F]{1,6})(?:-([0-9A-F]{1,6}))?$/iu.exec(part.trim())
    const wildcard = /^U\+([0-9A-F]*\?+)$/iu.exec(part.trim())
    let start: number
    let end: number
    if (match) {
      start = Number.parseInt(match[1], 16)
      end = Number.parseInt(match[2] || match[1], 16)
    } else if (wildcard && wildcard[1].length <= 6) {
      start = Number.parseInt(wildcard[1].replace(/\?/gu, '0'), 16)
      end = Math.min(0x10FFFF, Number.parseInt(wildcard[1].replace(/\?/gu, 'F'), 16))
    } else return null
    if (start > end || start > 0x10FFFF || end > 0x10FFFF) return null
    ranges.push([start, end])
  }
  return ranges.length ? ranges : null
}

export const isValidPlatformFontUnicodeRange = (value: string): boolean => !!parseUnicodeRange(value)

export const selectPlatformFontChunksForText = (chunks: PlatformFontChunk[], text: string): PlatformFontChunk[] => {
  const points = Array.from(new Set(String(text || ''))).map(char => char.codePointAt(0)!)
  if (!points.length) return []
  return (chunks || []).filter((chunk) => {
    const range = String(chunk.unicodeRange || '').trim()
    if (!range) return true
    return parseUnicodeRange(range)?.some(([start, end]) => points.some(point => point >= start && point <= end)) || false
  })
}

export const inferPlatformFontFormat = (name: string, mimeType?: string): string => {
  const lower = `${name || ''} ${mimeType || ''}`.toLowerCase()
  if (lower.includes('woff2')) return 'woff2'
  if (lower.includes('woff')) return 'woff'
  if (lower.includes('opentype') || lower.includes('.otf')) return 'opentype'
  if (lower.includes('truetype') || lower.includes('.ttf')) return 'truetype'
  return ''
}

export const isSafePlatformFontChunkName = (name: string): boolean =>
  !!name && !/[\\\x00-\x1F\x7F:?#%]/u.test(name) && name.split('/').every(part => !!part && part !== '.' && part !== '..')

export const resolvePlatformFontChunkUrl = (
  chunk: PlatformFontChunk,
  buildSubsetUrl: (name: string) => string,
  localOnly = false,
): string => {
  // LOG 只按服务端清单中的规范文件名请求现有 subset API，忽略外部 URL。
  if (localOnly) {
    if (!isSafePlatformFontChunkName(chunk.name)) throw new Error('无效字体分片路径')
    return buildSubsetUrl(chunk.name)
  }
  const raw = String(chunk.url || '').trim()
  if (!raw) return buildSubsetUrl(chunk.name)
  if (/^(data:|blob:|https?:|\/\/|\/)/iu.test(raw)) return raw
  return buildSubsetUrl(raw.replace(/^\.?\//u, '') || chunk.name)
}
