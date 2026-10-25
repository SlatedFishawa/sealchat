// Screen-fixed (viewport) StageObject regression: pure conversions, store history/grouping rules,
// sync diff/normalize and the bridge schema. Reuses the surface-embeds TypeScript loader.
// node scripts/theater-stage-coordinate-space-regression.cjs
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')
const root = path.resolve(__dirname, '..')
const originalLoad = Module._load
const originalResolve = Module._resolveFilename
Module._load = function (request, ...args) {
  if (request === '@/stores/_config') return { api: {} }
  if (request === '@/stores/chat') return { chatEvent: { on() {}, off() {} } }
  return originalLoad.call(this, request, ...args)
}
Module._resolveFilename = function (request, parent, ...args) {
  if (request.startsWith('@/')) request = path.join(root, 'src', request.slice(2))
  return originalResolve.call(this, request, parent, ...args)
}
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, filename)
global.crypto ||= require('node:crypto').webcrypto

const space = require('../src/views/theater/stage/stage-coordinate-space.ts')
const { WORLD_UNIT_PX } = require('../src/views/theater/shared/stage-types.ts')
const { createTheaterStageStore } = require('../src/views/theater/stage/StageStore.ts')
const { createStageSelectionGroup } = require('../src/views/theater/stage/stage-selection.ts')
const { instantiateClipboardBundle } = require('../src/views/theater/stage/stage-editing.ts')
const { theaterSyncTesting: sync } = require('../src/views/theater/sync/TheaterSyncClient.ts')
const { stageSceneReadResultSchema, createTheaterBridgeMessage, parseTheaterBridgeMessage,
  projectTheaterBridgeMessage, negotiateTheaterBridgeVersion } = require('../src/views/theater/bridge/theater-bridge-protocol.ts')
const { TheaterHostBridge } = require('../src/views/theater/bridge/TheaterHostBridge.ts')

const workspaceObjects = (workspace) => [
  ...Object.values(workspace.persistentObjects || {}),
  ...Object.values(workspace.liveState?.sceneObjects || {}),
  ...Object.values(workspace.scenes || {}).flatMap((scene) => Object.values(scene.state?.sceneObjects || {})),
]
const near = (actual, expected, message, epsilon = 1e-4) => assert.ok(Math.abs(actual - expected) <= epsilon, `${message}: ${actual} != ${expected}`)
// Viewport positions are stored with 6 decimals, i.e. well under 0.01px drift on screen.
const nearPose = (actual, expected, message) => ['x', 'y', 'rotation', 'scaleX', 'scaleY'].forEach((key) => near(actual[key], expected[key], `${message} ${key}`, 0.01))
// Same shape StageApp builds from worldCameraGroup.getAbsoluteTransform(): screen = world * zoom + offset.
const camera = (zoom, offsetX, offsetY) => ({
  scale: zoom,
  worldToScreen: (point) => ({ x: point.x * zoom + offsetX, y: point.y * zoom + offsetY }),
  screenToWorld: (point) => ({ x: (point.x - offsetX) / zoom, y: (point.y - offsetY) / zoom }),
})
const object = (id, extra = {}) => ({
  id, type: 'image', parentId: null, coordinateSpace: 'world', viewportX: 0.5, viewportY: 0.5,
  transform: { x: 3, y: -2, width: 4, height: 3, rotation: 30, scaleX: 1.5, scaleY: 0.75, z: 0, order: 0 },
  ...extra,
})

// viewportScale is uniform: min of the axis ratios against the 1920x1080 design reference.
assert.equal(space.stageViewportScale({ width: 1920, height: 1080 }), 1)
assert.equal(space.stageViewportScale({ width: 960, height: 1080 }), 0.5)
assert.equal(space.stageViewportScale({ width: 3840, height: 1080 }), 1, 'wide windows do not stretch X')
assert.equal(space.stageViewportScale({ width: 0, height: 0 }), 1, 'invalid size falls back')
assert.deepEqual(space.stageViewportBandCamera({ width: 960, height: 540 }), { position: { x: 0, y: 0 }, scale: { x: 0.5, y: 0.5 } })

