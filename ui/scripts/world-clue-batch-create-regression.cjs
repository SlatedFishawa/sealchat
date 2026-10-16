// World clue batch create regression: CSV decoding (no user-chosen encoding),
// RFC 4180 parsing, header mapping, shared folder path resolution, item
// validation and the sequential runner (partial failure, retry, stop, scope loss).
// Run with node scripts/world-clue-batch-create-regression.cjs.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')
const root = path.resolve(__dirname, '..')
const originalResolve = Module._resolveFilename
Module._resolveFilename = function (request, parent, ...args) {
  if (request.startsWith('@/')) request = path.join(root, 'src', request.slice(2))
  return originalResolve.call(this, request, parent, ...args)
}
const transpile = (source, fileName) => ts.transpileModule(source, {
  fileName, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText
require.extensions['.ts'] = (module, filename) => module._compile(transpile(fs.readFileSync(filename, 'utf8'), filename), filename)

const dir = '../src/views/chat/components/clue-box'
const csv = require(`${dir}/world-clue-batch-csv.ts`)
const batch = require(`${dir}/world-clue-batch-create.ts`)

const utf8 = (text) => new TextEncoder().encode(text)
const hex = (value) => Uint8Array.from(Buffer.from(value, 'hex'))
const utf16 = (text, { bom = true, bigEndian = false } = {}) => {
  const bytes = []
  if (bom) bytes.push(...(bigEndian ? [0xfe, 0xff] : [0xff, 0xfe]))
  for (const char of text) {
    const code = char.charCodeAt(0)
    bytes.push(...(bigEndian ? [code >> 8, code & 0xff] : [code & 0xff, code >> 8]))
  }
  return Uint8Array.from(bytes)
}
const parseBytes = (bytes) => csv.parseWorldClueCsvBytes(bytes)
const throwsCsv = (fn, pattern) => assert.throws(fn, (error) => error instanceof csv.WorldClueCsvError && pattern.test(error.message))

// --- Normal CSV -------------------------------------------------------------------
{
  const result = parseBytes(utf8('title,content,image_url,folder,visibility\n旧报纸,剪报内容,,线索,view\n录音带,,https://example.com/a.png,,none\n'))
  assert.equal(result.encoding, 'utf-8')
  assert.deepEqual(result.ignoredColumns, [])
  assert.deepEqual(result.rows, [
    { line: 2, title: '旧报纸', content: '剪报内容', imageUrl: '', folder: '线索', visibility: 'view' },
    { line: 3, title: '录音带', content: '', imageUrl: 'https://example.com/a.png', folder: '', visibility: 'none' },
  ])
}

// --- Quotes, delimiters and line breaks inside fields --------------------------------
{
  const text = 'title,content\r\n"A, B","He said ""hi"", then left"\r\n"多行","第一行\r\n第二行\n第三行"\r\n"空",""\r\nlast,"tail"'
  const records = csv.parseCsvRecords(text)
  assert.deepEqual(records.map((record) => record.fields), [
    ['title', 'content'],
    ['A, B', 'He said "hi", then left'],
    ['多行', '第一行\n第二行\n第三行'],
    ['空', ''],
    ['last', 'tail'],
  ])
  assert.deepEqual(records.map((record) => record.line), [1, 2, 3, 6, 7], 'record lines account for line breaks inside fields')
  assert.deepEqual(csv.parseCsvRecords('a,b\rc,d\r').map((record) => record.fields), [['a', 'b'], ['c', 'd']], 'lone CR ends records')
  assert.deepEqual(csv.parseCsvRecords('a,,c\n,,\n\n x ,\n').map((record) => record.fields), [['a', '', 'c'], [' x ', '']], 'blank records skipped, empty fields kept')
  assert.deepEqual(csv.parseCsvRecords('a,"b"x,c"d"').map((record) => record.fields), [['a', 'bx', 'c"d"']], 'stray quote characters stay literal')
  throwsCsv(() => csv.parseCsvRecords('title\n"never closed\nmore'), /第 2 行的引号没有闭合/)
  const tsv = csv.parseWorldClueCsvText('标题\t内容\n甲\t带,逗号的内容\n')
  assert.deepEqual(tsv.rows[0], { line: 2, title: '甲', content: '带,逗号的内容', imageUrl: '', folder: '', visibility: '' }, 'tab-separated export detected')
  const semicolon = csv.parseWorldClueCsvText('title;content\nA;B,C\n')
  assert.equal(semicolon.rows[0].content, 'B,C')
}

// --- Header mapping -----------------------------------------------------------------
{
  const result = csv.parseWorldClueCsvText(' 标题 ,正文,图片 URL,文件夹,默认可见性,备注\n甲,乙,,,,忽略\n')
  assert.deepEqual(result.rows[0], { line: 2, title: '甲', content: '乙', imageUrl: '', folder: '', visibility: '' })
  assert.deepEqual(result.ignoredColumns, ['备注'])
  assert.equal(csv.parseWorldClueCsvText('Image_URL,TITLE\nhttps://x.test/a.png,甲\n').rows[0].imageUrl, 'https://x.test/a.png')
  throwsCsv(() => csv.parseWorldClueCsvText('content\n甲\n'), /title/)
  throwsCsv(() => csv.parseWorldClueCsvText('title,标题\n甲,乙\n'), /重复/)
  throwsCsv(() => csv.parseWorldClueCsvText('title\n'), /没有可导入的数据行/)
  throwsCsv(() => csv.parseWorldClueCsvText('\n\n'), /没有内容/)
  const many = `title\n${Array.from({ length: csv.WORLD_CLUE_CSV_MAX_ROWS + 1 }, (_, index) => `t${index}`).join('\n')}\n`
  throwsCsv(() => csv.parseWorldClueCsvText(many), /当前已有 0 条，CSV 有 501 条；单次批量最多 500 条线索/)
  assert.equal(csv.parseWorldClueCsvText(`title\n${Array.from({ length: 500 }, (_, index) => `t${index}`).join('\n')}`).rows.length, 500)
  throwsCsv(() => parseBytes(new Uint8Array(csv.WORLD_CLUE_CSV_MAX_BYTES + 1).fill(0x61)), /不能超过 2 MB/)
  assert.equal(csv.worldClueBatchLimitError(499), '')
  assert.match(csv.worldClueBatchLimitError(500), /当前已有 500 条/)
  assert.equal(csv.worldClueBatchLimitError(498, 2), '')
  assert.match(csv.worldClueBatchLimitError(499, 2), /当前已有 499 条，CSV 有 2 条/)
  throwsCsv(() => csv.parseWorldClueCsvText('title\nA\nB', 499), /当前已有 499 条，CSV 有 2 条/)
  assert.equal(csv.parseWorldClueCsvBytes(utf8('title\nA'), 499).rows.length, 1)
}

// --- Adaptive decoding --------------------------------------------------------------
{
  const sample = 'title,content\n灯塔,"守灯人，失踪"\n'
  const expected = { line: 2, title: '灯塔', content: '守灯人，失踪', imageUrl: '', folder: '', visibility: '' }
  const decode = (bytes) => csv.decodeWorldClueCsvBytes(bytes)

  assert.deepEqual(parseBytes(utf8(sample)).rows[0], expected)
  const bom = parseBytes(Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8(sample)]))
  assert.equal(bom.encoding, 'utf-8')
  assert.deepEqual(bom.rows[0], expected, 'UTF-8 BOM is stripped before the header')
  assert.equal(decode(utf16(sample)).encoding, 'utf-16le')
  assert.deepEqual(parseBytes(utf16(sample)).rows[0], expected)
  assert.equal(decode(utf16(sample, { bigEndian: true })).encoding, 'utf-16be')
  assert.deepEqual(parseBytes(utf16(sample, { bigEndian: true })).rows[0], expected)
  assert.equal(decode(utf16('title,content\nabc,def\n', { bom: false })).encoding, 'utf-16le', 'UTF-16 without BOM is sniffed')
  assert.equal(decode(utf8('title\nplain ascii\n')).encoding, 'utf-8')

  // GBK from Simplified Chinese Excel: 标题,内容,文件夹 / 旧报纸,"剪报，提到灯塔",调查记录/证物
  const gbk = parseBytes(hex('b1eacce22cc4dac8dd2ccec4bcfebcd00d0abec9b1a8d6bd2c22bcf4b1a8a3accce1b5bdb5c6cbfe222cb5f7b2e9bcc7c2bc2fd6a4ceef0d0a'))
  assert.equal(gbk.encoding, 'gb18030')
  assert.deepEqual(gbk.rows[0], { line: 2, title: '旧报纸', content: '剪报，提到灯塔', imageUrl: '', folder: '调查记录/证物', visibility: '' })
  // Big5 with traditional headers: 標題,內容 / 舊報紙,燈塔的剪報 — header recognition picks Big5.
  const big5 = parseBytes(hex('bcd0c3442ca4baae650d0ac2c2b3f8afc82cbf4fb6f0aabab0c5b3f80d0a'))
  assert.equal(big5.encoding, 'big5')
  assert.deepEqual(big5.rows[0], { line: 2, title: '舊報紙', content: '燈塔的剪報', imageUrl: '', folder: '', visibility: '' })

  throwsCsv(() => decode(new Uint8Array()), /为空/)
  throwsCsv(() => decode(Uint8Array.from([0x74, 0x69, 0x00, 0x6c, 0x65, 0x89, 0x50, 0x4e, 0x47])), /二进制/)
  const damaged = utf8('title,content\n灯塔守灯人,失踪的船员与旧报纸\n')
  damaged[damaged.length - 4] = 0xff
  throwsCsv(() => decode(damaged), /UTF-8 编码，但包含损坏的字节/)
  throwsCsv(() => decode(Uint8Array.from([0x80, 0x80, 0x80, 0x80, 0x0a, 0xff, 0xff])), /无法识别 CSV 文件的文本编码/)
  throwsCsv(() => decode(Uint8Array.from([0xff, 0xfe, 0x00, 0x00, 0x41, 0x00, 0x00, 0x00])), /无法识别/)
  throwsCsv(() => decode(Uint8Array.from([0xff, 0xfe, 0x00, 0xd8, 0x41, 0x00])), /不是有效的 UTF-16LE/)
  throwsCsv(() => decode(utf8('title\n\u0001control\n')), /无法识别/)
}

