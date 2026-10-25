// Scene Browser (list/grid) regression: local preferences, search and folder
// filtering, grid folder fallback, atomic StageStore moves, drag targets while
// searching, and StageApp's view switch keeping edit/batch state.
// Run with node scripts/theater-stage-scene-browser-regression.cjs.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')
const { parse } = require('@vue/compiler-sfc')
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

const { ref } = require('vue')
const browser = require('../src/views/theater/stage/stage-scene-browser.ts')
const { createTheaterStageStore } = require('../src/views/theater/stage/StageStore.ts')
const { theaterSyncTesting: sync } = require('../src/views/theater/sync/TheaterSyncClient.ts')
const { resolveTheaterStageThumbnailLocation } = require('../src/views/theater/stage/stage-media.ts')

const memoryStorage = () => {
  const values = new Map()
  return { values, getItem: (key) => values.has(key) ? values.get(key) : null, setItem: (key, value) => values.set(key, String(value)) }
}
const names = (entries) => entries.map((entry) => entry.kind === 'scene' ? entry.scene.name : `[${entry.kind === 'folder' ? entry.folder.name : '未分类'}]`)
const orderedNames = (store) => store.scenes.value.map((scene) => scene.name)

// --- View mode / thumbnail size preferences -------------------------------
{
  const storage = memoryStorage()
  assert.equal(browser.readSceneBrowserViewMode(storage), 'list')
  assert.equal(browser.readSceneBrowserThumbSize(storage), 'medium')
  browser.writeSceneBrowserViewMode('grid', storage)
  browser.writeSceneBrowserThumbSize('large', storage)
  assert.equal(storage.values.get('sealchat.theater.scene-browser.view-mode.v1'), 'grid')
  assert.equal(storage.values.get('sealchat.theater.scene-browser.thumb-size.v1'), 'large')
  assert.equal(browser.readSceneBrowserViewMode(storage), 'grid')
  assert.equal(browser.readSceneBrowserThumbSize(storage), 'large')
  storage.setItem(browser.sceneBrowserViewModeStorageKey, '"grid"')
  storage.setItem(browser.sceneBrowserThumbSizeStorageKey, 'huge')
  assert.equal(browser.readSceneBrowserViewMode(storage), 'list', 'invalid stored view mode falls back')
  assert.equal(browser.readSceneBrowserThumbSize(storage), 'medium', 'invalid stored size falls back')
  const throwing = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') } }
  assert.equal(browser.readSceneBrowserViewMode(throwing), 'list')
  assert.doesNotThrow(() => browser.writeSceneBrowserThumbSize('small', throwing))
  assert.equal(browser.readSceneBrowserViewMode(null), 'list')
  // No window in Node: default storage is unavailable and must not throw.
  assert.equal(browser.readSceneBrowserThumbSize(), 'medium')
  assert.doesNotThrow(() => browser.writeSceneBrowserViewMode('grid'))
}

// --- Fixture --------------------------------------------------------------
const createFixture = () => {
  const store = createTheaterStageStore()
  store.scenes.value.slice(1).forEach((scene) => store.removeScene(scene.id))
  const first = store.scenes.value[0]
  assert.equal(store.scenes.value.length, 1)
  store.updateSceneDetails(first.id, 'Castle', '')
  const forest = store.createSceneFolder('Forest')
  const town = store.createSceneFolder('Town')
  const empty = store.createSceneFolder('Empty')
  const add = (name, folder) => {
    store.addScene()
    const scene = store.activeScene.value
    store.updateSceneDetails(scene.id, name, '')
    if (folder) assert.equal(store.moveSceneToFolder(scene.id, folder.id), true)
    return scene
  }
  const scenes = {
    castle: first,
    day: add('Forest Day', forest),
    night: add('Forest Night', town),
    village: add('Village', forest),
    gate: add('Town Gate', town),
  }
  return { store, folders: { forest, town, empty }, scenes }
}