// World default and legacy objects: no coordinateSpace means world.
const legacy = object('legacy')
delete legacy.coordinateSpace
assert.equal(space.stageRootCoordinateSpace(legacy), 'world')
assert.equal(space.stageRootCoordinateSpace(object('fx', { type: 'effect', coordinateSpace: 'viewport' })), 'world', 'effects never become viewport')
assert.deepEqual(space.stageObjectNodeRenderTransform(legacy, { legacy }, { width: 1280, height: 720 }),
  { x: 3 * WORLD_UNIT_PX, y: -2 * WORLD_UNIT_PX, rotation: 30, scaleX: 1.5, scaleY: 0.75 })

// world -> viewport -> world keeps the on-screen pose; only target-space fields and scale change.
for (const [zoom, viewport] of [[1, { width: 1920, height: 1080 }], [2.5, { width: 1280, height: 720 }], [0.4, { width: 800, height: 1000 }]]) {
  const cam = camera(zoom, viewport.width / 2 + 37, viewport.height / 2 - 11)
  const world = object('root')
  const before = space.stageRootScreenPose(world, cam, viewport)
  const toViewport = space.convertStageRootCoordinateSpace(world, 'viewport', cam, viewport)
  assert.equal(toViewport.coordinateSpace, 'viewport')
  assert.equal(toViewport.transform.x, undefined, 'world x/y untouched when entering viewport')
  const pinned = structuredClone(world)
  space.applyStageRootPose(pinned, toViewport)
  nearPose(space.stageRootScreenPose(pinned, cam, viewport), before, `toggle on @${zoom}`)
  assert.equal(pinned.transform.x, 3, 'transform.x is not reinterpreted')
  assert.equal(space.convertStageRootCoordinateSpace(pinned, 'viewport', cam, viewport), null, 'same-space toggle is a no-op')
  // Node attrs inside the viewport band (layer scaled by viewportScale) land on the same screen point.
  const node = space.stageObjectNodeRenderTransform(pinned, { root: pinned }, viewport)
  const s = space.stageViewportScale(viewport)
  near(node.x * s, before.x, 'viewport node x', 0.01)
  near(node.y * s, before.y, 'viewport node y', 0.01)
  // The world camera moving does not move a viewport root.
  nearPose(space.stageRootScreenPose(pinned, camera(zoom * 3, -500, 900), viewport), before, 'camera independent')
  const back = space.convertStageRootCoordinateSpace(pinned, 'world', cam, viewport)
  const unpinned = structuredClone(pinned)
  space.applyStageRootPose(unpinned, back)
  nearPose(space.stageRootScreenPose(unpinned, cam, viewport), before, `toggle off @${zoom}`)
  near(unpinned.transform.x, 3, 'round trip x')
  near(unpinned.transform.y, -2, 'round trip y')
  near(unpinned.transform.scaleX, 1.5, 'round trip scaleX')
  assert.equal(unpinned.viewportX, pinned.viewportX, 'viewport position kept while in world')
}

// Resize: the normalized anchor follows the viewport and size scales uniformly with viewportScale.
const tooLarge = object('large')
tooLarge.transform.scaleX = 30
tooLarge.transform.scaleY = 30
const unchanged = structuredClone(tooLarge)
assert.deepEqual(space.convertStageRootCoordinateSpace(tooLarge, 'viewport', camera(3, 640, 360), { width: 1280, height: 720 }),
  { error: 'scale-out-of-range' }, 'target scale 135 cannot be represented')
assert.deepEqual(tooLarge, unchanged, 'rejected conversion leaves the source untouched')
assert.deepEqual(space.convertStageRootCoordinateSpace(object('far'), 'viewport', camera(1, 4000, 360), { width: 1280, height: 720 }),
  { error: 'position-out-of-range' }, 'offscreen position is rejected instead of clamped')