// --- Template round trip ---------------------------------------------------------
{
  const template = csv.buildWorldClueCsvTemplate()
  assert.ok(template.startsWith('\ufeff'), 'template has a UTF-8 BOM for spreadsheet software')
  assert.ok(template.includes('\r\n'))
  const result = parseBytes(utf8(template))
  assert.equal(result.rows.length, 3)
  assert.deepEqual(Object.keys(result.rows[0]), ['line', 'title', 'content', 'imageUrl', 'folder', 'visibility'])
  assert.equal(result.rows[2].content, '第一行，包含逗号\n第二行：引号写作 "这样"')
  assert.equal(result.rows[2].folder, '调查记录/证物')
}

// --- Shared folder paths ------------------------------------------------------------
const folder = (id, name, parentId = '', orderIndex = 0, scope = 'shared') => ({ id, name, parentId, orderIndex, scope })
const folders = [
  folder('evidence', '证物', 'records', 1),
  folder('records', '调查记录', '', 0),
  folder('people', '人物', '', 1),
  folder('people-evidence', '证物', 'people', 0),
  folder('letters', '信件', 'records', 0),
  folder('unique', '日记', 'letters', 0),
  folder('mine', '证物', '', 9, 'personal'),
  folder('loop-a', '环A', 'loop-b', 5),
  folder('loop-b', '环B', 'loop-a', 6),
]
const options = batch.sharedWorldClueFolderOptions(folders)
{
  assert.deepEqual(options.map((option) => option.label), ['调查记录', '调查记录 / 信件', '调查记录 / 信件 / 日记', '调查记录 / 证物', '人物', '人物 / 证物'], 'tree order, personal folders excluded, cycles are unreachable')
  const resolve = (raw) => batch.resolveWorldClueFolderPath(raw, options)
  assert.deepEqual(resolve('调查记录/证物'), { folderId: 'evidence' })
  assert.deepEqual(resolve(' / 人物 / 证物 '), { folderId: 'people-evidence' }, 'leading slash and spaces around segments are ignored')
  assert.deepEqual(resolve('日记'), { folderId: 'unique' }, 'a unique bare name resolves')
  assert.deepEqual(resolve('人物'), { folderId: 'people' })
  assert.match(resolve('证物').error, /多个名为“证物”/, 'same name on different levels is ambiguous')
  assert.match(resolve('调查记录/不存在').error, /未找到文件夹/)
  assert.match(resolve('证物/调查记录').error, /未找到文件夹/)
  assert.deepEqual(resolve('/'), { folderId: '' })
  assert.deepEqual(resolve('根目录'), { folderId: '' })
  const duplicateSiblings = batch.sharedWorldClueFolderOptions([folder('a', '同名'), folder('b', '同名', '', 1)])
  assert.match(batch.resolveWorldClueFolderPath('同名', duplicateSiblings).error, /对应多个文件夹/)
}