// --- Search and folder filtering ------------------------------------------
{
  const { store, folders } = createFixture()
  const list = (query, collapsed = new Set(), includeEmptyFolders = true) => browser.buildSceneListEntries({
    scenes: store.scenes.value,
    folders: store.state.sceneFolders,
    normalizedQuery: browser.normalizeSceneSearchQuery(query),
    isCollapsed: (folderId) => collapsed.has(folderId),
    includeEmptyFolders,
  })
  assert.deepEqual(names(list('')), ['[Forest]', 'Forest Day', 'Village', '[Town]', 'Forest Night', 'Town Gate', '[Empty]', '[未分类]', 'Castle'])
  assert.deepEqual(names(list('', new Set([folders.forest.id, '']))), ['[Forest]', '[Town]', 'Forest Night', 'Town Gate', '[Empty]', '[未分类]'])
  assert.deepEqual(names(list('', new Set(), false)), ['[Forest]', 'Forest Day', 'Village', '[Town]', 'Forest Night', 'Town Gate', '[未分类]', 'Castle'])
  // Searching keeps folder grouping, hides folders without matches and
  // ignores collapse so matches stay reachable.
  assert.deepEqual(names(list('  FOREST ', new Set([folders.forest.id]))), ['[Forest]', 'Forest Day', '[Town]', 'Forest Night'])
  assert.deepEqual(names(list('castle')), ['[未分类]', 'Castle'])
  assert.deepEqual(names(list('nothing')), [])
  const forestHeader = list('forest').find((entry) => entry.kind === 'folder' && entry.folder.id === folders.forest.id)
  assert.equal(forestHeader.scenes.length, 1, 'folder count reflects search matches')
  assert.equal(forestHeader.collapsed, false)

  const grid = (folderId, query) => browser.buildSceneGridEntries(store.scenes.value, store.state.sceneFolders, folderId, browser.normalizeSceneSearchQuery(query))
  assert.deepEqual(grid(folders.forest.id, '').map((entry) => [entry.scene.name, entry.folderName]), [['Forest Day', null], ['Village', null]])
  assert.deepEqual(grid('', '').map((entry) => entry.scene.name), ['Castle'])
  assert.deepEqual(grid(folders.empty.id, ''), [])
  // Grid search is global across folders and labels each result's folder.
  assert.deepEqual(grid(folders.empty.id, 'E').map((entry) => [entry.scene.name, entry.folderName]), [
    ['Castle', '未分类'],
    ['Forest Day', 'Forest'],
    ['Forest Night', 'Town'],
    ['Village', 'Forest'],
    ['Town Gate', 'Town'],
  ])
  assert.deepEqual(grid('', 'night').map((entry) => entry.scene.name), ['Forest Night'])
}

// --- Grid folder tabs and deletion fallback -------------------------------
{
  const { store, folders } = createFixture()
  const tabs = () => browser.buildSceneGridFolderTabs(store.state.sceneFolders, store.scenes.value).map((tab) => [tab.id, tab.name, tab.count])
  assert.deepEqual(tabs(), [[folders.forest.id, 'Forest', 2], [folders.town.id, 'Town', 2], [folders.empty.id, 'Empty', 0], ['', '未分类', 1]])
  assert.equal(browser.resolveSceneGridFolderId(folders.town.id, store.state.sceneFolders), folders.town.id)
  assert.equal(browser.resolveSceneGridFolderId(null, store.state.sceneFolders), '')
  assert.equal(browser.resolveSceneGridFolderId('', store.state.sceneFolders), '')
  assert.equal(store.deleteSceneFolder(folders.town.id), true)
  assert.equal(browser.resolveSceneGridFolderId(folders.town.id, store.state.sceneFolders), '', 'deleted folder falls back to 未分类')
  assert.deepEqual(tabs(), [[folders.forest.id, 'Forest', 2], [folders.empty.id, 'Empty', 0], ['', '未分类', 3]])
  assert.deepEqual(
    browser.buildSceneGridEntries(store.scenes.value, store.state.sceneFolders, browser.resolveSceneGridFolderId(folders.town.id, store.state.sceneFolders), '').map((entry) => entry.scene.name),
    ['Castle', 'Forest Night', 'Town Gate'],
  )
}

