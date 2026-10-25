// Run with node scripts/theater-stage-surface-transition-regression.cjs.
// Exercise StageApp's actual orchestration/animation functions with controlled
// asynchronous media and a clock. Pixel rendering still needs browser QA.
require('./theater-stage-surface-variants-regression.cjs')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const { parse, compileScript } = require('@vue/compiler-sfc')
const { createSurfaceTransitionController } = require('../src/views/theater/stage/stage-surface-transition.ts')
const { stageSurfaceTransitionFrame } = require('../src/views/theater/stage/stage-scene-transition.ts')
const { createTheaterStageStore } = require('../src/views/theater/stage/StageStore.ts')
const { surfaceVariantsFor } = require('../src/views/theater/shared/stage-surface-variants.ts')
const { theaterSyncTesting: sync } = require('../src/views/theater/sync/TheaterSyncClient.ts')
const filename = path.join(__dirname, '../src/views/theater/stage/StageApp.vue')
const descriptor = parse(fs.readFileSync(filename, 'utf8')).descriptor
compileScript(descriptor, { id: 'surface-regression', inlineTemplate: true })
const source = descriptor.scriptSetup.content
const ast = ts.createSourceFile(filename + '.ts', source, ts.ScriptTarget.Latest, true)
const declarations = names => names.map(name => {
  const statement = ast.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => declaration.name.getText(ast) === name))
  assert.ok(statement, name)
  return statement.getText(ast)
}).join('\n')
const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
const animations = [], loads = [], released = []
class Group {
  constructor() { this.xy = { x: 0, y: 0 }; this.alpha = 1; this.destroyed = false; this.cached = false; this.parent = {} }
  opacity(value) { if (value === undefined) return this.alpha; this.alpha = value; return this }
  scale(value) { this.scaling = value; return this }
  position(value) { if (value === undefined) return { ...this.xy }; this.xy = value; return this }
  cache() { this.cached = true; return this }
  clearCache() { this.cached = false; return this }
  filters(value) { this.filterList = value; return this }
  blurRadius(value) { this.blur = value }
  contrast() {}
  brightness() {}
  getLayer() { return { batchDraw() {} } }
  getParent() { return this.parent }
  destroy() { this.destroyed = true }
}
class Animation {
  constructor(callback) { this.callback = callback; animations.push(this) }
  start() { this.running = true }
  stop() { this.running = false }
  tick(time) { if (this.running) this.callback({ time }) }
}
const makeSlot = (target, image = null) => ({
  target, group: new Group(), transitionGroup: new Group(), placeholder: { width: () => 800, height: () => 450 },
  version: 0, url: image?.url ?? '', source: image, ready: Boolean(image), pendingSource: null,
  style: {}, animatedMedia: image?.animated === true,
  mediaFxController: { dispose() {} }, mediaFxTemporal: { dispose() {} }, liveFx: null,
})
const store = createTheaterStageStore()
const flags = { reduced: false }
const renderer = new Function('props', 'makeSlot', 'createSurfaceTransitionController', 'stageSurfaceTransitionFrame', 'surfaceVariantsFor', 'flags', 'loads', 'released', 'Konva', compile(`
let backgroundSlot = makeSlot('background', { url: 'old-bg' })
let foregroundSlot = makeSlot('foreground', { url: 'old-fg' })
let sceneCompositeTransition = null
let sceneMediaBatch = null
const releaseSceneMediaBatch = batch => { batch.released = true }
const resolveTheaterReducedMotion = () => ({ effectiveReducedMotion: flags.reduced })
const isVideoSource = source => source.kind === 'video'
const surfaceVariants = target => surfaceVariantsFor(props.store.state.liveState, target)
const resolveTheaterStageMedia = image => image.url.startsWith('bad:') ? null : { url: image.url }
const releaseStageMedia = source => { if (source) released.push(source) }
const createSurfaceSlot = (parent, target) => makeSlot(target)
const updateSurfaceSlot = (slot, image, box, style, label, key, callbacks) => {
  slot.updates = (slot.updates || 0) + 1
  slot.url = image?.url ?? ''; slot.style = style
  if (!callbacks) { slot.source = image; return }
  slot.pendingSource = image
  loads.push({ slot, image, ready() { slot.source = image ? { ...image, kind: image.mimeType?.startsWith('video/') ? 'video' : 'image' } : null; slot.pendingSource = null; slot.animatedMedia = image?.animated === true; callbacks.ready() }, error: callbacks.error })
}
${declarations(['disposeSurfaceSlot', 'surfaceTransitions', 'surfaceChangeVersions', 'surfaceRenderSignatures', 'cancelSurfaceTransitions', 'animateSurfacePair', 'syncSurface'])}
return { syncSurface, cancelSurfaceTransitions, get background() { return backgroundSlot }, get foreground() { return foregroundSlot }, scene(value) { sceneCompositeTransition = value }, batch(value) { sceneMediaBatch = value } }
`))({ store }, makeSlot, createSurfaceTransitionController, stageSurfaceTransitionFrame, surfaceVariantsFor, flags, loads, released, { Animation, Filters: { Blur: 'blur', Contrast: 'contrast', Brighten: 'brighten' } })
const box = { x: 0, y: 0, width: 800, height: 450 }
const style = { opacity: 1 }
const choose = (target, id, extra = {}) => {
  const image = { resourceId: id, url: `https://example.com/${id}`, ...extra }
  store.operateSurfaceVariant(target, { type: 'add', id, name: id, image })
  renderer.syncSurface(target, store.state.liveState[target], box, style)
  return image
}
const original = renderer.background
choose('background', 'slow')
const slow = loads.at(-1)
assert.equal(renderer.background, original, 'keep old surface while target loads')
choose('background', 'fast')
assert.ok(slow.slot.group.destroyed)
slow.ready()
assert.equal(renderer.background, original, 'stale load cannot promote itself')
const fast = loads.at(-1)
fast.ready()
assert.equal(renderer.background, fast.slot)
assert.equal(renderer.foreground.url, 'old-fg')
assert.equal(animations.at(-1).running, true)
animations.at(-1).tick(350)
assert.equal(animations.at(-1).running, false)
assert.equal(original.group.destroyed, true)
assert.equal(renderer.background.group.opacity(), 1)
assert.equal(renderer.background.transitionGroup.cached, false)
const unchangedUpdates = renderer.background.updates
renderer.syncSurface('background', store.state.liveState.background, box, style)
assert.equal(renderer.background.updates, unchangedUpdates, 'unchanged surface does not restart media or Media FX')
choose('background', 'failed')
loads.at(-1).error()
assert.equal(renderer.background, fast.slot, 'failure preserves the displayed media')
assert.equal(loads.at(-1).slot.group.destroyed, true)
choose('background', 'cancelled')
const cancelled = loads.at(-1)
renderer.cancelSurfaceTransitions()
assert.equal(cancelled.slot.group.destroyed, true)
cancelled.ready()
assert.equal(renderer.background, fast.slot)
renderer.syncSurface('background', store.state.liveState.background, box, style)
assert.equal(renderer.background.url, store.state.liveState.background.url, 'recovery after a cancelled load still installs the target without animation')