// --- CSV rows -> items and validation ------------------------------------------------
const folderIds = new Set(options.map((option) => option.id))
const errorsOf = (item) => batch.validateWorldClueBatchItem(item, folderIds)
{
  const defaults = { folderId: 'records', defaultAccess: 'none' }
  const rows = csv.parseWorldClueCsvText([
    'title,content,image_url,folder,visibility',
    '  正常  ,  内容  ,https://example.com/a.png,人物/证物,可查看',
    ',空标题,,,',
    '坏图片,,ftp://example.com/a.png,,',
    '本地路径,,C:\\pics\\a.png,,',
    '未知文件夹,,,不存在,',
    '歧义文件夹,,,证物,',
    '坏可见性,,,,maybe',
    '默认值,,,,',
  ].join('\n')).rows
  const items = batch.createWorldClueBatchItemsFromCsv(rows, defaults, options)
  const [ok, noTitle, badUrl, localPath, unknownFolder, ambiguous, badAccess, plain] = items
  assert.equal(ok.title, '正常')
  assert.equal(ok.content, '  内容  ', 'CSV content keeps leading/trailing spaces')
  const multiline = batch.createWorldClueBatchItemsFromCsv(csv.parseWorldClueCsvText('title,content\n甲,"\n第一行\n第二行\n"').rows, defaults, options)
  assert.equal(multiline[0].content, '\n第一行\n第二行\n', 'CSV content keeps leading/trailing newlines')
  assert.equal(ok.folderId, 'people-evidence')
  assert.equal(ok.defaultAccess, 'view')
  assert.equal(ok.line, 2)
  assert.deepEqual(errorsOf(ok), {})
  assert.deepEqual(errorsOf(noTitle), { title: '标题不能为空' })
  assert.match(errorsOf(badUrl).imageUrl, /http\/https/)
  assert.match(errorsOf(localPath).imageUrl, /http\/https/, 'local disk paths are not read')
  assert.match(errorsOf(unknownFolder).folder, /未找到文件夹“不存在”/)
  assert.equal(unknownFolder.folderId, 'records', 'unresolved folder keeps the default but is flagged')
  assert.match(errorsOf(ambiguous).folder, /多个名为/)
  assert.match(errorsOf(badAccess).defaultAccess, /无法识别的可见性“maybe”/)
  assert.equal(plain.folderId, 'records')
  assert.equal(plain.defaultAccess, 'none')
  assert.deepEqual(errorsOf(plain), {}, 'empty content is allowed')

  // Defaults are copied at creation time and do not follow later changes.
  defaults.folderId = ''
  assert.equal(plain.folderId, 'records')

  // Fixing a field through the UI clears its import issue.
  unknownFolder.folderId = 'evidence'
  delete unknownFolder.issues.folder
  assert.deepEqual(errorsOf(unknownFolder), {})
  assert.match(batch.validateWorldClueBatchItem(ok, new Set(['records'])).folder, /已不存在/, 'deleted folders are caught before creation')

  const longTitle = batch.createWorldClueBatchItem({ folderId: '', defaultAccess: 'view' }, { title: '长'.repeat(255) })
  assert.deepEqual(errorsOf(longTitle), {})
  longTitle.title += '长'
  assert.match(errorsOf(longTitle).title, /255/)
  const fileItem = batch.createWorldClueBatchItem({ folderId: '', defaultAccess: 'view' }, { title: 'x', imageFile: { name: 'a.txt', type: 'text/plain', size: 1 } })
  assert.equal(errorsOf(fileItem).imageFile, '仅支持图片文件')
}