assert.deepEqual(space.convertStageRootCoordinateSpace(object('small', { coordinateSpace: 'viewport' }), 'world', camera(100, 0, 0), { width: 100, height: 100 }),
  { error: 'scale-out-of-range' }, 'reverse switch also rejects an unrepresentable scale')
// Exercise StageApp's preflight boundary: even a later invalid root aborts the entire batch
// before touching the store or its undo transaction.
const stageAppSource = fs.readFileSync(path.join(root, 'src/views/theater/stage/StageApp.vue'), 'utf8')
const switchSource = stageAppSource.slice(stageAppSource.indexOf('const setRootsScreenFixed ='), stageAppSource.indexOf('const updateSelectedScreenFixed ='))
const switchJS = ts.transpileModule(`${switchSource}\nreturn setRootsScreenFixed`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const editCalls = []
const warnings = []
const switchRoots = new Function('worldCameraTransform', 'canEditAllObjects', 'viewportSize', 'convertStageRootCoordinateSpace', 'stageMessage', 'props', 'nextTick', 'syncObjects', 'updateTransformer', switchJS)(
  () => camera(3, 640, 360), { value: true }, { value: { width: 1280, height: 720 } }, space.convertStageRootCoordinateSpace,
  { warning: message => warnings.push(message) }, { store: {
    beginObjectEdit: () => editCalls.push('begin'), setRootCoordinateSpaces: () => editCalls.push('apply'), commitObjectEdit: () => editCalls.push('commit'),
  } }, () => {}, () => {}, () => {},
)
switchRoots([object('valid'), tooLarge], true)
assert.deepEqual(editCalls, [], 'failed batch creates no edits or undo history')
assert.equal(warnings.length, 1, 'StageApp explains the rejected switch')
assert.deepEqual(tooLarge, unchanged)
const hud = object('hud', { coordinateSpace: 'viewport', viewportX: 0.25, viewportY: 0.9 })
for (const viewport of [{ width: 1280, height: 720 }, { width: 1920, height: 800 }, { width: 600, height: 1200 }]) {
  const pose = space.stageRootScreenPose(hud, camera(1, 0, 0), viewport)
  const s = space.stageViewportScale(viewport)
  near(pose.x, 0.25 * viewport.width, 'resize anchor x')
  near(pose.y, 0.9 * viewport.height, 'resize anchor y')
  near(pose.scaleX / pose.scaleY, 1.5 / 0.75, 'aspect ratio preserved')
  near(pose.scaleX, 1.5 * s, 'uniform size')
}
// Node commit writes the owning field: viewportX/Y for viewport roots, transform for children.
const committed = structuredClone(hud)
space.commitStageNodePosition(committed, { hud: committed }, { x: 960, y: 270 }, { width: 960, height: 540 })
assert.deepEqual([committed.viewportX, committed.viewportY, committed.transform.x], [0.5, 0.25, 3])
const child = object('child', { parentId: 'hud', coordinateSpace: 'viewport' })
assert.equal(space.stageObjectEffectiveCoordinateSpace(child, { hud, child }), 'viewport')
space.commitStageNodePosition(child, { hud, child }, { x: 48, y: -24 }, { width: 960, height: 540 })
assert.deepEqual([child.transform.x, child.transform.y, child.viewportX], [2, -1, 0.5], 'children keep local transforms')
assert.equal(space.stageScreenPointToViewport({ x: 99999, y: -99999 }, { width: 100, height: 100 }).viewportX, 2, 'clamped')

// Mixed selection only reports; geometry gates live in StageApp.
const objects = { a: object('a'), b: object('b', { coordinateSpace: 'viewport' }), c: object('c') }
const mixed = createStageSelectionGroup(objects, ['a', 'b'], 'a', () => 'scene')
assert.deepEqual([mixed.mixedCoordinateSpaces, mixed.coordinateSpaces.sort()], [true, ['viewport', 'world']])
assert.equal(createStageSelectionGroup(objects, ['a', 'c'], 'a', () => 'scene').mixedCoordinateSpaces, false)

// Paste: viewport roots offset in viewport space; detached viewport children fall back to world.
let counter = 0
const pasted = instantiateClipboardBundle({
  version: 2, copyMode: 'offset', sourceSceneId: null,
  roots: [{ id: 'hud', scope: 'scene' }, { id: 'child', scope: 'scene' }],
  objects: [{ scope: 'scene', object: { ...structuredClone(hud), name: 'hud', actions: [], metadata: {} } }, { scope: 'scene', object: { ...structuredClone(child), name: 'child', actions: [], metadata: {} } }],
}, (prefix) => `${prefix}-${++counter}`, 1, new Map([['hud', null], ['child', null]]))
assert.equal(pasted.objects[0].object.coordinateSpace, 'viewport')
near(pasted.objects[0].object.viewportX, 0.25 + WORLD_UNIT_PX / 1920, 'pasted viewport offset')
assert.equal(pasted.objects[0].object.transform.x, 3)
assert.equal(pasted.objects[1].object.coordinateSpace, 'world')
assert.equal(pasted.objects[1].object.transform.x, 3, 'detached child offset in world units')

// Store: toggle is one undoable history entry; grouping across spaces is rejected.
const store = createTheaterStageStore()
const imageA = store.addObject('image')
const imageB = store.addObject('image')
const group = store.addObject('group')
assert.equal(imageA.coordinateSpace, 'world')
assert.deepEqual([imageA.viewportX, imageA.viewportY], [0.5, 0.5])
assert.equal(store.setParent(imageB.id, group.id), true)
const before = sync.documentFromWorkspace(store.getSnapshot())
const pose = space.convertStageRootCoordinateSpace(store.activeObjects.value[group.id], 'viewport', camera(1, 640, 360), { width: 1280, height: 720 })
assert.equal(store.setRootCoordinateSpaces({ [group.id]: pose }), 1)
assert.equal(store.activeObjects.value[group.id].coordinateSpace, 'viewport')
assert.equal(store.activeObjects.value[imageB.id].coordinateSpace, 'viewport', 'children mirror the root')
assert.equal(store.canSetParent(imageA.id, group.id), false, 'world object cannot join a viewport group')
assert.equal(store.setParent(imageA.id, group.id), false)
assert.equal(store.canSetParent(imageB.id, null), true, 'leaving to top level is allowed')
const after = sync.documentFromWorkspace(store.getSnapshot())
const mutations = sync.diffDocuments(before, after)
const objectUpdates = mutations.flatMap((mutation) => mutation.type === 'object.update' ? [mutation.payload] : mutation.type === 'object.batchUpdate' ? mutation.payload.updates : [])
assert.equal(mutations.length, 1, 'toggle is a single object mutation')
const groupUpdate = objectUpdates.find((update) => update.objectId === group.id)
assert.ok(groupUpdate, 'toggle produces an object update')
// At zoom 1 on 1280x720 the viewport scale is 2/3, so the root scale compensates; x/y/rotation stay.
assert.deepEqual(Object.keys(groupUpdate.fields).sort(), ['coordinateSpace', 'scaleX', 'scaleY', 'viewportX', 'viewportY'],
  'only changed fields are sent')
const childUpdate = objectUpdates.find((update) => update.objectId === imageB.id)
// World wire objects omit viewportX/Y (the server may hold stale values), so entering viewport
// sends them once; the child's own transform is untouched.
assert.deepEqual(childUpdate && Object.keys(childUpdate.fields).sort(), ['coordinateSpace', 'viewportX', 'viewportY'], 'child mirrors space only')
assert.equal(objectUpdates.length, 2, 'untouched objects produce no update')
assert.equal(store.undo(), true)
assert.equal(store.activeObjects.value[group.id].coordinateSpace, 'world')
assert.equal(store.activeObjects.value[imageB.id].coordinateSpace, 'world')
assert.equal(store.canSetParent(imageA.id, group.id), true)
assert.deepEqual(sync.diffDocuments(before, sync.documentFromWorkspace(store.getSnapshot())), [], 'undo restores the document')

// Sync: world objects keep the old wire shape; old snapshots normalize to world.
const worldDocument = sync.documentFromWorkspace(store.getSnapshot())
const sceneDocument = Object.values(worldDocument.scenes).find((scene) => scene.objects[imageA.id])
assert.equal('coordinateSpace' in sceneDocument.objects[imageA.id], false)
assert.equal('viewportX' in sceneDocument.objects[imageA.id], false)
const restored = sync.workspaceFromDocument(sync.normalizeDocument(JSON.parse(JSON.stringify(worldDocument))))
const restoredA = workspaceObjects(restored).find((item) => item.id === imageA.id)
assert.deepEqual([restoredA.coordinateSpace, restoredA.viewportX, restoredA.viewportY], ['world', 0.5, 0.5])
store.setRootCoordinateSpaces({ [group.id]: pose })
const viewportDocument = JSON.parse(JSON.stringify(sync.documentFromWorkspace(store.getSnapshot())))
const viewportGroup = Object.values(viewportDocument.scenes).map((scene) => scene.objects[group.id]).find(Boolean)
assert.deepEqual([viewportGroup.coordinateSpace, viewportGroup.viewportX], ['viewport', pose.viewportX])
const roundTrip = sync.workspaceFromDocument(sync.normalizeDocument(viewportDocument))
assert.deepEqual(sync.diffDocuments(viewportDocument, sync.documentFromWorkspace(roundTrip)), [], 'viewport document round trips')
const reparentBefore = JSON.parse(JSON.stringify(viewportDocument))
const reparentAfter = JSON.parse(JSON.stringify(viewportDocument))
const reparentScene = Object.values(reparentAfter.scenes).find((scene) => scene.objects[imageB.id])
const reparentChild = reparentScene.objects[imageB.id]
reparentChild.parentId = null
const reparentUpdates = sync.diffDocuments(reparentBefore, reparentAfter)
  .flatMap((mutation) => mutation.type === 'object.update'
    ? [mutation.payload]
    : mutation.type === 'object.batchUpdate' ? mutation.payload.updates : [])
const reparentFields = reparentUpdates.find((item) => item.objectId === imageB.id)?.fields
assert.deepEqual(Object.keys(reparentFields || {}).sort(),
  ['parentId', 'rotation', 'scaleX', 'scaleY', 'viewportX', 'viewportY'],
  'viewport detach forces a complete target-space pose even when numeric components are unchanged')
viewportGroup.coordinateSpace = 'screen'
viewportGroup.viewportX = Number.NaN
const sanitized = workspaceObjects(sync.workspaceFromDocument(sync.normalizeDocument(viewportDocument))).find((item) => item.id === group.id)
assert.deepEqual([sanitized.coordinateSpace, sanitized.viewportX], ['world', 0.5], 'invalid values normalize safely')

// Delegated edit: move on screen is allowed, toggling the space stays a full-editor field.
const delegatedDocument = sync.documentFromWorkspace(store.getSnapshot())
Object.values(delegatedDocument.scenes).forEach((scene) => { if (scene.objects[group.id]) scene.objects[group.id].editable = true })
const update = (fields) => ({ type: 'object.update', permission: 'stage.object.edit', payload: { objectId: group.id, fields } })
assert.equal(sync.canApplyMutation(update({ viewportX: 0.2, viewportY: 0.3 }), ['stage.object.edit.delegated'], delegatedDocument), true)
assert.equal(sync.canApplyMutation(update({ coordinateSpace: 'world' }), ['stage.object.edit.delegated'], delegatedDocument), false)

// Bridge schema: old states default to world; non-finite or out-of-range positions are rejected.
const bridged = store.getSnapshot()
const bridgedObjects = workspaceObjects(bridged)
bridgedObjects.forEach((item) => { delete item.coordinateSpace; delete item.viewportX; delete item.viewportY })
const parsed = stageSceneReadResultSchema.parse({ ok: true, state: bridged })
const parsedObject = workspaceObjects(parsed.state).find((item) => item.id === bridgedObjects[0].id)
assert.deepEqual([parsedObject.coordinateSpace, parsedObject.viewportX, parsedObject.viewportY], ['world', 0.5, 0.5])
bridgedObjects[0].viewportX = 3
assert.equal(stageSceneReadResultSchema.safeParse({ ok: true, state: bridged }).success, false)
bridgedObjects[0].viewportX = 0.5
bridgedObjects[0].coordinateSpace = 'screen'
assert.equal(stageSceneReadResultSchema.safeParse({ ok: true, state: bridged }).success, false)

assert.equal(negotiateTheaterBridgeVersion(['1.0']), '1.0')
assert.equal(negotiateTheaterBridgeVersion(['1.0', '1.1']), '1.1')
assert.equal(negotiateTheaterBridgeVersion(['2.0']), undefined)
const context = { worldId: 'world', channelId: 'channel', sessionId: 'session' }
const legacyMessage = projectTheaterBridgeMessage(createTheaterBridgeMessage(context, {
  kind: 'result', source: 'stage', target: 'chat', correlationId: 'read', name: 'stage.scene.read.result',
  payload: { ok: true, state: store.getSnapshot() },
}), '1.0')
for (const item of workspaceObjects(legacyMessage.payload.state)) {
  for (const key of ['coordinateSpace', 'viewportX', 'viewportY']) assert.equal(key in item, false, `legacy projection excludes ${key}`)
}
assert.ok(workspaceObjects(parseTheaterBridgeMessage(legacyMessage).payload.state).every(item => item.coordinateSpace === 'world'), 'new reader accepts 1.0')

// Exercise the real host -> memory stage -> postMessage path: the memory parser adds defaults,
// so projecting only at the stage client would still leak fields to an old strict peer.
;(async () => {
  class FakeWindow extends EventTarget {
    sent = []
    postMessage(message) { this.sent.push(message) }
  }
  const tick = () => new Promise(resolve => setTimeout(resolve, 0))
  for (const version of ['1.0', '1.1']) {
    const hostWindow = new FakeWindow()
    const chatWindow = new FakeWindow()
    global.window = hostWindow
    const host = new TheaterHostBridge({ context, stageStore: store, getChatWindow: () => chatWindow,
      origin: 'https://sealchat.test', userId: 'owner', permissions: [] })
    const receive = (kind, target, name, payload) => {
      const message = { ...createTheaterBridgeMessage(context, { kind, source: 'chat', target, name, payload }), version }
      hostWindow.dispatchEvent(Object.assign(new Event('message'), { origin: 'https://sealchat.test', source: chatWindow, data: message }))
      return message
    }
    await host.start()
    receive('system', 'host', 'system.ready', { endpoint: 'chat', supportedVersions: [version], capabilities: [] })
    await tick()
    const initialize = chatWindow.sent.find(item => item.name === 'system.initialize')
    assert.equal(initialize.version, version)
    assert.equal(initialize.payload.selectedVersion, version)
    receive('system', 'host', 'system.initialized', { endpoint: 'chat', selectedVersion: version, capabilities: [] })
    await tick()
    const request = receive('command', 'stage', 'stage.scene.read', {})
    await tick()
    const result = chatWindow.sent.find(item => item.correlationId === request.id)
    assert.ok(result?.payload.ok, `scene.read completes after ${version} negotiation`)
    assert.equal(result.version, version)
    const wireObjects = workspaceObjects(result.payload.state)
    if (version === '1.0') {
      wireObjects.forEach(item => ['coordinateSpace', 'viewportX', 'viewportY'].forEach(key => assert.equal(key in item, false)))
    } else {
      assert.ok(wireObjects.some(item => item.coordinateSpace === 'viewport'), '1.1 retains screen-fixed objects')
    }
    host.stop()
  }
  console.log('theater stage coordinate space regression passed')
})().catch(error => { console.error(error); process.exitCode = 1 })