// Live video/animated image + Media FX never acquire transition snapshot caches.
store.operateSurfaceVariant('background', { type: 'transition', patch: { type: 'blur' } })
choose('background', 'animated', { animated: true, mimeType: 'video/webm' })
loads.at(-1).ready()
assert.equal(renderer.background.transitionGroup.cached, false)
assert.equal(renderer.background.source.kind, 'video')
renderer.cancelSurfaceTransitions()
assert.equal(renderer.background.group.destroyed, false)

// A scene-level transition / initial scene media barrier / webpage wins.
const before = loads.length
renderer.scene({})
choose('foreground', 'scene-transition')
assert.equal(loads.length, before)
renderer.scene(null)
const barrier = { sceneId: store.state.activeSceneId, ready: false, expected: new Map([['surface:foreground', 'abandoned']]), settled: new Set() }
renderer.batch(barrier)
choose('foreground', 'initial-load')
assert.equal(loads.length, before)
assert.equal(barrier.expected.get('surface:foreground'), store.state.liveState.foreground.url)
renderer.batch({ ready: true, released: true })
store.setSceneSurfaceEmbed('foreground', { type: 'iframe', iframe: { url: 'https://example.com/page', scale: 1 }, interactive: false })
choose('foreground', 'webpage')
assert.equal(loads.length, before)
assert.equal(store.state.liveState.surfaceEmbeds.foreground.iframe.url, 'https://example.com/page')
store.removeSceneSurfaceEmbed('foreground')
flags.reduced = true
choose('foreground', 'reduced-motion')
assert.equal(loads.length, before)
flags.reduced = false