// --- Payloads -----------------------------------------------------------------------
{
  const base = { title: '  标题 ', content: '内容', imageUrl: '', imageFile: null, folderId: 'records', defaultAccess: 'view', orderIndex: 42 }
  assert.deepEqual(batch.buildWorldClueCreatePayload(base), { title: '标题', kind: 'text', contentFormat: 'plain', content: '内容', defaultAccess: 'view', sharedFolderId: 'records', orderIndex: 42 })
  assert.deepEqual(batch.buildWorldClueCreatePayload({ ...base, imageUrl: ' https://example.com/a.png ' }), {
    title: '标题', kind: 'image', contentFormat: 'plain', content: '内容', defaultAccess: 'view', sharedFolderId: 'records', imageUrl: 'https://example.com/a.png', orderIndex: 42,
  })
  const withFile = batch.buildWorldClueCreatePayload({ ...base, imageUrl: 'https://ignored.test/a.png', imageFile: { name: 'a.png', type: 'image/png', size: 1 } }, 'att-1')
  assert.equal(withFile.kind, 'image')
  assert.equal(withFile.imageAttachmentId, 'att-1')
  assert.equal(withFile.imageUrl, undefined, 'attachment and URL are never sent together')
  assert.equal('presentation' in withFile, false, 'presentation is left to the server default')
  assert.throws(() => batch.buildWorldClueCreatePayload({ ...base, orderIndex: null }), /尚未分配/)
}

// --- Runner -------------------------------------------------------------------------
const makeItems = (titles) => titles.map((title) => batch.createWorldClueBatchItem({ folderId: '', defaultAccess: 'view' }, { title }))
const makeSession = ({ failCreate = new Set(), failUpload = new Set(), onCreate, onUpload, summaries = [] } = {}) => {
  const created = []
  const uploads = []
  let current = true
  const session = {
    isCurrent: () => current,
    folderIds: () => folderIds,
    summaries: () => summaries,
    upload: async (file) => {
      uploads.push(file.name)
      await onUpload?.(file)
      if (failUpload.has(file.name)) throw Object.assign(new Error('network'), { response: { data: { message: '上传被拒绝' } } })
      return `att-${file.name}`
    },
    create: async (payload) => {
      await onCreate?.(payload)
      if (failCreate.has(payload.title)) throw Object.assign(new Error('boom'), { response: { data: { message: `服务器拒绝 ${payload.title}` } } })
      created.push(payload)
      return { id: `clue-${payload.title}` }
    },
  }
  return { session, created, uploads, setCurrent: (value) => { current = value } }
}
const run = (items, session, extra = {}) => batch.runWorldClueBatch(items, session, { isCancelled: () => false, ...extra })