// --- Atomic move + reorder ------------------------------------------------
{
  const { store, folders, scenes } = createFixture()
  assert.deepEqual(orderedNames(store), ['Castle', 'Forest Day', 'Forest Night', 'Village', 'Town Gate'])
  const before = sync.documentFromWorkspace(store.getSnapshot())
  // Drop "Town Gate" before "Forest Day": adopts Forest and the new position.
  assert.equal(store.moveScene(scenes.gate.id, { kind: 'scene', sceneId: scenes.day.id, placement: 'before' }), true)
  assert.equal(store.state.scenes[scenes.gate.id].folderId, folders.forest.id)
  assert.deepEqual(orderedNames(store), ['Castle', 'Town Gate', 'Forest Day', 'Forest Night', 'Village'])
  assert.deepEqual(store.scenes.value.map((scene) => scene.order), [0, 1, 2, 3, 4])
  const mutations = sync.diffDocuments(before, sync.documentFromWorkspace(store.getSnapshot()))
  assert.deepEqual(mutations.map((mutation) => mutation.type), ['scene.reorder', 'scene.update'], 'one diff carries order and folder')
  assert.deepEqual(mutations[1].payload, { sceneId: scenes.gate.id, fields: { folderId: folders.forest.id } })

  // Drop onto a scene of 未分类 moves out of the folder.
  assert.equal(store.moveScene(scenes.village.id, { kind: 'scene', sceneId: scenes.castle.id, placement: 'after' }), true)
  assert.equal(store.state.scenes[scenes.village.id].folderId, undefined)
  assert.deepEqual(orderedNames(store), ['Castle', 'Village', 'Town Gate', 'Forest Day', 'Forest Night'])

  // Folder target: append after the folder's last scene.
  assert.equal(store.moveScene(scenes.castle.id, { kind: 'folder', folderId: folders.town.id }), true)
  assert.equal(store.state.scenes[scenes.castle.id].folderId, folders.town.id)
  assert.deepEqual(orderedNames(store), ['Village', 'Town Gate', 'Forest Day', 'Forest Night', 'Castle'])
  // Within the same folder the folder target still means "move to its end".
  assert.equal(store.moveScene(scenes.gate.id, { kind: 'folder', folderId: folders.forest.id }), true)
  assert.deepEqual(orderedNames(store), ['Village', 'Forest Day', 'Town Gate', 'Forest Night', 'Castle'])
  // 未分类 is a valid folder target.
  assert.equal(store.moveScene(scenes.night.id, { kind: 'folder', folderId: null }), true)
  assert.equal(store.state.scenes[scenes.night.id].folderId, undefined)
  assert.deepEqual(orderedNames(store), ['Village', 'Forest Night', 'Forest Day', 'Town Gate', 'Castle'])
  // Empty folder: only folderId changes.
  const orderBefore = orderedNames(store)
  assert.equal(store.moveScene(scenes.day.id, { kind: 'folder', folderId: folders.empty.id }), true)
  assert.equal(store.state.scenes[scenes.day.id].folderId, folders.empty.id)
  assert.deepEqual(orderedNames(store), orderBefore)

  // No-ops and invalid targets leave state untouched.
  const snapshot = JSON.stringify(store.getSnapshot())
  assert.equal(store.moveScene(scenes.day.id, { kind: 'folder', folderId: folders.empty.id }), false)
  assert.equal(store.moveScene(scenes.day.id, { kind: 'scene', sceneId: scenes.day.id, placement: 'before' }), false)
  assert.equal(store.moveScene(scenes.day.id, { kind: 'folder', folderId: 'missing-folder' }), false)
  assert.equal(store.moveScene(scenes.day.id, { kind: 'scene', sceneId: 'missing-scene', placement: 'after' }), false)
  assert.equal(store.moveScene('missing-scene', { kind: 'folder', folderId: null }), false)
  assert.equal(JSON.stringify(store.getSnapshot()), snapshot)

  // Existing APIs keep their semantics.
  assert.equal(store.moveSceneToFolder(scenes.castle.id, null), true)
  assert.deepEqual(orderedNames(store), orderBefore, 'moveSceneToFolder does not reorder')
  assert.equal(store.reorderScenes(scenes.castle.id, scenes.village.id, 'before'), true)
  assert.equal(store.state.scenes[scenes.castle.id].folderId, undefined, 'reorderScenes does not change folders')
}

// --- Drag targets while searching -----------------------------------------
{
  const resolve = browser.resolveSceneBrowserDropTarget
  assert.deepEqual(resolve({ sourceSceneId: 'a', searching: false, sceneId: 'b', placement: 'before' }), { kind: 'scene', id: 'b', placement: 'before' })
  assert.equal(resolve({ sourceSceneId: 'a', searching: true, sceneId: 'b', placement: 'before' }), null, 'no reordering among filtered results')
  assert.deepEqual(resolve({ sourceSceneId: 'a', searching: true, folderId: 'f' }), { kind: 'folder', folderId: 'f' })
  assert.deepEqual(resolve({ sourceSceneId: 'a', searching: true, folderId: '' }), { kind: 'folder', folderId: '' }, '未分类 is a drop target')
  assert.equal(resolve({ sourceSceneId: 'a', searching: false, sceneId: 'a' }), null)
  assert.equal(resolve({ sourceSceneId: 'a', searching: false }), null)
}