// Static advanced presets release temporary caches on finish and cancellation.
store.operateSurfaceVariant('foreground', { type: 'transition', patch: { type: 'dissolve' } })
choose('foreground', 'static-dissolve')
loads.at(-1).ready()
assert.equal(renderer.foreground.transitionGroup.cached, true)
renderer.cancelSurfaceTransitions()
assert.equal(renderer.foreground.transitionGroup.cached, false)
assert.equal(renderer.foreground.group.opacity(), 1)
assert.ok(animations.every(animation => !animation.running))
console.log('surface renderer: latest load, failure, pair cleanup, dynamic fallback, webpages, reduced motion and scene priority passed')

const collectMedia = new Function('props', 'resolveTheaterStageMedia', compile(`${declarations(['collectSceneMediaItems'])};return collectSceneMediaItems`))({ store }, image => ({ url: image.url }))
const collected = collectMedia(store.state.activeSceneId)
assert.deepEqual(collected.filter(item => item.key.startsWith('surface:')).map(item => item.imageRef.resourceId).sort(), [store.state.liveState.background.resourceId, store.state.liveState.foreground.resourceId].sort(), 'scene preload blocks only on active surface media')

async function checkUploads() {
  const uploadStore = createTheaterStageStore()
  const requests = []
  const state = new Function('props', 'surfaceVariantsFor', 'uploadTheaterImageResource', compile(`
const surfaceVariants = target => surfaceVariantsFor(props.store.state.liveState, target)
const resourceUploading = { value: false }, resourceError = { value: '' }
const captureTheaterRequestScope = () => ({})
const isCurrentTheaterRequestScope = () => true
const canUploadImageTarget = () => true
const isTheaterEffectObject = () => false
${declarations(['surfaceImageEpoch', 'bindImageTarget', 'applyImageUrl', 'imageUploadGeneration', 'activeImageUploads', 'uploadImage'])}
return { bindImageTarget, uploadImage, invalidate() { surfaceImageEpoch++ }, get busy() { return resourceUploading.value } }
`))({ store: uploadStore, worldId: 'world', channelId: 'channel' }, surfaceVariantsFor, () => new Promise((resolve, reject) => requests.push({ resolve, reject })))
  const result = id => ({ url: `https://example.com/${id}`, resourceId: id, mimeType: 'image/png', resource: {}, prepared: {} })
  const target = () => state.bindImageTarget({ kind: 'scene', target: 'background' })
  const failed = state.uploadImage({}, { kind: 'scene', target: 'background', add: true })
  requests.at(-1).reject(new Error('upload failed'))
  await assert.rejects(failed, /upload failed/)
  assert.equal(uploadStore.state.liveState.surfaceVariants, undefined, 'failed add leaves no empty record')
  uploadStore.setSceneImage('background', 'https://example.com/first')
  const firstId = surfaceVariantsFor(uploadStore.state.liveState, 'background').activeId
  const captured = target()
  const replacement = state.uploadImage({}, captured)
  uploadStore.operateSurfaceVariant('background', { type: 'add', id: 'second', name: '第二张', image: { resourceId: 'second', url: 'https://example.com/second' } })
  requests.at(-1).resolve(result('replacement'))
  await replacement
  assert.equal(uploadStore.state.liveState.background.resourceId, 'second', 'upload does not overwrite a newly selected slot')
  assert.equal(surfaceVariantsFor(uploadStore.state.liveState, 'background').slots.find(slot => slot.id === firstId).image.resourceId, 'replacement')
  const older = state.uploadImage({}, target())
  const oldRequest = requests.at(-1)
  const newer = state.uploadImage({}, target())
  const newRequest = requests.at(-1)
  oldRequest.resolve(result('stale'))
  await assert.rejects(older, /目标已失效/)
  assert.equal(state.busy, true)
  newRequest.resolve(result('latest'))
  await newer
  assert.equal(uploadStore.state.liveState.background.resourceId, 'latest')
  assert.equal(state.busy, false)
  const departed = state.uploadImage({}, target())
  state.invalidate()
  requests.at(-1).resolve(result('departed'))
  await assert.rejects(departed, /目标已失效/)
  const deletedTarget = target()
  const deleted = state.uploadImage({}, deletedTarget)
  uploadStore.operateSurfaceVariant('background', { type: 'delete', id: deletedTarget.slotId })
  requests.at(-1).resolve(result('deleted'))
  await assert.rejects(deleted, /目标已失效/)
  const count = surfaceVariantsFor(uploadStore.state.liveState, 'background').slots.length
  const added = state.uploadImage({}, { kind: 'scene', target: 'background', add: true })
  requests.at(-1).resolve(result('added'))
  await added
  assert.equal(surfaceVariantsFor(uploadStore.state.liveState, 'background').slots.length, count + 1)
  assert.equal(uploadStore.state.liveState.background.resourceId, 'added')
  console.log('surface uploads: failure rollback, captured slot, latest request, departed/deleted target and successful add passed')
}
async function checkEditorRecovery() {
  const target = { kind: 'scene', sceneId: 'previous', epoch: 0 }
  const imageEditorTarget = { value: target }, imageEditorVisible = { value: true }
  const commits = [], closed = []
  let resolve, reject
  const save = new Function('imageEditorTarget', 'imageEditorVisible', 'uploadImage', 'commitImageEditorMediaFx', 'closeImageEditor', compile(`${declarations(['saveEditedImage'])}; return saveEditedImage`))(
    imageEditorTarget, imageEditorVisible, () => new Promise((done, fail) => { resolve = done; reject = fail }),
    value => commits.push(value), () => closed.push(true),
  )
  const staleFailure = save({ file: {} })
  imageEditorTarget.value = null
  reject(new Error('departed'))
  await staleFailure
  assert.equal(imageEditorVisible.value, false, 'departing during upload cannot reopen a stale editor')
  imageEditorTarget.value = target
  const staleSuccess = save({ file: {} })
  imageEditorTarget.value = { ...target, sceneId: 'new' }
  resolve()
  await staleSuccess
  assert.deepEqual(commits, [], 'stale editor completion cannot write Media FX')
  assert.deepEqual(closed, [], 'stale editor completion cannot close a new editor')
  const currentFailure = save({ file: {} })
  reject(new Error('retry'))
  await currentFailure
  assert.equal(imageEditorVisible.value, true, 'current upload failure still allows retry')
}

