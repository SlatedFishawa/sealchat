// CSV import for batch clue creation: byte -> text decoding without user-chosen
// encodings, RFC 4180 parsing and header mapping. Produces raw rows only; turning
// rows into items (folder/visibility resolution) lives in world-clue-batch-create.

export const WORLD_CLUE_CSV_MAX_BYTES = 2 * 1024 * 1024
export const WORLD_CLUE_CSV_MAX_ROWS = 500

export class WorldClueCsvError extends Error {}

// Omitting csvRows checks capacity for one manual item without reading a file.
export const worldClueBatchLimitError = (existingCount: number, csvRows?: number) => {
  if (existingCount + (csvRows ?? 1) <= WORLD_CLUE_CSV_MAX_ROWS) return ''
  const counts = csvRows === undefined ? `当前已有 ${existingCount} 条` : `当前已有 ${existingCount} 条，CSV 有 ${csvRows} 条`
  return `${counts}；单次批量最多 ${WORLD_CLUE_CSV_MAX_ROWS} 条线索，未添加任何条目`
}

export type WorldClueCsvColumn = 'title' | 'content' | 'imageUrl' | 'folder' | 'visibility'

export const WORLD_CLUE_CSV_HEADERS: Record<WorldClueCsvColumn, string> = {
  title: 'title',
  content: 'content',
  imageUrl: 'image_url',
  folder: 'folder',
  visibility: 'visibility',
}

const normalizeHeader = (value: string) => value.normalize('NFKC').trim().toLowerCase().replace(/[\s_\-]+/g, '')

const HEADER_ALIASES: Record<WorldClueCsvColumn, string[]> = {
  title: ['title', 'name', '标题', '標題', '名称', '名稱'],
  content: ['content', 'text', '内容', '內容', '正文'],
  imageUrl: ['image_url', 'imageurl', 'image', '图片', '圖片', '图片url', '圖片url', '图片链接', '图片地址'],
  folder: ['folder', 'folder_path', '文件夹', '文件夾', '資料夾', '目录', '目錄', '文件夹路径'],
  visibility: ['visibility', 'default_access', 'defaultaccess', '可见性', '可見性', '默认可见性', '默認可見性', '默认权限'],
}

const headerLookup = new Map<string, WorldClueCsvColumn>()
for (const [column, aliases] of Object.entries(HEADER_ALIASES) as [WorldClueCsvColumn, string[]][]) {
  for (const alias of aliases) headerLookup.set(normalizeHeader(alias), column)
}

export const worldClueCsvColumnForHeader = (header: string) => headerLookup.get(normalizeHeader(header)) || null

// --- Decoding -------------------------------------------------------------------

export type WorldClueCsvEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'gb18030' | 'big5' | 'shift_jis'

// Tried in order only when the bytes are not valid UTF-8; GB18030 covers GBK/GB2312
// exports from Simplified Chinese office software.
const LEGACY_ENCODINGS: WorldClueCsvEncoding[] = ['gb18030', 'big5', 'shift_jis']
const ENCODING_FAILURE = '无法识别 CSV 文件的文本编码，请在表格软件中另存为“CSV UTF-8”后重试'

const tryDecode = (bytes: Uint8Array, encoding: WorldClueCsvEncoding) => {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

// C0 controls other than tab/newlines, replacement characters and private-use
// code points never appear in real CSV text; they indicate a wrong decoding.
// eslint-disable-next-line no-control-regex
const SUSPICIOUS_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f�-]/

const sniffUtf16WithoutBom = (bytes: Uint8Array): WorldClueCsvEncoding | null => {
  const length = Math.min(bytes.length, 4096) & ~1
  if (length < 4) return null
  let evenZeros = 0
  let oddZeros = 0
  for (let index = 0; index < length; index += 2) {
    if (bytes[index] === 0) evenZeros += 1
    if (bytes[index + 1] === 0) oddZeros += 1
  }
  const pairs = length / 2
  if (oddZeros / pairs > 0.3 && evenZeros / pairs < 0.05) return 'utf-16le'
  if (evenZeros / pairs > 0.3 && oddZeros / pairs < 0.05) return 'utf-16be'
  return null
}

// Counts well-formed vs broken UTF-8 multi-byte sequences, to tell damaged UTF-8
// apart from a legacy encoding (which rarely forms valid UTF-8 sequences).
const utf8SequenceStats = (bytes: Uint8Array) => {
  let valid = 0
  let invalid = 0
  for (let index = 0; index < bytes.length;) {
    const byte = bytes[index]
    if (byte < 0x80) { index += 1; continue }
    const length = byte >= 0xc2 && byte <= 0xdf ? 2 : byte >= 0xe0 && byte <= 0xef ? 3 : byte >= 0xf0 && byte <= 0xf4 ? 4 : 0
    let ok = length > 0 && index + length <= bytes.length
    for (let offset = 1; ok && offset < length; offset += 1) ok = (bytes[index + offset] & 0xc0) === 0x80
    if (ok) { valid += 1; index += length } else { invalid += 1; index += 1 }
  }
  return { valid, invalid }
}

