// Run with node scripts/theater-stage-media-regression.cjs.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const filename = path.join(__dirname, '../src/views/theater/stage/stage-media.ts')
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText
const mod = { exports: {} }
const resolveStageImageUrl = value => {
  try { return new URL(value, 'https://sealchat.test/').toString() } catch { return '' }
}
new Function('require', 'module', 'exports', compiled)(request => {
  if (request === '../shared/stage-types') return { resolveStageImageUrl }
  throw new Error(`unexpected import: ${request}`)
}, mod, mod.exports)

const { resolveTheaterStageMediaLocation, resolveTheaterMediaPlaybackReference } = mod.exports
const scope = { urlBase: 'https://api.test', worldId: 'world', channelId: 'channel', scopeType: 'channel' }
const legacy = resolveTheaterStageMediaLocation({
  resourceId: 'apng-1',
  url: '/api/v1/worlds/world/channels/channel/theater/resources/apng-1/variants/display/content',
  mimeType: 'video/webm',
  animated: true,
}, scope)
assert.equal(legacy.url, 'https://api.test/api/v1/worlds/world/channels/channel/theater/resources/apng-1/variants/display/content')
assert.equal(legacy.managed, true)
assert.equal(legacy.sourceKind, 'video')

const legacyWithoutAnimated = resolveTheaterStageMediaLocation({
  resourceId: 'apng-missing-flag',
  url: '/api/v1/worlds/world/channels/channel/theater/resources/apng-missing-flag/variants/display/content',
  mimeType: 'video/webm',
}, scope, 'https://sealchat.test/', {
  kind: 'animated_image',
  mimeType: 'image/apng',
  playbackVariant: 'display',
  playbackMimeType: 'video/webm',
})
assert.equal(legacyWithoutAnimated.url, 'https://api.test/api/v1/worlds/world/channels/channel/theater/resources/apng-missing-flag/variants/display/content')
assert.equal(legacyWithoutAnimated.sourceKind, 'video')

const normalizedLegacy = resolveTheaterMediaPlaybackReference({
  variant: 'display',
  mimeType: 'video/webm',
  resourceKind: 'animated_image',
  resourceMimeType: 'image/gif',
})
assert.deepEqual(normalizedLegacy, {
  variant: 'display',
  mimeType: 'video/webm',
  sourceKind: 'video',
  legacyAnimatedImageDisplay: false,
})

const actualVideo = resolveTheaterStageMediaLocation({
  resourceId: 'video-1',
  url: '/api/v1/worlds/world/channels/channel/theater/resources/video-1/variants/display/content',
  mimeType: 'video/webm',
}, scope)
assert.equal(actualVideo.url, 'https://api.test/api/v1/worlds/world/channels/channel/theater/resources/video-1/variants/display/content')
assert.equal(actualVideo.sourceKind, 'video')

const actualVideoWithResourceMetadata = resolveTheaterStageMediaLocation({
  resourceId: 'video-2',
  url: '/api/v1/worlds/world/channels/channel/theater/resources/video-2/variants/display/content',
  mimeType: 'video/webm',
}, scope, 'https://sealchat.test/', { kind: 'video', mimeType: 'video/webm' })
assert.equal(actualVideoWithResourceMetadata.url, 'https://api.test/api/v1/worlds/world/channels/channel/theater/resources/video-2/variants/display/content')
assert.equal(actualVideoWithResourceMetadata.sourceKind, 'video')

const actualMp4 = resolveTheaterStageMediaLocation({
  resourceId: 'video-mp4',
  url: '/api/v1/worlds/world/channels/channel/theater/resources/video-mp4/variants/display/content',
  mimeType: 'video/mp4',
}, scope)
assert.equal(actualMp4.sourceKind, 'video')

const nativeApng = resolveTheaterStageMediaLocation({
  resourceId: 'apng-2',
  url: '/api/v1/worlds/world/channels/channel/theater/resources/apng-2/content',
  mimeType: 'image/apng',
  animated: true,
}, scope)
assert.equal(nativeApng.url, 'https://api.test/api/v1/worlds/world/channels/channel/theater/resources/apng-2/content')
assert.equal(nativeApng.sourceKind, 'image')