// Exercise the actual component handlers without mounting the unrelated upload/UI stack.
async function testImportHandlers() {
  const filename = path.join(root, 'src/views/chat/components/clue-box/WorldClueBatchCreateModal.vue')
  const script = fs.readFileSync(filename, 'utf8').split('<script setup lang="ts">')[1].split('</script>')[0]
  const source = ts.createSourceFile(filename + '.ts', script, ts.ScriptTarget.Latest, true)
  const names = ['addItem', 'handleCsvChange']
  const handlers = source.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text)).map(node => node.getText(source)).join('\n')
  assert.equal(handlers.includes('file.arrayBuffer()'), true)
  const state = {
    items: { value: [] }, locked: { value: false }, importing: { value: false },
    notice: { value: null }, summary: { value: '' }, expandedKey: { value: '' },
    defaults: { folderId: '', defaultAccess: 'view' }, folderOptions: { value: options }, folderIds: { value: folderIds },
    isContextCurrent: () => true,
    createWorldClueBatchItem: batch.createWorldClueBatchItem,
    createWorldClueBatchItemsFromCsv: batch.createWorldClueBatchItemsFromCsv,
    validateWorldClueBatchItem: batch.validateWorldClueBatchItem,
    ...csv,
  }
  const { addItem, handleCsvChange } = new Function(...Object.keys(state), transpile(`let importToken = 0;\n${handlers}\nreturn { addItem, handleCsvChange }`, filename + '.ts'))(...Object.values(state))
  let reads = 0
  const file = (text, size = utf8(text).length) => ({ name: 'test.csv', size, arrayBuffer: async () => { reads++; return utf8(text).buffer } })
  const change = selected => handleCsvChange({ target: { value: 'test.csv', files: [selected] } })
  await change(file('title\nA', csv.WORLD_CLUE_CSV_MAX_BYTES + 1))
  assert.equal(reads, 0, 'oversized files are rejected before arrayBuffer')
  assert.match(state.notice.value.text, /不能超过 2 MB/)
  for (let index = 0; index < 499; index++) addItem()
  await change(file('title\nA\nB'))
  assert.equal(state.items.value.length, 499, 'over-capacity CSV is rejected atomically')
  assert.match(state.notice.value.text, /当前已有 499 条，CSV 有 2 条；单次批量最多 500 条线索/)
  await change(file('title\nA'))
  assert.equal(state.items.value.length, 500)
  addItem()
  assert.equal(state.items.value.length, 500, 'manual additions cannot exceed the whole-batch limit')
  assert.match(state.notice.value.text, /当前已有 500 条/)
  const readsBefore = reads
  await change(file('title\nB'))
  assert.equal(reads, readsBefore, 'a full batch rejects imports before reading')
  assert.equal(state.items.value.length, 500)
  assert.equal(state.importing.value, false)
}