const firstNonEmptyLine = (text: string) => text.replace(/^﻿/, '').split(/\r\n|\n|\r/).find((line) => line.trim()) || ''

const recognizedHeaderCount = (text: string) => {
  const firstLine = firstNonEmptyLine(text)
  const delimiter = detectDelimiter(firstLine)
  return new Set(firstLine.split(delimiter).map((cell) => worldClueCsvColumnForHeader(cell.replace(/^"|"$/g, ''))).filter(Boolean)).size
}

export interface DecodedWorldClueCsv {
  text: string
  encoding: WorldClueCsvEncoding
}

export const decodeWorldClueCsvBytes = (bytes: Uint8Array): DecodedWorldClueCsv => {
  if (!bytes.length) throw new WorldClueCsvError('CSV 文件为空')
  let encoding: WorldClueCsvEncoding | null = null
  let text: string | null = null
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) encoding = 'utf-8'
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    if (bytes[2] === 0 && bytes[3] === 0) throw new WorldClueCsvError(ENCODING_FAILURE)
    encoding = 'utf-16le'
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be'
  else encoding = sniffUtf16WithoutBom(bytes)

  if (encoding) {
    text = tryDecode(bytes, encoding)
    if (text === null) throw new WorldClueCsvError(`CSV 文件不是有效的 ${encoding.toUpperCase()} 文本，${ENCODING_FAILURE}`)
  } else {
    if (bytes.includes(0)) throw new WorldClueCsvError('所选文件包含二进制数据，不是文本 CSV')
    text = tryDecode(bytes, 'utf-8')
    if (text !== null) {
      encoding = 'utf-8'
    } else {
      const stats = utf8SequenceStats(bytes)
      if (stats.valid > 0 && stats.valid / (stats.valid + stats.invalid) >= 0.8) {
        throw new WorldClueCsvError('CSV 文件看起来是 UTF-8 编码，但包含损坏的字节，请重新导出后再试')
      }
      let best: { text: string, encoding: WorldClueCsvEncoding, score: number } | null = null
      for (const candidate of LEGACY_ENCODINGS) {
        const decoded = tryDecode(bytes, candidate)
        if (decoded === null || SUSPICIOUS_CHARS.test(decoded)) continue
        const score = recognizedHeaderCount(decoded)
        if (!best || score > best.score) best = { text: decoded, encoding: candidate, score }
      }
      if (!best) throw new WorldClueCsvError(ENCODING_FAILURE)
      text = best.text
      encoding = best.encoding
    }
  }
  text = text.replace(/^﻿/, '')
  if (SUSPICIOUS_CHARS.test(text)) throw new WorldClueCsvError(ENCODING_FAILURE)
  return { text, encoding }
}

// --- Parsing ----------------------------------------------------------------------

export interface WorldClueCsvRecord {
  line: number
  fields: string[]
}

const DELIMITERS = [',', '\t', ';'] as const

// Picks the delimiter that yields the most recognized headers (Excel "Unicode text"
// exports are tab-separated, some locales use semicolons). Defaults to comma.
export const detectDelimiter = (headerLine: string) => {
  let best: string = ','
  let bestScore = 0
  for (const delimiter of DELIMITERS) {
    const score = new Set(headerLine.split(delimiter).map((cell) => worldClueCsvColumnForHeader(cell.replace(/^"|"$/g, ''))).filter(Boolean)).size
    if (score > bestScore) {
      best = delimiter
      bestScore = score
    }
  }
  return best
}