// --- Thumbnail location ---------------------------------------------------
{
  const scope = { urlBase: 'https://api.test', worldId: 'w', channelId: 'c', scopeType: 'channel' }
  const managed = resolveTheaterStageThumbnailLocation({
    resourceId: 'res 1',
    url: '/api/v1/worlds/w/channels/c/theater/resources/res%201/variants/display/content',
    mimeType: 'video/webm',
    animated: true,
  }, scope, 240, 'https://sealchat.test/')
  assert.deepEqual(managed, { url: 'https://api.test/api/v1/worlds/w/channels/c/theater/resources/res%201/thumbnail?size=240', managed: true, sourceKind: 'image' })
  const world = resolveTheaterStageThumbnailLocation({ resourceId: 'r', url: '/api/v1/worlds/w/theater/resources/r/content' }, { ...scope, scopeType: 'world' }, 160, 'https://sealchat.test/')
  assert.equal(world.url, 'https://api.test/api/v1/worlds/w/theater/resources/r/thumbnail?size=160')
  const external = resolveTheaterStageThumbnailLocation({ resourceId: '', url: 'https://cdn.test/bg.gif' }, scope, 160, 'https://sealchat.test/')
  assert.deepEqual(external, { url: 'https://cdn.test/bg.gif', managed: false, sourceKind: 'image' })
  assert.equal(resolveTheaterStageThumbnailLocation({ resourceId: '', url: 'https://cdn.test/bg.mp4', mimeType: 'video/mp4' }, scope, 160, 'https://sealchat.test/'), null, 'unmanaged video is never loaded')
  assert.equal(resolveTheaterStageThumbnailLocation(null, scope, 160), null)
  assert.equal(resolveTheaterStageThumbnailLocation({ resourceId: '', url: 'javascript:alert(1)' }, scope, 160, 'https://sealchat.test/'), null)
}

// --- StageApp: switching list/grid keeps edit and batch state -------------
{
  const app = parse(fs.readFileSync(path.join(root, 'src/views/theater/stage/StageApp.vue'), 'utf8')).descriptor
  const ast = ts.createSourceFile('StageApp.ts', app.scriptSetup.content, ts.ScriptTarget.Latest, true)
  const declaration = (name) => {
    const statement = ast.statements.find((node) => ts.isVariableStatement(node)
      && node.declarationList.declarations.some((value) => value.name.getText(ast) === name))
    assert.ok(statement, `missing StageApp declaration ${name}`)
    return statement.getText(ast)
  }
  const source = transpile([
    declaration('closeSceneEditor'),
    declaration('setSceneBrowserViewMode'),
    'return { closeSceneEditor, setSceneBrowserViewMode }',
  ].join('\n'))
  const state = {
    sceneBrowserViewMode: ref('list'),
    sceneEditMode: ref(true),
    sceneBatchMode: ref('copy'),
    sceneBatchSelectedIds: ref(['scene-a', 'scene-b']),
    editingSceneId: ref('scene-a'),
    editingSceneName: ref('A'),
    editingSceneSwitchText: ref('text'),
    editingSceneSwitchAudio: ref({ assetId: 'x' }),
    editingSceneTransition: ref(null),
    sceneMusicPreviewVisible: ref(true),
  }
  const writes = []
  const scope = {
    ...state,
    normalizeStageSceneTransition: () => ({ normalized: true }),
    writeSceneBrowserViewMode: (mode) => writes.push(mode),
  }
  const { setSceneBrowserViewMode } = new Function(...Object.keys(scope), source)(...Object.values(scope))
  setSceneBrowserViewMode('grid')
  assert.equal(state.sceneBrowserViewMode.value, 'grid')
  assert.deepEqual(writes, ['grid'])
  assert.equal(state.editingSceneId.value, null, 'open scene editor popover closes')
  assert.equal(state.sceneMusicPreviewVisible.value, false)
  assert.equal(state.sceneEditMode.value, true, 'edit mode survives')
  assert.equal(state.sceneBatchMode.value, 'copy', 'batch mode survives')
  assert.deepEqual(state.sceneBatchSelectedIds.value, ['scene-a', 'scene-b'], 'batch selection survives')
  setSceneBrowserViewMode('grid')
  assert.deepEqual(writes, ['grid'], 'same mode is a no-op')
  state.sceneBatchMode.value = 'construction'
  state.sceneBatchSelectedIds.value = ['scene-c']
  setSceneBrowserViewMode('list')
  assert.equal(state.sceneBatchMode.value, 'construction')
  assert.deepEqual(state.sceneBatchSelectedIds.value, ['scene-c'])
  assert.deepEqual(writes, ['grid', 'list'])

  // The drag finish path routes every drop through the atomic store move.
  const finish = declaration('finishScenePointerDrag')
  assert.match(finish, /props\.store\.moveScene\(/)
  assert.doesNotMatch(finish, /reorderScenes|moveSceneToFolder/)
  // Grid and list share one card/popover/actions template.
  assert.equal((app.template.content.match(/class="theater-scene-editor"/g) || []).length, 1, 'scene editor markup is not duplicated')
  assert.equal((app.template.content.match(/@click="handleSceneClick\(entry\.scene\)"/g) || []).length, 1)
}

console.log('theater stage scene browser regression passed')