async function testChangedRefreshes() {
  const { createPinia, setActivePinia } = require('pinia')
  const api = { get: (...args) => getResponse(...args) }
  const storeFile = path.join(root, 'src/stores/worldClue.ts')
  const originalLoad = Module._load
  Module._load = function (request, parent, ...args) {
    if (request === './_config' && parent?.filename === storeFile) return { api }
    return originalLoad.call(this, request, parent, ...args)
  }
  let useWorldClueStore
  try { ({ useWorldClueStore } = require(storeFile)) } finally { Module._load = originalLoad }
  setActivePinia(createPinia())
  const store = useWorldClueStore()
  const realSetTimeout = global.setTimeout
  const realClearTimeout = global.clearTimeout
  const timers = new Map()
  const scheduledDelays = []
  let timerSeed = 0
  global.setTimeout = (callback, delay) => { const id = ++timerSeed; timers.set(id, callback); scheduledDelays.push(delay); return id }
  global.clearTimeout = id => timers.delete(id)
  const settle = async () => { for (let index = 0; index < 12; index++) await Promise.resolve() }
  const tick = async () => {
    const callbacks = [...timers.values()]
    timers.clear()
    callbacks.forEach(callback => callback())
    await settle()
  }
  const calls = []
  let clueItems = []
  let folderItems = []
  let responder = url => Promise.resolve({ data: { items: url.endsWith('/clue-folders') ? folderItems : clueItems } })
  function getResponse(url, options) { calls.push({ url, options }); return responder(url, options) }
  const upsert = (worldId, clueId) => store.handleChanged({ worldId, clueId, action: 'upsert' })
  const deferred = () => {
    let resolve, reject
    const promise = new Promise((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
  }
  try {
    await store.loadWorld('a')

    // Cancelling changed-refresh work must not invalidate an unrelated ordinary load.
    calls.length = 0
    const ordinaryClues = deferred()
    const ordinaryFolders = deferred()
    responder = url => url.endsWith('/clues') ? ordinaryClues.promise : ordinaryFolders.promise
    const ordinaryLoad = store.loadWorld('a')
    await settle()
    store.cancelChangedRefresh('a')
    ordinaryClues.resolve({ data: { items: [{ id: 'ordinary', orderIndex: 1 }] } })
    ordinaryFolders.resolve({ data: { items: [{ id: 'ordinary-folder' }] } })
    await ordinaryLoad
    assert.deepEqual(store.summaries.map(item => item.id), ['ordinary'])
    assert.deepEqual(store.folders.map(item => item.id), ['ordinary-folder'])

    calls.length = 0
    clueItems = [{ id: 'latest', orderIndex: 9 }]
    folderItems = [{ id: 'folder' }]
    responder = url => Promise.resolve({ data: { items: url.endsWith('/clue-folders') ? folderItems : clueItems } })
    for (let index = 0; index < 500; index++) await upsert('a', `c${index}`)
    assert.equal(calls.length, 0)
    assert.equal(timers.size, 1, 'a burst keeps only one short timer')
    assert.ok(scheduledDelays.at(-1) >= 250, 'upsert coalescing keeps a practical quiet window for sequential network requests')
    await tick()
    assert.equal(calls.length, 2, '500 upserts share one clues/folders refresh')
    assert.deepEqual(store.summaries.map(item => item.id), ['latest'])
    assert.deepEqual(store.folders.map(item => item.id), ['folder'])

    calls.length = 0
    const first = deferred()
    let firstClues = true
    responder = url => {
      if (url.endsWith('/clues') && firstClues) { firstClues = false; return first.promise }
      return Promise.resolve({ data: { items: url.endsWith('/clues') ? [{ id: 'final' }] : [] } })
    }
    await upsert('a', 'early')
    await tick()
    for (let index = 0; index < 30; index++) await upsert('a', `late${index}`)
    assert.equal(calls.length, 2, 'no overlapping refresh while a snapshot is in flight')
    first.resolve({ data: { items: [{ id: 'early' }] } })
    await settle()
    assert.equal(timers.size, 1, 'events during the request retain one trailing refresh')
    await tick()
    assert.equal(calls.length, 4)
    assert.deepEqual(store.summaries.map(item => item.id), ['final'], 'the trailing refresh reaches final server state')

    // Special events remain immediate and an older upsert snapshot cannot undo them.
    calls.length = 0
    const stale = deferred()
    responder = url => url.endsWith('/clues') ? stale.promise : Promise.resolve({ data: { items: [] } })
    store.summariesByWorld.a = { removed: { id: 'removed' } }
    await upsert('a', 'removed')
    await tick()
    await store.handleChanged({ worldId: 'a', clueId: 'removed', action: 'remove' })
    assert.equal(store.summariesByWorld.a.removed, undefined, 'remove is immediate')
    assert.equal(calls.length, 2, 'remove does not request a list')
    stale.resolve({ data: { items: [{ id: 'removed' }] } })
    await settle()
    assert.equal(store.summariesByWorld.a.removed, undefined, 'stale upsert cannot resurrect a removed clue')
    responder = url => Promise.resolve({ data: { items: url.endsWith('/clues') ? [{ id: 'current' }] : [{ id: 'new-folder' }] } })
    await tick()

    // Remove supersedes an older ordinary list snapshot but guarantees a trailing final snapshot.
    store.summariesByWorld.a = { removed: { id: 'removed' }, kept: { id: 'kept' } }
    const removeClues = deferred()
    const removeFolders = deferred()
    responder = url => url.endsWith('/clues') ? removeClues.promise : removeFolders.promise
    const staleLoad = store.loadWorld('a')
    await settle()
    await store.handleChanged({ worldId: 'a', clueId: 'removed', action: 'remove' })
    assert.equal(store.summariesByWorld.a.removed, undefined)
    removeClues.resolve({ data: { items: [{ id: 'removed' }, { id: 'kept' }] } })
    removeFolders.resolve({ data: { items: [] } })
    await staleLoad
    assert.equal(store.summariesByWorld.a.removed, undefined, 'the older load cannot resurrect the removed clue')
    responder = url => Promise.resolve({ data: { items: url.endsWith('/clues') ? [{ id: 'kept' }] : [] } })
    await tick()
    assert.deepEqual(store.summaries.map(item => item.id), ['kept'], 'the trailing refresh reaches the authoritative post-remove state')

    responder = url => Promise.resolve({ data: { items: url.endsWith('/clues') ? [{ id: 'current' }] : [{ id: 'new-folder' }] } })
    calls.length = 0
    await store.handleChanged({ worldId: 'a', action: 'reorder' })
    assert.deepEqual(calls.map(call => call.url), ['api/v1/worlds/a/clues'], 'reorder still refreshes clues immediately')
    assert.deepEqual(store.summaries.map(item => item.id), ['current'])
    calls.length = 0
    await store.handleChanged({ worldId: 'a', action: 'folders' })
    assert.equal(calls.length, 2, 'folders still refreshes both lists immediately')
    assert.deepEqual(store.folders.map(item => item.id), ['new-folder'])
    const delayedFolders = deferred()
    const delayedClues = deferred()
    let clueRequests = 0
    responder = url => url.endsWith('/clue-folders') ? delayedFolders.promise
      : ++clueRequests === 1 ? delayedClues.promise : Promise.resolve({ data: { items: [{ id: 'reordered' }] } })
    const foldersChanged = store.handleChanged({ worldId: 'a', action: 'folders' })
    await store.handleChanged({ worldId: 'a', action: 'reorder' })
    delayedFolders.resolve({ data: { items: [{ id: 'latest-folder' }] } })
    delayedClues.resolve({ data: { items: [{ id: 'old-order' }] } })
    await foldersChanged
    assert.deepEqual(store.folders.map(item => item.id), ['latest-folder'], 'reorder cannot suppress an in-flight folders result')
    assert.deepEqual(store.summaries.map(item => item.id), ['reordered'], 'an older folders snapshot cannot undo reorder')
    store.resolveCache.a = { lock: { accessible: true } }
    calls.length = 0
    await store.handleChanged({ worldId: 'a', clueId: 'lock', action: 'edit-lock' })
    assert.equal(calls.length, 0)
    assert.equal(timers.size, 0)
    assert.equal(store.resolveCache.a.lock.accessible, true, 'edit-lock remains a no-op')

    // Order snapshots are unfiltered and do not replace current search results.
    responder = (url, options) => Promise.resolve({ data: { items: url.endsWith('/clue-folders') ? [] : options?.params?.keyword ? [{ id: 'match', orderIndex: 1 }] : [{ id: 'hidden-by-search', orderIndex: 100 }] } })
    await store.loadWorld('a', 'needle')
    const orderSnapshot = await store.fetchSummariesReadonly('a')
    assert.deepEqual(orderSnapshot.map(item => item.orderIndex), [100])
    assert.deepEqual(store.summaries.map(item => item.id), ['match'], 'reading order maxima preserves search state')
    await upsert('a', 'match')
    await tick()
    assert.equal(calls.at(-2).options.params.keyword, 'needle', 'coalescing retains the active search keyword')
    assert.deepEqual(store.summaries.map(item => item.id), ['match'])
    calls.length = 0

    // A different world's events cannot reset this world's timer or issue requests.
    await upsert('a', 'pending')
    const timerId = [...timers.keys()][0]
    await upsert('b', 'other')
    assert.deepEqual([...timers.keys()], [timerId])
    store.setWorld('b')
    assert.equal(timers.size, 0, 'world switch cancels the old timer')
    await upsert('b', 'new')
    await tick()
    assert.equal(calls.length, 2)
    assert.ok(calls.every(call => call.url.includes('/b/')))

    const oldWorld = deferred()
    responder = () => oldWorld.promise
    await upsert('b', 'stale')
    await tick()
    store.setWorld('a')
    store.setWorld('b')
    store.summariesByWorld.b = { kept: { id: 'kept' } }
    oldWorld.resolve({ data: { items: [{ id: 'stale' }] } })
    await settle()
    assert.deepEqual(store.summaries.map(item => item.id), ['kept'], 'switching away and back rejects the previous response')
    assert.equal(timers.size, 0)

    await upsert('b', 'unmounted')
    store.cancelChangedRefresh('b') // Presentation host unmount.
    assert.equal(timers.size, 0)
    const unmounted = deferred()
    responder = () => unmounted.promise
    await upsert('b', 'in-flight-unmount')
    await tick()
    store.cancelChangedRefresh('b')
    unmounted.resolve({ data: { items: [{ id: 'stale' }] } })
    await settle()
    assert.deepEqual(store.summaries.map(item => item.id), ['kept'], 'host cleanup rejects an in-flight snapshot')
    await upsert('b', 'disposed')
    store.$dispose()
    assert.equal(timers.size, 0, 'store disposal cancels timers')
  } finally {
    store.$dispose()
    global.setTimeout = realSetTimeout
    global.clearTimeout = realClearTimeout
  }
}

;(async () => {
  await testImportHandlers()
  await testChangedRefreshes()
  // Each shared folder (including root) appends after its own sparse maximum.
  {
    const items = makeItems(['A', 'B', 'C', 'D', 'E', 'F', 'G'])
    items[1].folderId = items[3].folderId = 'records'
    items[4].folderId = 'evidence'
    items[6].folderId = 'people'
    const summaries = [
      { orderIndex: 3 }, { sharedFolderId: '', orderIndex: 20 },
      { sharedFolderId: 'records', orderIndex: 100 }, { sharedFolderId: 'records', orderIndex: 2 },
      { sharedFolderId: 'evidence', orderIndex: -5 },
    ]
    const { session, created } = makeSession({ summaries })
    await run(items, session)
    assert.deepEqual(created.map(payload => payload.orderIndex), [21, 101, 22, 102, -4, 23, 0])
    assert.deepEqual(items.filter(item => !item.folderId).map(item => item.orderIndex), [21, 22, 23], 'A/C/F keep list order in root')
    const before = items.map(item => item.orderIndex)
    summaries.push({ sharedFolderId: '', orderIndex: 999 })
    await run(items, session)
    assert.deepEqual(items.map(item => item.orderIndex), before, 'created items are never reassigned')
    const [createdWithoutOrder] = makeItems(['legacy-created'])
    createdWithoutOrder.status = 'created'
    batch.assignWorldClueBatchOrder([createdWithoutOrder], summaries)
    assert.equal(createdWithoutOrder.orderIndex, null, 'even an unassigned created item stays untouched')
    const [movedAfterFailure] = makeItems(['move'])
    movedAfterFailure.status = 'failed'
    movedAfterFailure.orderIndex = 7
    movedAfterFailure.issues.folder = 'old import issue'
    batch.setWorldClueBatchFolder(movedAfterFailure, 'records')
    assert.equal(movedAfterFailure.orderIndex, null, 'moving a runnable item clears an order assigned for the old folder')
    assert.equal(movedAfterFailure.issues.folder, undefined)
    batch.assignWorldClueBatchOrder([movedAfterFailure], [{ sharedFolderId: 'records', orderIndex: 100 }])
    assert.equal(movedAfterFailure.orderIndex, 101, 'retry appends after the new folder maximum')
    batch.setWorldClueBatchFolder(movedAfterFailure, 'records')
    assert.equal(movedAfterFailure.orderIndex, 101, 'reselecting the same folder keeps the stable retry order')
  }

  // One failure does not block later items; a retry never re-creates successes.
  {
    const items = makeItems(['A', 'B', 'C', 'D'])
    const failCreate = new Set(['B'])
    const { session, created } = makeSession({ failCreate })
    const settled = []
    const result = await run(items, session, { onItemSettled: (item) => settled.push(`${item.title}:${item.status}`) })
    assert.deepEqual(result, { created: 3, failed: 1, stopped: false, stopReason: null })
    assert.deepEqual(settled, ['A:created', 'B:failed', 'C:created', 'D:created'])
    assert.equal(items[1].error, '服务器拒绝 B')
    assert.deepEqual(created.map((payload) => payload.title), ['A', 'C', 'D'])
    assert.deepEqual(items.map(item => item.orderIndex), [0, 1, 2, 3], 'A/B/C/D receive increasing order before execution')
    const originalOrders = items.map(item => item.orderIndex)
    session.summaries = () => [{ sharedFolderId: '', orderIndex: 900 }]
    failCreate.clear()
    const retry = await run(items, session)
    assert.deepEqual(retry, { created: 1, failed: 0, stopped: false, stopReason: null })
    assert.deepEqual(created.map((payload) => payload.title), ['A', 'C', 'D', 'B'], 'only the failed item ran again')
    assert.deepEqual(items.map(item => item.orderIndex), originalOrders, 'retry preserves all first assignments despite remote changes')
    assert.equal(created.at(-1).orderIndex, 1, 'retry payload keeps B between A and C')
    const [added] = makeItems(['E'])
    batch.assignWorldClueBatchOrder([...items, added], [])
    assert.equal(added.orderIndex, 4, 'new items reserve previous assignments even when absent from summaries')
    assert.deepEqual(items.map((item) => item.clueId), ['clue-A', 'clue-B', 'clue-C', 'clue-D'])
    const again = await run(items, session)
    assert.deepEqual(again, { created: 0, failed: 0, stopped: false, stopReason: null })
    assert.equal(created.length, 4, 'a completed batch creates nothing on another run')
  }

  // Uploads happen once: a create failure after a successful upload reuses the attachment.
  {
    const [item, other] = makeItems(['图', '坏上传'])
    item.imageFile = { name: 'a.png', type: 'image/png', size: 1 }
    other.imageFile = { name: 'b.png', type: 'image/png', size: 1 }
    const failCreate = new Set(['图'])
    const { session, created, uploads } = makeSession({ failCreate, failUpload: new Set(['b.png']) })
    const first = await run([item, other], session)
    assert.deepEqual(first, { created: 0, failed: 2, stopped: false, stopReason: null })
    assert.equal(item.attachmentId, 'att-a.png')
    assert.equal(other.error, '上传被拒绝')
    failCreate.clear()
    await run([item], session)
    assert.deepEqual(uploads, ['a.png', 'b.png'], 'retry did not upload a.png again')
    assert.equal(created[0].imageAttachmentId, 'att-a.png')
    assert.equal(created[0].kind, 'image')
  }

  // Invalid items fail defensively instead of reaching the API.
  {
    const items = makeItems(['', 'ok'])
    items[1].issues.folder = '未找到文件夹“x”'
    const valid = makeItems(['fine'])[0]
    const { session, created } = makeSession()
    const result = await run([...items, valid], session)
    assert.deepEqual(result, { created: 1, failed: 2, stopped: false, stopReason: null })
    assert.equal(items[0].error, '标题不能为空')
    assert.equal(items[1].error, '未找到文件夹“x”')
    assert.deepEqual(created.map((payload) => payload.title), ['fine'])
  }

  // User stop: the in-flight item finishes, the rest stay pending.
  {
    const items = makeItems(['A', 'B', 'C'])
    let cancelled = false
    const { session, created } = makeSession({ onCreate: (payload) => { if (payload.title === 'A') cancelled = true } })
    const result = await run(items, session, { isCancelled: () => cancelled })
    assert.deepEqual(result, { created: 1, failed: 0, stopped: true, stopReason: 'user' })
    assert.deepEqual(items.map((item) => item.status), ['created', 'pending', 'pending'])
    cancelled = false
    await run(items, session)
    assert.deepEqual(created.map((payload) => payload.title), ['A', 'B', 'C'])
  }

  // Scope loss (world switch / permission change) after an upload stops before creating.
  {
    const items = makeItems(['A', 'B'])
    items[0].imageFile = { name: 'a.png', type: 'image/png', size: 1 }
    const harness = makeSession({ onUpload: () => harness.setCurrent(false) })
    const result = await run(items, harness.session)
    assert.deepEqual(result, { created: 0, failed: 0, stopped: true, stopReason: 'context' })
    assert.equal(harness.created.length, 0, 'nothing is created in a stale world')
    assert.equal(items[0].status, 'pending')
    assert.equal(items[0].attachmentId, 'att-a.png')
    const before = makeSession()
    before.setCurrent(false)
    const blocked = await run(makeItems(['X']), before.session)
    assert.deepEqual(blocked, { created: 0, failed: 0, stopped: true, stopReason: 'context' })
    assert.equal(before.created.length, 0)
  }

  // A failed create during scope loss is recorded, then the run stops.
  {
    const items = makeItems(['A', 'B'])
    const harness = makeSession({ failCreate: new Set(['A']), onCreate: () => harness.setCurrent(false) })
    const result = await run(items, harness.session)
    assert.deepEqual(result, { created: 0, failed: 1, stopped: true, stopReason: 'context' })
    assert.deepEqual(items.map((item) => item.status), ['failed', 'pending'])
  }

  console.log('world clue batch create regression: ok')
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