// RFC 4180: quoted fields may contain delimiters, doubled quotes and line breaks.
// CRLF, LF and lone CR all end a record; line breaks inside fields become LF.
export const parseCsvRecords = (text: string, delimiter = ','): WorldClueCsvRecord[] => {
  const records: WorldClueCsvRecord[] = []
  let fields: string[] = []
  let field = ''
  let quoted = false
  let fieldStarted = false
  let line = 1
  let recordLine = 1
  let quoteLine = 1
  const endField = () => {
    fields.push(field)
    field = ''
    fieldStarted = false
  }
  const endRecord = () => {
    endField()
    if (fields.some((value) => value.trim())) records.push({ line: recordLine, fields })
    fields = []
  }
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') { field += '"'; index += 1 } else quoted = false
      } else if (char === '\r' || char === '\n') {
        if (char === '\r' && text[index + 1] === '\n') index += 1
        field += '\n'
        line += 1
      } else field += char
      continue
    }
    if (char === '"' && !fieldStarted) {
      quoted = true
      fieldStarted = true
      quoteLine = line
    } else if (char === delimiter) {
      endField()
    } else if (char === '\r' || char === '\n') {
      if (char === '\r' && text[index + 1] === '\n') index += 1
      endRecord()
      line += 1
      recordLine = line
    } else {
      // Text after a closing quote, or a quote inside an unquoted field, is kept literally.
      field += char
      fieldStarted = true
    }
  }
  if (quoted) throw new WorldClueCsvError(`第 ${quoteLine} 行的引号没有闭合，请检查 CSV 格式`)
  if (field || fieldStarted || fields.length) endRecord()
  return records
}

export interface WorldClueCsvRow {
  line: number
  title: string
  content: string
  imageUrl: string
  folder: string
  visibility: string
}

export interface WorldClueCsvParseResult {
  rows: WorldClueCsvRow[]
  encoding: WorldClueCsvEncoding
  ignoredColumns: string[]
}

export const parseWorldClueCsvText = (text: string, existingCount = 0): Omit<WorldClueCsvParseResult, 'encoding'> => {
  const records = parseCsvRecords(text, detectDelimiter(firstNonEmptyLine(text)))
  if (!records.length) throw new WorldClueCsvError('CSV 文件没有内容')
  const [header, ...dataRecords] = records
  const columnIndex = new Map<WorldClueCsvColumn, number>()
  const ignoredColumns: string[] = []
  header.fields.forEach((name, index) => {
    const column = worldClueCsvColumnForHeader(name)
    if (!column) {
      if (name.trim()) ignoredColumns.push(name.trim())
      return
    }
    if (columnIndex.has(column)) throw new WorldClueCsvError(`表头中“${WORLD_CLUE_CSV_HEADERS[column]}”列重复出现`)
    columnIndex.set(column, index)
  })
  if (!columnIndex.has('title')) {
    throw new WorldClueCsvError(`CSV 第一行必须是表头且包含 ${WORLD_CLUE_CSV_HEADERS.title}（标题）列，可下载示例对照`)
  }
  if (!dataRecords.length) throw new WorldClueCsvError('CSV 只有表头，没有可导入的数据行')
  const limitError = worldClueBatchLimitError(existingCount, dataRecords.length)
  if (limitError) throw new WorldClueCsvError(limitError)
  const cell = (record: WorldClueCsvRecord, column: WorldClueCsvColumn) => {
    const index = columnIndex.get(column)
    return index === undefined ? '' : record.fields[index] ?? ''
  }
  return {
    rows: dataRecords.map((record) => ({
      line: record.line,
      title: cell(record, 'title'),
      content: cell(record, 'content'),
      imageUrl: cell(record, 'imageUrl'),
      folder: cell(record, 'folder'),
      visibility: cell(record, 'visibility'),
    })),
    ignoredColumns,
  }
}

export const parseWorldClueCsvBytes = (bytes: Uint8Array, existingCount = 0): WorldClueCsvParseResult => {
  if (bytes.length > WORLD_CLUE_CSV_MAX_BYTES) {
    throw new WorldClueCsvError(`CSV 文件不能超过 ${WORLD_CLUE_CSV_MAX_BYTES / 1024 / 1024} MB`)
  }
  const decoded = decodeWorldClueCsvBytes(bytes)
  return { ...parseWorldClueCsvText(decoded.text, existingCount), encoding: decoded.encoding }
}

// --- Template --------------------------------------------------------------------

const escapeCsvField = (value: string) => (/[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value)

// UTF-8 with BOM and CRLF so spreadsheet software opens it without mojibake.
export const buildWorldClueCsvTemplate = () => {
  const columns: WorldClueCsvColumn[] = ['title', 'content', 'imageUrl', 'folder', 'visibility']
  const rows = [
    columns.map((column) => WORLD_CLUE_CSV_HEADERS[column]),
    ['旧报纸剪报', '1923 年 4 月的报道，提到了“灯塔”和失踪的船员。', '', '', 'view'],
    ['带图片的线索', '图片地址只接受 http/https 链接；本地图片请导入后在列表中选择。', 'https://example.com/clue.png', '', 'none'],
    ['多行内容示例', '第一行，包含逗号\n第二行：引号写作 "这样"', '', '调查记录/证物', ''],
  ]
  return `﻿${rows.map((row) => row.map(escapeCsvField).join(',')).join('\r\n')}\r\n`
}
