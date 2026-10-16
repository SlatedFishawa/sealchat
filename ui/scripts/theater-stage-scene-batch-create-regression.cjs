// Scene batch create regression: file name/ordering/filter helpers, first-level
// directory -> scene folder mapping, StageStore.appendScene initial state, the
// sequential runner (partial success, retry, stop, scope loss) and addScene.
// Run with node scripts/theater-stage-scene-batch-create-regression.cjs.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')
const root = path.resolve(__dirname, '..')
const originalLoad = Module._load
const originalResolve = Module._resolveFilename
Module._load = function (request, ...args) {
  if (request === '@/stores/_config') return { api: {}, urlBase: '' }
  if (request === '@/stores/chat') return { chatEvent: { on() {}, off() {} } }
  return originalLoad.call(this, request, ...args)
}
Module._resolveFilename = function (request, parent, ...args) {
  if (request.startsWith('@/')) request = path.join(root, 'src', request.slice(2))
  return originalResolve.call(this, request, parent, ...args)
}
const transpile = (source, fileName = 'inline.ts') => ts.transpileModule(source, {
  fileName, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText
require.extensions['.ts'] = (module, filename) => module._compile(transpile(fs.readFileSync(filename, 'utf8'), filename), filename)
global.crypto ||= require('node:crypto').webcrypto

const batch = require('../src/views/theater/stage/stage-scene-batch-create.ts')
const { createTheaterStageStore, createDefaultSceneBackgroundStyle, DEFAULT_NEW_SCENE_COLOR } = require('../src/views/theater/stage/StageStore.ts')
const { surfaceVariantsFor } = require('../src/views/theater/shared/stage-surface-variants.ts')
const { theaterSyncTesting: sync } = require('../src/views/theater/sync/TheaterSyncClient.ts')

const file = (name, { type = '', relativePath = '', size = 10, lastModified = 1 } = {}) => ({ name, type, size, lastModified, webkitRelativePath: relativePath })
const image = (id) => ({ resourceId: id, url: `https://example.com/${id}.webp`, mimeType: 'image/webp' })
const orderedNames = (store) => store.scenes.value.map((scene) => scene.name)
const batchStyle = () => ({ ...createDefaultSceneBackgroundStyle(), fit: 'contain', opacity: 0.5, blurPx: 0, brightness: 1.2, zoom: 1.5, overlay: { enabled: true, color: '#112233', opacity: 0.3 } })

// --- Scene names from file names -------------------------------------------
{
  assert.equal(batch.sceneNameFromFileName('酒馆.png'), '酒馆')
  assert.equal(batch.sceneNameFromFileName('forest.night.webp'), 'forest.night', 'only the last extension is removed')
  assert.equal(batch.sceneNameFromFileName('  空白  .jpg'), '空白')
  assert.equal(batch.sceneNameFromFileName('README'), 'README')
  assert.equal(batch.sceneNameFromFileName('.png'), '未命名场景', 'empty base name falls back')
  assert.equal(batch.sceneNameFromFileName('dir/sub/城门.gif'), '城门')
  assert.equal([...batch.sceneNameFromFileName(`${'长'.repeat(600)}.png`)].length, 512)
  assert.equal(batch.sceneNameError('  '), '场景名称不能为空')
  assert.match(batch.sceneNameError('x'.repeat(513)), /512/)
  assert.equal(batch.sceneNameError(' 正常 '), '')
}

// --- Relative paths and first-level directories ------------------------------
{
  assert.equal(batch.normalizeSceneBatchRelativePath({ webkitRelativePath: 'Pick\\Sub\\a.png' }), 'Pick/Sub/a.png')
  assert.equal(batch.normalizeSceneBatchRelativePath({}), '')
  assert.equal(batch.sceneBatchTopDirectory('Pick/a.png'), '', 'files directly inside the picked directory')
  assert.equal(batch.sceneBatchTopDirectory('Pick/Sub/a.png'), 'Sub')
  assert.equal(batch.sceneBatchTopDirectory('Pick/Sub/Deep/a.png'), 'Sub', 'deeper levels collapse into the first level')
  assert.equal(batch.sceneBatchTopDirectory('a.png'), '')
  assert.equal(batch.sceneBatchTopDirectory(''), '')
}

// --- Supported filtering, stable ordering, duplicates ------------------------
{
  assert.equal(batch.isSupportedSceneBackgroundFile(file('a.JPG')), true, 'extension fallback when type is empty')
  assert.equal(batch.isSupportedSceneBackgroundFile(file('clip.webm')), true)
  assert.equal(batch.isSupportedSceneBackgroundFile(file('x', { type: 'image/png' })), true)
  assert.equal(batch.isSupportedSceneBackgroundFile(file('doc.pdf', { type: 'application/pdf' })), false)
  assert.equal(batch.isSupportedSceneBackgroundFile(file('.DS_Store')), false)
  assert.equal(batch.isSupportedSceneBackgroundFile(file('photo.bmp', { type: 'image/bmp' })), false)

  const picked = [
    file('scene10.png'), file('scene2.png'), file('notes.txt', { type: 'text/plain' }), file('Scene1.png'), file('scene2.png'),
  ]
  const first = batch.collectSceneBatchFiles(picked)
  assert.deepEqual(first.items.map((item) => item.fileName), ['Scene1.png', 'scene2.png', 'scene10.png'], 'numeric, case-insensitive order')
  assert.deepEqual(first.items.map((item) => item.name), ['Scene1', 'scene2', 'scene10'])
  assert.deepEqual(first.unsupported, ['notes.txt'])
  assert.equal(first.duplicates, 1)
  assert.ok(first.items.every((item) => item.status === 'pending' && !item.uploaded && !item.sceneId && !item.topDirectory))

  const again = batch.collectSceneBatchFiles([file('scene2.png'), file('scene3.png')], new Set(first.items.map((item) => item.key)))
  assert.deepEqual(again.items.map((item) => item.fileName), ['scene3.png'], 'already listed files are skipped')
  assert.equal(again.duplicates, 1)

  const directory = batch.collectSceneBatchFiles([
    file('b.png', { relativePath: 'Pick/Town/b.png' }),
    file('root.png', { relativePath: 'Pick/root.png' }),
    file('a.png', { relativePath: 'Pick/Town/a.png' }),
    file('c.png', { relativePath: 'Pick/Forest/Night/c.png' }),
    file('Thumbs.db', { relativePath: 'Pick/Town/Thumbs.db' }),
  ])
  assert.deepEqual(directory.items.map((item) => item.relativePath), ['Pick/Forest/Night/c.png', 'Pick/root.png', 'Pick/Town/a.png', 'Pick/Town/b.png'])
  assert.deepEqual(directory.items.map((item) => item.topDirectory), ['Forest', '', 'Town', 'Town'])
  assert.deepEqual(directory.unsupported, ['Pick/Town/Thumbs.db'])
  // Same name in different directories is not a duplicate.
  const sameName = batch.collectSceneBatchFiles([
    file('bg.png', { relativePath: 'Pick/A/bg.png' }), file('bg.png', { relativePath: 'Pick/B/bg.png' }),
  ])
  assert.equal(sameName.items.length, 2)
  // An empty or fully unsupported directory selection yields nothing.
  assert.deepEqual(batch.collectSceneBatchFiles([]).items, [])
  assert.equal(batch.collectSceneBatchFiles([file('a.txt', { relativePath: 'Pick/a.txt' })]).items.length, 0)
}

// --- Folder planning ---------------------------------------------------------
{
  const folders = [{ id: 'f-town', name: 'Town' }, { id: 'f-target', name: '目标' }]
  assert.deepEqual(batch.planSceneBatchFolder('Town', false, folders, 'f-target'), { folderId: 'f-target' }, 'mapping off keeps the target')
  assert.deepEqual(batch.planSceneBatchFolder('', true, folders, 'f-target'), { folderId: 'f-target' }, 'root files keep the target')
  assert.deepEqual(batch.planSceneBatchFolder('', true, folders, ''), { folderId: '' }, 'root files may stay 未分类')
  assert.deepEqual(batch.planSceneBatchFolder('Town', true, folders, ''), { folderId: 'f-town' }, 'same-name folder is reused')
  assert.deepEqual(batch.planSceneBatchFolder('Forest', true, folders, ''), { createFolderName: 'Forest' })
}

// --- StageStore.appendScene ---------------------------------------------------
{
  const store = createTheaterStageStore()
  const activeBefore = store.state.activeSceneId
  const liveBefore = JSON.stringify(store.state.liveState)
  const folder = store.createSceneFolder('批量')
  const style = batchStyle()
  const sceneId = store.appendScene({ name: ' 酒馆夜 ', folderId: folder.id, backgroundColor: '#000000', backgroundStyle: style, background: { image: image('night') } })
  assert.ok(sceneId)
  assert.equal(store.state.activeSceneId, activeBefore, 'append does not switch scenes')
  assert.equal(JSON.stringify(store.state.liveState), liveBefore, 'liveState untouched')
  const scene = store.state.scenes[sceneId]
  assert.equal(scene.name, '酒馆夜')
  assert.equal(scene.folderId, folder.id)
  assert.deepEqual(store.scenes.value.map((item) => item.order), [0, 1, 2])
  assert.equal(store.scenes.value[2].id, sceneId, 'appended last')
  const variants = surfaceVariantsFor(scene.state, 'background')
  assert.equal(variants.slots.length, 1)
  assert.equal(variants.slots[0].image.resourceId, 'night')
  assert.equal(variants.activeId, variants.slots[0].id)
  assert.deepEqual(scene.state.background, variants.slots.find((slot) => slot.id === variants.activeId).image, 'state.background mirrors the active slot')
  assert.deepEqual(scene.state.surfaceStyles.background, style)
  assert.equal(scene.state.backgroundColor, '#000000')

  // Everything else matches a regular new scene.
  const reference = createTheaterStageStore()
  reference.addScene()
  const plain = reference.activeScene.value.state
  assert.equal(scene.state.foreground, null)
  assert.equal(scene.state.surfaceVariants.foreground, undefined)
  assert.deepEqual(scene.state.surfaceStyles.foreground, plain.surfaceStyles.foreground)
  assert.deepEqual(scene.state.transition, plain.transition)
  assert.deepEqual(scene.state.surfaceEmbeds, plain.surfaceEmbeds)
  assert.equal(scene.state.switchAudio, null)
  assert.equal(scene.state.musicSnapshot, null)
  assert.deepEqual(scene.state.sceneOverlays, [])
  assert.deepEqual(Object.values(scene.state.sceneObjects).map((object) => [object.type, object.text]), [['text', '酒馆夜']])
  assert.equal(scene.published, false)

  // Defaults when only a name is given.
  const minimal = store.state.scenes[store.appendScene({ name: '空场景' })]
  assert.equal(minimal.state.backgroundColor, DEFAULT_NEW_SCENE_COLOR)
  assert.deepEqual(minimal.state.surfaceStyles.background, createDefaultSceneBackgroundStyle())
  assert.equal(minimal.state.background, null)
  assert.equal(minimal.state.surfaceVariants, undefined)
  assert.equal(minimal.folderId, undefined)

  // Rejections leave the workspace untouched.
  const count = Object.keys(store.state.scenes).length
  assert.equal(store.appendScene({ name: '   ' }), null)
  assert.equal(store.appendScene({ name: 'x'.repeat(513) }), null)
  assert.equal(store.appendScene({ name: '无效文件夹', folderId: 'missing' }), null)
  assert.equal(store.appendScene({ name: '坏图片', background: { image: { resourceId: 'x', url: 'javascript:alert(1)' } } }), null)
  assert.equal(store.appendScene({ name: '空图片', background: { image: null } }), null)
  assert.equal(Object.keys(store.state.scenes).length, count)
  assert.equal(store.state.activeSceneId, activeBefore)

  // Sync emits a regular scene.create carrying folder and initial state.
  const before = sync.documentFromWorkspace(store.getSnapshot())
  const syncedId = store.appendScene({ name: '同步', folderId: folder.id, background: { image: image('sync') } })
  const mutations = sync.diffDocuments(before, sync.documentFromWorkspace(store.getSnapshot()))
  const plainBefore = sync.documentFromWorkspace(reference.getSnapshot())
  reference.addScene()
  const plainMutations = sync.diffDocuments(plainBefore, sync.documentFromWorkspace(reference.getSnapshot()))
  assert.deepEqual(plainMutations.map((mutation) => mutation.type), ['scene.create', 'object.create', 'scene.apply'], 'addScene also switches')
  assert.deepEqual(mutations.map((mutation) => mutation.type), ['scene.create', 'object.create'], 'append creates without scene.apply')
  assert.equal(mutations[0].payload.sceneId, syncedId)
  assert.equal(mutations[0].payload.folderId, folder.id)
  assert.equal(mutations[0].payload.order, 4)
  assert.equal(mutations[0].payload.state.background.resourceId, 'sync')
  assert.equal(mutations[0].payload.state.surfaceVariants.background.slots[0].image.resourceId, 'sync')
}

// --- addScene keeps its behavior ----------------------------------------------
{
  const store = createTheaterStageStore()
  const previous = store.state.activeSceneId
  store.selectObject(Object.keys(store.state.liveState.sceneObjects)[0])
  store.addScene()
  const scene = store.activeScene.value
  assert.notEqual(store.state.activeSceneId, previous, 'addScene activates the new scene')
  assert.equal(scene.name, '场景 3')
  assert.equal(scene.order, 2)
  assert.equal(scene.state.backgroundColor, '#172033')
  assert.equal(scene.state.background, null)
  assert.equal(scene.folderId, undefined)
  assert.deepEqual(scene.state.surfaceStyles.background, createDefaultSceneBackgroundStyle())
  assert.equal(JSON.stringify(store.state.liveState), JSON.stringify(scene.state))
  assert.equal(store.state.selectedObjectId, null, 'selection cleared')
  store.addScene()
  assert.deepEqual(orderedNames(store), ['序幕', '酒馆', '场景 3', '场景 4'])
}

// --- Runner -------------------------------------------------------------------
const createSession = (store, { failNames = new Set(), current = () => true, onUpload } = {}) => {
  const uploads = []
  return {
    uploads,
    session: {
      isCurrent: current,
      upload: async (item) => {
        uploads.push(item.name)
        await onUpload?.(item)
        if (failNames.has(item.name)) throw new Error(`上传失败：${item.name}`)
        return image(item.name.replace(/\W/g, '_'))
      },
      createScene: (options) => store.appendScene(options),
      createFolder: (name) => store.createSceneFolder(name),
      folders: () => store.state.sceneFolders,
    },
  }
}
const config = (overrides = {}) => ({ targetFolderId: '', mapTopDirectories: false, backgroundStyle: batchStyle(), backgroundColor: '#101010', ...overrides })

;(async () => {
  // Partial success, then retry only the failed item.
  {
    const store = createTheaterStageStore()
    const activeBefore = store.state.activeSceneId
    const { items } = batch.collectSceneBatchFiles([file('c.png'), file('a.png'), file('b.png')])
    const failNames = new Set(['b.png'])
    const { session, uploads } = createSession(store, { failNames })
    const started = []
    const result = await batch.runSceneBatch(items, session, config(), { isCancelled: () => false, onItemStart: (item) => started.push(item.fileName) })
    assert.deepEqual(result, { created: 2, failed: 1, stopped: false })
    assert.deepEqual(started, ['a.png', 'b.png', 'c.png'], 'list order')
    assert.deepEqual(items.map((item) => item.status), ['created', 'failed', 'created'])
    assert.equal(items[1].error, '上传失败：b.png')
    assert.deepEqual(orderedNames(store), ['序幕', '酒馆', 'a', 'c'], 'failure does not roll back earlier scenes')
    assert.equal(store.state.activeSceneId, activeBefore, 'batch never switches the active scene')
    assert.ok(store.scenes.value.every((scene, index) => scene.order === index))
    const created = store.state.scenes[items[0].sceneId]
    assert.equal(created.state.backgroundColor, '#101010')
    assert.equal(created.state.surfaceStyles.background.fit, 'contain')

    failNames.clear()
    const retry = await batch.runSceneBatch(items, session, config(), { isCancelled: () => false })
    assert.deepEqual(retry, { created: 1, failed: 0, stopped: false })
    assert.deepEqual(uploads, ['a.png', 'b.png', 'c.png', 'b.png'], 'created items are not processed again')
    assert.deepEqual(orderedNames(store), ['序幕', '酒馆', 'a', 'c', 'b'])
    assert.equal(items[1].error, '')
  }

  // Upload succeeded but scene creation failed: retry reuses the uploaded image.
  {
    const store = createTheaterStageStore()
    const folder = store.createSceneFolder('目标')
    const { items } = batch.collectSceneBatchFiles([file('x.png')])
    const { session, uploads } = createSession(store)
    store.deleteSceneFolder(folder.id)
    const first = await batch.runSceneBatch(items, session, config({ targetFolderId: folder.id }), { isCancelled: () => false })
    assert.deepEqual(first, { created: 0, failed: 1, stopped: false })
    assert.match(items[0].error, /文件夹/)
    assert.equal(items[0].uploaded.resourceId, 'x_png')
    const second = await batch.runSceneBatch(items, session, config(), { isCancelled: () => false })
    assert.equal(second.created, 1)
    assert.deepEqual(uploads, ['x.png'], 'no second upload')
  }

  // First-level directories map to scene folders through createSceneFolder.
  {
    const store = createTheaterStageStore()
    const existing = store.createSceneFolder('Town')
    const target = store.createSceneFolder('目标')
    const foldersBefore = store.state.sceneFolders.length
    const { items } = batch.collectSceneBatchFiles([
      file('a.png', { relativePath: 'Pick/Town/a.png' }),
      file('b.png', { relativePath: 'Pick/Forest/Deep/b.png' }),
      file('c.png', { relativePath: 'Pick/Forest/c.png' }),
      file('r.png', { relativePath: 'Pick/r.png' }),
    ])
    const { session } = createSession(store)
    const result = await batch.runSceneBatch(items, session, config({ mapTopDirectories: true, targetFolderId: target.id }), { isCancelled: () => false })
    assert.equal(result.created, 4)
    assert.equal(store.state.sceneFolders.length, foldersBefore + 1, 'only Forest is created, once')
    const forest = store.state.sceneFolders.find((folder) => folder.name === 'Forest')
    const folderOf = (name) => Object.values(store.state.scenes).find((scene) => scene.name === name).folderId
    assert.equal(folderOf('a'), existing.id)
    assert.equal(folderOf('b'), forest.id)
    assert.equal(folderOf('c'), forest.id)
    assert.equal(folderOf('r'), target.id)
    const persisted = JSON.stringify(store.getSnapshot())
    assert.equal(persisted.includes('Pick/'), false, 'local paths never reach scene data')

    // Mapping disabled ignores directories.
    const plainStore = createTheaterStageStore()
    const plainItems = batch.collectSceneBatchFiles([file('a.png', { relativePath: 'Pick/Town/a.png' })]).items
    await batch.runSceneBatch(plainItems, createSession(plainStore).session, config(), { isCancelled: () => false })
    assert.equal(plainStore.state.sceneFolders.length, 0)
    assert.equal(plainStore.state.scenes[plainItems[0].sceneId].folderId, undefined)
  }

  // Folder limits follow the store: a refused folder fails only its items.
  {
    const store = createTheaterStageStore()
    for (let index = 0; index < 200; index += 1) store.createSceneFolder(`F${index}`)
    const { items } = batch.collectSceneBatchFiles([
      file('a.png', { relativePath: 'Pick/New/a.png' }),
      file('b.png', { relativePath: 'Pick/F3/b.png' }),
    ])
    const result = await batch.runSceneBatch(items, createSession(store).session, config({ mapTopDirectories: true }), { isCancelled: () => false })
    assert.deepEqual(result, { created: 1, failed: 1, stopped: false })
    assert.equal(items[0].status, 'created', 'existing F3 is reused')
    assert.equal(items[1].status, 'failed')
    assert.match(items[1].error, /无法创建场景文件夹“New”/)
    assert.equal(store.state.sceneFolders.length, 200)
  }

  // Stop request: in-flight upload finishes but its scene is not created.
  {
    const store = createTheaterStageStore()
    let stop = false
    const { items } = batch.collectSceneBatchFiles([file('a.png'), file('b.png'), file('c.png')])
    const { session } = createSession(store, { onUpload: (item) => { if (item.name === 'b.png') stop = true } })
    const result = await batch.runSceneBatch(items, session, config(), { isCancelled: () => stop })
    assert.deepEqual(result, { created: 1, failed: 0, stopped: true })
    assert.deepEqual(items.map((item) => item.status), ['created', 'pending', 'pending'])
    assert.deepEqual(orderedNames(store), ['序幕', '酒馆', 'a'])
  }

  // Scope change mid-upload: nothing is written into the new context.
  {
    const store = createTheaterStageStore()
    let current = true
    const { items } = batch.collectSceneBatchFiles([file('a.png'), file('b.png')])
    const { session } = createSession(store, { current: () => current, onUpload: () => { current = false } })
    const scenesBefore = Object.keys(store.state.scenes).length
    const result = await batch.runSceneBatch(items, session, config(), { isCancelled: () => false })
    assert.deepEqual(result, { created: 0, failed: 0, stopped: true })
    assert.equal(Object.keys(store.state.scenes).length, scenesBefore)
    assert.deepEqual(items.map((item) => item.status), ['pending', 'pending'])
    // An upload error after the scope changed is a stop, not a failure.
    current = true
    const failing = createSession(store, { failNames: new Set(['a.png']), current: () => current, onUpload: () => { current = false } })
    const failed = await batch.runSceneBatch(items, failing.session, config(), { isCancelled: () => false })
    assert.deepEqual(failed, { created: 0, failed: 0, stopped: true })
    assert.equal(items[0].status, 'pending')
  }

  // Scope loss during the synchronous create capability is a stop, not a failed item.
  {
    const store = createTheaterStageStore()
    const { items } = batch.collectSceneBatchFiles([file('a.png')])
    let current = true
    const base = createSession(store).session
    const session = {
      ...base,
      isCurrent: () => current,
      createScene: (options) => {
        current = false
        return null
      },
    }
    const result = await batch.runSceneBatch(items, session, config(), { isCancelled: () => false })
    assert.deepEqual(result, { created: 0, failed: 0, stopped: true })
    assert.equal(items[0].status, 'pending')
    assert.ok(items[0].uploaded, 'successful upload is retained for retry')
  }

  // Invalid names fail before any upload.
  {
    const store = createTheaterStageStore()
    const { items } = batch.collectSceneBatchFiles([file('a.png')])
    items[0].name = '  '
    const { session, uploads } = createSession(store)
    const result = await batch.runSceneBatch(items, session, config(), { isCancelled: () => false })
    assert.deepEqual(result, { created: 0, failed: 1, stopped: false })
    assert.deepEqual(uploads, [])
    assert.equal(items[0].error, '场景名称不能为空')
  }

  console.log('theater stage scene batch create regression passed')
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