const mediaRendererFilename = path.join(__dirname, '../src/views/theater/overlays/renderers/media-renderer.ts')
const mediaRendererCompiled = ts.transpileModule(fs.readFileSync(mediaRendererFilename, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText
const mediaRendererMod = { exports: {} }
class FakeMediaElement {
  constructor() {
    this.style = {}
    this.src = ''
  }
  addEventListener() {}
  removeEventListener() {}
  removeAttribute(name) { if (name === 'src') this.src = '' }
  remove() {}
}
class FakeImageElement extends FakeMediaElement {}
class FakeVideoElement extends FakeMediaElement {
  play() { return Promise.resolve() }
  pause() {}
  load() {}
}
const previousDocument = global.document
const previousVideoElement = global.HTMLVideoElement
global.HTMLVideoElement = FakeVideoElement
global.document = {
  createElement: tag => tag === 'video' ? new FakeVideoElement() : new FakeImageElement(),
}
new Function('require', 'module', 'exports', mediaRendererCompiled)(request => {
  if (request === '../../stage/stage-media') return mod.exports
  throw new Error(`unexpected media renderer import: ${request}`)
}, mediaRendererMod, mediaRendererMod.exports)
const { mediaSceneOverlayRenderer } = mediaRendererMod.exports
const mountedElements = []
const host = {
  style: {},
  append(element) { mountedElements.push(element) },
}
const overlayContext = {
  reducedMotion: false,
  binding: {},
  resolveResourceUrl: (resourceId, variant) => `/resource/${resourceId}/${variant || 'original'}`,
}
const overlayHandle = mediaSceneOverlayRenderer.mount(host, {
  media: { resourceId: 'overlay-apng', variant: 'display', mimeType: 'video/webm', animated: true },
}, overlayContext)
assert.equal(mountedElements.at(-1) instanceof FakeVideoElement, true, 'animated overlay keeps the transparent WebM playback variant')
assert.equal(mountedElements.at(-1).src, '/resource/overlay-apng/display')
overlayHandle.update({
  media: { resourceId: 'overlay-video', variant: 'display', mimeType: 'video/webm' },
})
assert.equal(mountedElements.at(-1) instanceof FakeVideoElement, true, 'real WebM overlay remains video')
assert.equal(mountedElements.at(-1).src, '/resource/overlay-video/display')
overlayHandle.destroy()
global.document = previousDocument
global.HTMLVideoElement = previousVideoElement

const effectOverlaySource = fs.readFileSync(path.join(__dirname, '../src/views/theater/effects/TheaterEffectOverlay.vue'), 'utf8')
const stageAppSource = fs.readFileSync(path.join(__dirname, '../src/views/theater/stage/StageApp.vue'), 'utf8')
assert.match(effectOverlaySource, /props\.resolveMedia\(image\)/, 'effect media must use the shared stage media resolver')
assert.match(effectOverlaySource, /mediaLocation\(playback\)\?\.sourceKind === 'video'/, 'effect video selection must use resolved source kind')
assert.match(effectOverlaySource, /mimeType\.startsWith\('video\/'\)/, 'legacy effect media must remain classified as animated after image fallback')
assert.match(effectOverlaySource, /mediaFxFilterToCss\(normalizeMediaFxSpec\(playback\.object\.metadata\?\.mediaFx\)\.filter\)/, 'animated effect filters must stay on the live media element')
assert.match(effectOverlaySource, /filters: capabilities\.filters && !mediaIsAnimated\(playback\)/, 'animated effect wrapper must not own the CSS filter')
assert.match(stageAppSource, /else if \(isAnimatedStageImageRef\(imageRef\)\)/, 'native fallback remains classified as animated when no display WebM exists')
assert.match(stageAppSource, /reveal\?\.\(\)\s*\n\s*activate\?\.\(\)/, 'media activation must not depend on having a reveal callback')
assert.match(stageAppSource, /:resolve-media="resolveTheaterStageMedia"/, 'StageApp must provide the shared media resolver to effects')
assert.match(stageAppSource, /:overlays="sceneOverlayRenderBindings"/, 'scene overlays must use runtime compatibility bindings')
assert.match(stageAppSource, /surfaceMediaFxFilterCss\(slot, raster\.pixelRatio, true\)/, 'video surfaces must stage Media FX Basic filters before live Advanced/Temporal')
assert.match(stageAppSource, /mediaFxFilterToCss\(stageObjectMediaFx\(current\)\.filter, \{ blurScale: raster\.pixelRatio \}\)/, 'video objects must stage their Basic filter without entering Konva cache')
assert.match(stageAppSource, /basic,\s*\n\s*advanced: mediaFxGpuAvailable\.value \? spec\.advanced : null/, 'Stage live objects must keep Basic independently of GPU availability')

console.log('theater stage media regression checks passed')