async function checkSyncRecovery() {
  const filename = path.join(__dirname, '../src/views/theater/sync/TheaterSyncClient.ts')
  const ast = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true)
  const client = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'TheaterSyncClient')
  const reload = client.members.find(node => node.name?.getText(ast) === 'reload').getText(ast)
  let response
  const applied = []
  const currentStore = createTheaterStageStore()
  const document = sync.documentFromWorkspace(currentStore.getSnapshot())
  const RecoveryClient = new Function('api', 'normalizeDocument', 'documentFromWorkspace', 'workspaceFromDocument', 'diffDocuments', compile(`
const finite = (value, fallback) => Number.isFinite(value) ? Number(value) : fallback
const defaultDialogueController = () => ({})
const publishDialogueController = () => {}
const rebaseDocument = (base, local, remote) => remote
const errorMessage = error => error.message
return class { ${reload} }
`))({ get: () => new Promise(resolve => { response = resolve }) }, sync.normalizeDocument, sync.documentFromWorkspace, sync.workspaceFromDocument, sync.diffDocuments)
  const recovery = new RecoveryClient()
  Object.assign(recovery, {
    started: true, hasLoaded: true, revision: 0, pendingSurfaceRevision: 2, surfaceAnimationEpoch: 0,
    baseDocument: document, theaterBase: () => '', flushPendingEffectTriggers() {}, flushPendingSceneAudioTriggers() {},
    options: { worldId: 'world', store: { ...currentStore, replaceState: (state, animate) => { applied.push(animate); currentStore.replaceState(state, animate) } } },
  })
  const pending = recovery.reload(false, undefined, false, true, true)
  recovery.surfaceAnimationEpoch++
  recovery.pendingSurfaceRevision = 0
  response({ data: { revision: 2, snapshot: document } })
  await pending
  assert.deepEqual(applied, [false], 'an in-flight peer request cannot animate after reconnect')
  console.log('surface sync: in-flight reconnect recovery suppresses local animation passed')
}
checkUploads().then(checkEditorRecovery).then(checkSyncRecovery).catch(error => { console.error(error); process.exitCode = 1 })
