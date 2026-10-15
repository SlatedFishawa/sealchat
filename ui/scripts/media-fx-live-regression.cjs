// Run with node scripts/media-fx-live-regression.cjs.
// Media FX live media (phase 2): the capability model, the live GPU session against a
// state-tracking mock WebGL2 (same mock shape as media-fx-multipass-regression), and the
// live renderer scheduling (video frame callbacks, the shared clock, gates, failures and
// cleanup). Real shader pixels are covered by the headless Chrome check.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const featureDir = path.join(__dirname, '../src/features/media-fx')
const compile = source => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText

const loadModule = (name, overrides = {}, cache = {}) => {
  if (overrides[name]) return overrides[name]
  if (cache[name]) return cache[name].exports
  const module = { exports: {} }
  cache[name] = module
  const localRequire = (specifier) => {
    if (overrides[specifier]) return overrides[specifier]
    if (specifier.startsWith('./')) return loadModule(specifier, overrides, cache)
    return require(specifier)
  }
  const source = fs.readFileSync(path.join(featureDir, `${name.slice(2)}.ts`), 'utf8')
  new Function('exports', 'require', 'module', compile(source))(module.exports, localRequire, module)
  return module.exports
}

const programKind = (fragment) => {
  if (fragment.includes('#define MEDIA_FX_LIGHT')) return 'composite'
  if (fragment.includes('uBloomWeight')) return 'extract'
  if (fragment.includes('uDirection')) return 'blur'
  return 'main'
}

const createMock = () => ({
  contexts: 0, contextAttributes: [], canvases: [], ids: 0, textures: [], framebuffers: [], programs: [], deleted: [],
  draws: [], reads: 0, uploads: [], allocations: [], error: 0, lost: false, maxTextureSize: 8192,
  incomplete: false, feedback: 0, warnings: [], listeners: [], pixelStore: {},
})

const createStatefulGl = (mock, canvas) => {
  const state = { unit: 0, units: [null, null], framebuffer: null, program: null, viewport: [0, 0, 0, 0] }
  const constants = {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4, MAX_TEXTURE_SIZE: 5, NO_ERROR: 0,
    TEXTURE_2D: 6, RGBA8: 7, RGBA: 8, UNSIGNED_BYTE: 9, TRIANGLES: 10, TEXTURE0: 100, TEXTURE1: 101,
    FRAMEBUFFER: 20, COLOR_ATTACHMENT0: 21, FRAMEBUFFER_COMPLETE: 22, LINEAR: 23, NEAREST: 24,
    UNPACK_FLIP_Y_WEBGL: 30, UNPACK_PREMULTIPLY_ALPHA_WEBGL: 31, UNPACK_COLORSPACE_CONVERSION_WEBGL: 32, NONE: 33,
    BLEND: 34,
  }
  const gl = {
    ...constants,
    state,
    get drawingBufferWidth() { return canvas.width },
    get drawingBufferHeight() { return canvas.height },
    createShader: (type) => ({ type }),
    shaderSource: (shader, source) => { shader.source = source },
    compileShader: () => {},
    getShaderParameter: () => true,
    deleteShader: () => {},
    createProgram: () => { const program = { id: ++mock.ids, shaders: [] }; mock.programs.push(program); return program },
    attachShader: (program, shader) => { program.shaders.push(shader) },
    linkProgram: (program) => {
      program.fragment = program.shaders.find(shader => shader.type === 2).source
      program.kind = programKind(program.fragment)
    },
    getProgramParameter: () => true,
    deleteProgram: (program) => mock.deleted.push(program),
    useProgram: (program) => { state.program = program },
    getUniformLocation: (program, name) => ({ program, name }),
    uniform1f: (location, value) => { location.program[location.name] = value },
    uniform1i: (location, value) => { location.program[location.name] = value },
    uniform2f: (location, x, y) => { location.program[location.name] = [x, y] },
    uniform2i: (location, x, y) => { location.program[location.name] = [x, y] },
    pixelStorei: (key, value) => { mock.pixelStore[key] = value },
    createTexture: () => { const texture = { id: ++mock.ids, width: 0, height: 0 }; mock.textures.push(texture); return texture },
    deleteTexture: (texture) => mock.deleted.push(texture),
    activeTexture: (unit) => { state.unit = unit - constants.TEXTURE0 },
    bindTexture: (_target, texture) => { state.units[state.unit] = texture },
    texParameteri: () => {},
    texImage2D: (...args) => {
      const texture = state.units[state.unit]
      if (args.length === 6) {
        mock.uploads.push({ texture, source: args[5] })
        return
      }
      texture.width = args[3]
      texture.height = args[4]
      mock.allocations.push({ texture, width: args[3], height: args[4], data: args[8] })
    },
    createFramebuffer: () => { const framebuffer = { id: ++mock.ids, attachment: null }; mock.framebuffers.push(framebuffer); return framebuffer },
    deleteFramebuffer: (framebuffer) => mock.deleted.push(framebuffer),
    bindFramebuffer: (_target, framebuffer) => { state.framebuffer = framebuffer; state.viewport = ['stale']; state.program = { kind: 'stale' } },
    framebufferTexture2D: (_target, _attachment, _textarget, texture) => { state.framebuffer.attachment = texture },
    checkFramebufferStatus: () => (mock.incomplete ? 0 : constants.FRAMEBUFFER_COMPLETE),
    viewport: (...args) => { state.viewport = args },
    drawArrays: () => {
      const target = state.framebuffer?.attachment ?? null
      if (target && state.units.includes(target)) mock.feedback += 1
      const program = state.program
      mock.draws.push({
        kind: program.kind,
        target,
        viewport: [...state.viewport],
        unit0: state.units[0],
        unit1: state.units[1],
        uniforms: { ...program },
      })
    },
    readPixels: () => { mock.reads += 1 },
    getError: () => { const error = mock.error; mock.error = 0; return error },
    isContextLost: () => mock.lost,
    getParameter: () => mock.maxTextureSize,
  }
  return new Proxy(gl, { get: (target, key) => (key in target ? target[key] : () => {}) })
}

const installMock = (mock) => {
  global.WebGL2RenderingContext = function WebGL2RenderingContext() {}
  global.document = {
    visibilityState: 'visible',
    createElement: () => {
      const canvas = { width: 1, height: 1 }
      canvas.getContext = (type, attributes) => {
        if (type !== 'webgl2') return null
        mock.contexts += 1
        mock.contextAttributes.push(attributes)
        mock.canvases.push(canvas)
        canvas.gl = createStatefulGl(mock, canvas)
        return canvas.gl
      }
      canvas.addEventListener = (type, listener) => { if (type === 'webglcontextlost') mock.listeners.push({ canvas, listener }) }
      return canvas
    },
  }
}

// ---------------------------------------------------------------------------
// Fakes for the renderer: video, staging canvas, clock, GPU session
// ---------------------------------------------------------------------------

const createVideo = ({ frameCallbacks = true } = {}) => {
  const callbacks = new Map()
  const listeners = new Map()
  let ids = 0
  const emit = type => [...(listeners.get(type) || [])].forEach(listener => listener())
  const video = {
    readyState: 4,
    videoWidth: 640,
    videoHeight: 360,
    currentTime: 0,
    paused: false,
    ended: false,
    playbackRate: 1,
    callbacks,
    cancelled: 0,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(listener)
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener) },
    pausePlayback() { video.paused = true; emit('pause') },
    playPlayback() { video.paused = false; video.ended = false; emit('play') },
    endPlayback() { video.paused = true; video.ended = true; emit('ended') },
    // Presents one decoded frame: every pending callback runs once.
    fire() {
      const pending = [...callbacks.values()]
      callbacks.clear()
      pending.forEach(callback => callback(0, {}))
    },
  }
  if (frameCallbacks) {
    video.requestVideoFrameCallback = (callback) => { ids += 1; callbacks.set(ids, callback); return ids }
    video.cancelVideoFrameCallback = (id) => { if (callbacks.delete(id)) video.cancelled += 1 }
  }
  return video
}

const createStagingCanvases = () => {
  const created = []
  const create = () => {
    const ops = []
    const context = {
      filter: 'none',
      clearRect: (...args) => ops.push(['clearRect', ...args]),
      save: () => ops.push(['save']),
      restore: () => ops.push(['restore']),
      drawImage: (source, ...args) => ops.push(['drawImage', source, context.filter, ...args]),
    }
    const canvas = { width: 0, height: 0, ops, getContext: () => context }
    created.push(canvas)
    return canvas
  }
  return { created, create }
}

const createManualClock = () => {
  const listeners = new Set()
  let time = 0
  return {
    listeners,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    tick(delta = 1 / 30) {
      time += delta
      ;[...listeners].forEach(listener => listener({ time, delta }))
    },
    get running() { return listeners.size > 0 },
    get subscribers() { return listeners.size },
  }
}

const createFakeSession = () => {
  const session = {
    renders: [],
    released: 0,
    disposed: 0,
    fail: false,
    throwOnRender: false,
    render(input, advanced, temporal, time) {
      if (session.throwOnRender) throw new Error('context lost')
      session.renders.push({ frameId: input.frameId, source: input.source, advanced, temporal, time, width: input.width, height: input.height })
      if (session.fail) return null
      return { canvas: { id: 'shared' }, x: 0, y: 0, width: input.width, height: input.height }
    },
    release() { session.released += 1 },
    dispose() { session.disposed += 1 },
  }
  return session
}

async function run() {
  const originalDocument = global.document
  const originalWebGL2 = global.WebGL2RenderingContext
  const originalWarn = console.warn
  const mock = createMock()
  console.warn = (...args) => mock.warnings.push(args.join(' '))
  installMock(mock)
  const core = loadModule('./media-fx')
  const cache = {}
  const gpu = loadModule('./media-fx-gpu', {}, cache)
  const live = loadModule('./media-fx-live', {}, cache)
  const temporalModule = loadModule('./media-fx-temporal', {}, cache)
  const off = core.createDefaultMediaFxAdvanced()
  const adv = patch => ({ ...off, ...patch })
  const offTemporal = core.createDefaultMediaFxTemporal()
  const tmp = patch => ({ ...offTemporal, ...patch })

  // --- capabilities: animated media vs live-frame renderers ------------------------------
  const caps = core.resolveMediaFxCapabilities
  assert.deepEqual(caps('konva', true, true, true), {
    motion: true, filters: false, advanced: false, temporal: false, animatedMedia: true, livePixels: false,
  }, 'animated media alone never enables pixel effects (static Konva cache stays off)')
  assert.deepEqual(caps('konva', true, true, true, true), {
    motion: true, filters: false, advanced: true, temporal: true, animatedMedia: true, livePixels: true,
  }, 'a live-frame Konva renderer gets advanced / temporal, never the cache basic filter')
  assert.deepEqual(caps('dom', true, true, true, true), {
    motion: true, filters: true, advanced: true, temporal: true, animatedMedia: true, livePixels: true,
  }, 'DOM live video keeps its basic filter and gains advanced / temporal')
  assert.deepEqual(caps('bake', true, true, true, true), {
    motion: false, filters: false, advanced: false, temporal: false, animatedMedia: true, livePixels: false,
  }, 'bake never has live pixels')
  assert.equal(caps('dom', true, false, false, true).advanced, false, 'livePixels never opts in by itself')
  assert.equal(caps('konva', false, true, true, true).livePixels, false, 'static media never reports live pixels')
  assert.deepEqual(caps('konva', false, true, true), caps('konva', false, true, true, true), 'static capabilities are unchanged by the live flag')

  // --- live raster budget ----------------------------------------------------------------
  const raster = live.resolveMediaFxLiveRaster(640, 360, 2)
  assert.deepEqual([raster.width, raster.height, raster.pixelRatio], [1280, 720, 2], 'display size x DPR')
  const huge = live.resolveMediaFxLiveRaster(3840, 2160, 2)
  assert.ok(huge.width * huge.height <= live.MEDIA_FX_LIVE_MAX_RASTER_PIXELS, '4K displays stay within the live pixel budget')
  assert.ok(huge.width <= live.MEDIA_FX_LIVE_MAX_RASTER_EDGE && huge.height <= live.MEDIA_FX_LIVE_MAX_RASTER_EDGE)
  assert.equal(live.resolveMediaFxLiveRaster(0, 10, 1), null)
  assert.deepEqual(temporalModule.resolveMediaFxTemporalRaster(640, 360, 2), { width: 1280, height: 720, pixelRatio: 2 }, 'the temporal raster default budget is unchanged')

  // --- GPU live session --------------------------------------------------------------------
  const session = gpu.createMediaFxLiveGpuSession()
  const source = { id: 'staging' }
  const frame = (frameId, width = 64, height = 32) => ({ source, width, height, pixelRatio: 1, frameId })
  assert.equal(session.render(frame(1), off, offTemporal, 0), null, 'all-default params draw nothing')
  assert.equal(mock.contexts, 0, 'all-default params never create a WebGL context')

  const glitchy = adv({ rgbSplit: 0.3, posterize: 0.4 })
  const first = session.render(frame(1), glitchy, null, 0)
  assert.ok(first, 'advanced-only frame renders')
  assert.equal(mock.contexts, 1)
  assert.equal(mock.contextAttributes[0].premultipliedAlpha, false, 'straight alpha drawing buffer')
  assert.equal(mock.contextAttributes[0].alpha, true, 'transparent drawing buffer')
  assert.equal(mock.pixelStore[30], false, 'no implicit flip on upload')
  assert.equal(mock.pixelStore[31], false, 'uploads keep straight alpha (no premultiply)')
  assert.equal(mock.uploads.length, 1, 'one upload for a new frame')
  assert.equal(mock.uploads[0].source, source, 'the staging raster is uploaded directly (no CPU pixel copy)')
  assert.deepEqual(mock.draws.map(draw => draw.kind), ['main', 'main'], 'advanced pass + final draw')
  const [advancedDraw, presentDraw] = mock.draws
  const liveTexture = mock.uploads[0].texture
  assert.ok(advancedDraw.target, 'advanced renders into the session target')
  assert.equal(advancedDraw.unit0, liveTexture, 'advanced reads the uploaded frame')
  assert.equal(advancedDraw.uniforms.uFlipY, 0, 'advanced is the static pass (no flip)')
  assert.ok(advancedDraw.uniforms.uRgbSplit > 0 && advancedDraw.uniforms.uPosterizeLevels > 1, 'advanced params are applied in the advanced pass')
  assert.equal(advancedDraw.uniforms.uGlitch, 0, 'no temporal effect in the advanced pass')
  assert.equal(presentDraw.target, null, 'the final draw goes to the shared canvas')
  assert.equal(presentDraw.unit0, advancedDraw.target, 'the final draw reads the advanced result')
  assert.equal(presentDraw.uniforms.uFlipY, 1, 'the final draw flips for canvas display')
  assert.equal(presentDraw.uniforms.uRgbSplit, 0, 'advanced is not applied twice')
  assert.deepEqual(presentDraw.viewport, [0, 0, 64, 32])
  assert.deepEqual([first.width, first.height, first.x, first.y], [64, 32, 0, first.canvas.height - 32], 'frame region of the shared canvas')
  assert.equal(mock.reads, 0, 'live frames never read pixels back')

  mock.draws = []
  assert.ok(session.render(frame(1), glitchy, null, 0))
  assert.equal(mock.uploads.length, 1, 'the same frame is never uploaded again')
  assert.deepEqual(mock.draws.map(draw => draw.target), [null], 'the same frame and params only repeat the final draw')

  mock.draws = []
  const rolling = tmp({ glitch: 0.6, scanlineRoll: 0.4 })
  for (let index = 1; index <= 5; index += 1) assert.ok(session.render(frame(1), glitchy, rolling, index / 30))
  assert.equal(mock.uploads.length, 1, 'temporal ticks reuse the uploaded texture')
  assert.equal(mock.draws.length, 5, 'temporal ticks only run the final draw')
  assert.ok(mock.draws.every(draw => draw.target === null && draw.unit0 === advancedDraw.target), 'temporal runs over the cached advanced result')
  assert.ok(mock.draws.every(draw => draw.uniforms.uGlitch === 0.6 && draw.uniforms.uRgbSplit === 0), 'temporal after advanced, never mixed into it')
  assert.equal(mock.draws[4].uniforms.uTime, 5 / 30)

  mock.draws = []
  assert.ok(session.render(frame(2), glitchy, rolling, 0.5))
  assert.equal(mock.uploads.length, 2, 'a new video frame updates the texture')
  assert.deepEqual(mock.draws.map(draw => draw.target === null ? 'present' : 'advanced'), ['advanced', 'present'], 'source -> advanced -> temporal')
  assert.equal(mock.draws[1].uniforms.uGlitch, 0.6)

  mock.draws = []
  assert.ok(session.render(frame(2), adv({ edge: 0.5 }), null, 0))
  assert.equal(mock.uploads.length, 2, 'new advanced params re-run advanced without re-uploading')
  assert.equal(mock.draws.length, 2)

  mock.draws = []
  assert.ok(session.render(frame(2), null, rolling, 1))
  assert.equal(mock.draws.length, 1, 'temporal-only skips the advanced pass')
  assert.equal(mock.draws[0].unit0, liveTexture, 'temporal-only reads the staged frame directly')
  assert.ok(mock.deleted.includes(advancedDraw.target), 'the advanced target is dropped when advanced is turned off')
  assert.equal(mock.feedback, 0, 'no texture is sampled while it is the render target')

  // Bloom / glow: the existing light pipeline is built once and reused per frame.
  mock.draws = []
  const allocationsBefore = mock.allocations.length
  assert.ok(session.render(frame(3), adv({ bloom: 0.6, vignette: 0.2 }), null, 0))
  assert.deepEqual(mock.draws.map(draw => draw.kind), ['extract', 'blur', 'blur', 'composite', 'main'], 'light chain into the advanced target, then the final draw')
  assert.equal(mock.draws[0].unit0, mock.uploads.at(-1).texture, 'light extracts from the live frame texture')
  assert.ok(mock.draws[3].target && mock.draws[3].target === mock.draws[4].unit0, 'the composite feeds the final draw')
  assert.equal(mock.draws[3].uniforms.uFlipY, 0)
  const lightPrograms = mock.programs.length
  const lightFramebuffers = mock.framebuffers.length
  const lightAllocations = mock.allocations.length
  for (let index = 4; index < 14; index += 1) assert.ok(session.render(frame(index), adv({ bloom: 0.6, vignette: 0.2 }), rolling, index))
  assert.equal(mock.programs.length, lightPrograms, 'bloom / glow never compile again per frame')
  assert.equal(mock.framebuffers.length, lightFramebuffers, 'no framebuffer per frame')
  assert.equal(mock.allocations.length, lightAllocations, 'light scratch targets are not re-specified per frame')
  assert.ok(lightAllocations > allocationsBefore)
  assert.equal(mock.feedback, 0)

  // Different live sizes share grow-only light scratch storage. Returning to a previous
  // logical size must not reallocate the two shared light textures.
  mock.draws = []
  assert.ok(session.render(frame(30, 640, 360), adv({ bloom: 0.6 }), null, 0))
  const lightTargets = new Set(mock.draws.filter(draw => draw.kind === 'extract' || draw.kind === 'blur').map(draw => draw.target))
  const lightAllocationCount = () => mock.allocations.filter(entry => lightTargets.has(entry.texture)).length
  const secondLiveSession = gpu.createMediaFxLiveGpuSession()
  const secondSource = { id: 'staging-b' }
  assert.ok(secondLiveSession.render({ source: secondSource, width: 360, height: 640, pixelRatio: 1, frameId: 1 }, adv({ bloom: 0.6 }), null, 0))
  const allocationsAfterSecondSize = lightAllocationCount()
  const secondComposite = mock.draws.filter(draw => draw.kind === 'composite').at(-1)
  assert.ok(secondComposite.uniforms.uLightStorageSize[0] >= secondComposite.uniforms.uLightSize[0])
  assert.ok(secondComposite.uniforms.uLightStorageSize[1] >= secondComposite.uniforms.uLightSize[1])
  assert.ok(secondComposite.uniforms.uLightStorageSize.some((value, index) => value > secondComposite.uniforms.uLightSize[index]), 'logical light raster is sampled inside the larger grow-only storage')
  assert.ok(session.render(frame(31, 640, 360), adv({ bloom: 0.6 }), null, 0))
  assert.equal(lightAllocationCount(), allocationsAfterSecondSize, 'A -> B -> A live sizes do not reallocate shared light scratch')
  secondLiveSession.dispose()

  // A static bake between live frames keeps working without shrinking scratch storage
  // that an active live session is still reusing.
  const still = { width: 8, height: 4, data: new Uint8ClampedArray(8 * 4 * 4).fill(7) }
  assert.equal(gpu.applyMediaFxGpu(still, adv({ bloom: 0.3 })), true, 'static passes still work next to live sessions')
  const lightAllocationsAfterStatic = lightAllocationCount()
  mock.draws = []
  assert.ok(session.render(frame(20, 640, 360), adv({ bloom: 0.6 }), null, 0), 'live works after a static pass without rebuilding shared light scratch')
  assert.equal(lightAllocationCount(), lightAllocationsAfterStatic, 'static bake does not shrink active live light scratch')
  assert.deepEqual(mock.draws.map(draw => draw.kind), ['extract', 'blur', 'blur', 'composite', 'main'])

  // Oversized raster / context loss: no frame, the caller falls back.
  assert.equal(session.render(frame(21, 9000, 8), glitchy, null, 0), null, 'MAX_TEXTURE_SIZE is respected')
  mock.lost = true
  assert.equal(session.render(frame(22), glitchy, null, 0), null, 'context loss returns no frame')
  mock.listeners.filter(entry => entry.canvas === mock.canvases.at(-1)).forEach(entry => entry.listener())
  mock.lost = false
  mock.draws = []
  assert.ok(session.render(frame(22), glitchy, null, 0), 'a later frame rebuilds its textures in the new context')
  assert.ok(mock.contexts > 1, 'a replacement context was created')
  assert.equal(mock.draws.length, 2)

  // Release / dispose free everything and shrink the shared canvas.
  const deletedBefore = mock.deleted.length
  session.release()
  assert.ok(mock.deleted.length >= deletedBefore + 2, 'release deletes the frame texture and the advanced target')
  assert.deepEqual([mock.canvases.at(-1).width, mock.canvases.at(-1).height], [1, 1], 'the shared canvas shrinks when no live session is left')
  const afterRelease = mock.deleted.length
  session.release()
  assert.equal(mock.deleted.length, afterRelease, 'an idle release is a no-op')
  session.dispose()
  assert.equal(session.render(frame(30), glitchy, null, 0), null, 'a disposed session never draws')

  // --- live renderer scheduling --------------------------------------------------------------
  const setup = (options = {}) => {
    const clock = createManualClock()
    const fake = createFakeSession()
    const canvases = createStagingCanvases()
    const liveChanges = []
    const presented = []
    const staged = []
    const state = { hidden: false, canRender: true, stageOk: true, presentOk: true, gpu: true }
    const renderer = live.createMediaFxLiveRenderer({
      clock,
      session: fake,
      createCanvas: canvases.create,
      gpuSupported: () => state.gpu,
      isHidden: () => state.hidden,
      canRender: () => state.canRender,
      stage: (context, video, size) => {
        staged.push({ video, size, filter: options.filter || 'none' })
        context.filter = options.filter || 'none'
        context.drawImage(video, 0, 0, size.width, size.height)
        return state.stageOk
      },
      present: (frameValue) => {
        presented.push(frameValue)
        return state.presentOk
      },
      onLiveChange: value => liveChanges.push(value),
    })
    return { clock, fake, canvases, liveChanges, presented, staged, state, renderer }
  }
  const input = (video, patch = {}) => ({
    video,
    sourceKey: 'video:a',
    stageKey: 'cover|none',
    raster: { width: 64, height: 36, pixelRatio: 1 },
    advanced: glitchy,
    temporal: null,
    active: true,
    ...patch,
  })

  // All-default: nothing is created or scheduled.
  {
    const t = setup()
    const video = createVideo()
    t.renderer.update(input(video, { advanced: off, temporal: offTemporal }))
    assert.equal(t.fake.renders.length, 0, 'all-default specs never render')
    assert.equal(t.canvases.created.length, 0, 'all-default specs never create a canvas')
    assert.equal(t.clock.subscribers, 0, 'all-default specs never subscribe to the clock')
    assert.equal(video.callbacks.size, 0, 'all-default specs never request video frames')
    assert.equal(t.renderer.running, false)
    t.renderer.dispose()
  }

  // Basic-only Stage-style live output: staging is the final frame, so it needs neither
  // the GPU session nor Konva cache and still follows decoded video frames.
  {
    const t = setup({ filter: 'contrast(1.4) blur(4px)' })
    const video = createVideo()
    t.state.gpu = false
    t.renderer.update(input(video, { basic: true, advanced: off, temporal: offTemporal, stageKey: 'stage-basic' }))
    assert.equal(t.fake.renders.length, 0, 'Basic-only live output never enters the GPU session')
    assert.equal(t.presented.length, 1, 'the staged Basic frame is presented directly')
    assert.equal(t.canvases.created[0].ops.find(op => op[0] === 'drawImage')[2], 'contrast(1.4) blur(4px)')
    assert.equal(t.renderer.live, true)
    assert.equal(video.callbacks.size, 1)
    video.fire()
    assert.equal(t.presented.length, 2, 'a new decoded frame refreshes Basic-only output once')
    t.renderer.dispose()
  }

  // Advanced-only: once per decoded video frame.
  {
    const t = setup({ filter: 'brightness(0.6)' })
    const video = createVideo()
    t.renderer.update(input(video))
    assert.equal(t.fake.renders.length, 1, 'the current frame is drawn right away')
    assert.deepEqual(t.liveChanges, [true], 'live after the first presented frame')
    assert.equal(t.clock.subscribers, 0, 'advanced-only never runs on the clock')
    assert.equal(video.callbacks.size, 1, 'waits for the next decoded frame')
    const staging = t.canvases.created[0]
    assert.deepEqual([staging.width, staging.height], [64, 36], 'staging raster has the live raster size')
    assert.deepEqual(staging.ops.slice(0, 3).map(op => op[0]), ['clearRect', 'save', 'drawImage'], 'the staging raster is cleared (transparent) before each frame')
    assert.equal(staging.ops[2][2], 'brightness(0.6)', 'basic filter is drawn into the staging raster before advanced')
    assert.equal(t.fake.renders[0].source, staging, 'advanced reads the basic-filtered staging raster')
    t.renderer.update(input(video))
    t.renderer.update(input(video))
    assert.equal(t.fake.renders.length, 1, 'no redraw without a new frame or change')
    for (let index = 0; index < 5; index += 1) t.clock.tick()
    assert.equal(t.fake.renders.length, 1, 'clock ticks never redraw advanced-only frames')
    video.fire()
    assert.equal(t.fake.renders.length, 2, 'a new decoded frame is processed once')
    assert.equal(t.fake.renders[1].frameId, t.fake.renders[0].frameId + 1, 'and uploaded as a new frame')
    assert.equal(video.callbacks.size, 1, 'one pending frame callback per video')
    assert.equal(t.staged.length, 2)
    t.renderer.update(input(video, { advanced: adv({ edge: 0.4 }) }))
    assert.equal(t.fake.renders.length, 3, 'new params redraw once')
    assert.equal(t.fake.renders[2].frameId, t.fake.renders[1].frameId, 'without re-staging / re-uploading the same video frame')
    assert.equal(t.staged.length, 2)
    t.renderer.update(input(video, { advanced: adv({ edge: 0.4 }), stageKey: 'contain|none' }))
    assert.equal(t.staged.length, 3, 'a geometry / filter change re-stages the current frame')
    assert.equal(t.fake.renders.at(-1).frameId, t.fake.renders[2].frameId + 1)
    assert.ok(t.fake.renders.every(entry => entry.temporal === null), 'no temporal params while temporal is off')
    t.renderer.dispose()
  }

  // Temporal: shared clock, texture reuse between video frames.
  {
    const t = setup()
    const video = createVideo()
    t.renderer.update(input(video, { temporal: tmp({ flicker: 0.5, speed: 2 }) }))
    assert.equal(t.clock.subscribers, 1, 'temporal subscribes to the shared clock')
    assert.equal(t.fake.renders.length, 0, 'temporal frames come from the clock')
    t.clock.tick(0.1)
    t.clock.tick(0.1)
    t.clock.tick(0.1)
    assert.equal(t.fake.renders.length, 3)
    assert.equal(new Set(t.fake.renders.map(entry => entry.frameId)).size, 1, 'ticks without a new video frame reuse the uploaded frame')
    assert.equal(t.staged.length, 1, 'and never re-stage it')
    assert.ok(Math.abs(t.fake.renders[2].time - 0.6) < 1e-9, 'temporal time follows the clock delta x speed')
    video.fire()
    assert.equal(t.fake.renders.length, 3, 'a new video frame waits for the next temporal tick')
    t.clock.tick(0.1)
    assert.equal(t.fake.renders[3].frameId, t.fake.renders[2].frameId + 1, 'the next tick uploads the new frame')
    assert.equal(t.staged.length, 2)

    // Actual video pause/end state also stops Temporal, independently of component
    // visibility. Advanced stays as one non-temporal frame and resumes on play.
    video.pausePlayback()
    assert.equal(t.clock.subscribers, 0, 'paused video leaves the temporal clock immediately')
    assert.equal(video.callbacks.size, 0, 'paused video cancels its decoded-frame callback')
    assert.equal(t.fake.renders.at(-1).temporal, null, 'paused video keeps one clean Advanced frame')
    assert.equal(t.renderer.live, true)
    const pausedRenders = t.fake.renders.length
    t.clock.tick(0.1)
    assert.equal(t.fake.renders.length, pausedRenders, 'paused video does no GPU work')
    video.playPlayback()
    assert.equal(t.clock.subscribers, 1, 'play resumes temporal scheduling')
    t.clock.tick(0.1)
    assert.equal(t.fake.renders.at(-1).temporal.flicker, 0.5)
    video.endPlayback()
    assert.equal(t.clock.subscribers, 0, 'ended video leaves the temporal clock')
    assert.equal(video.callbacks.size, 0)
    assert.equal(t.fake.renders.at(-1).temporal, null, 'finite-loop final frame is static after ended')
    video.playPlayback()
    assert.equal(t.clock.subscribers, 1, 'restarted video can resume Temporal')
    t.clock.tick(0.1)

    // Hidden page / gated visual: no live work.
    const rendersBeforeHiddenGate = t.fake.renders.length
    t.state.hidden = true
    t.clock.tick(0.1)
    t.state.hidden = false
    t.state.canRender = false
    t.clock.tick(0.1)
    t.state.canRender = true
    assert.equal(t.fake.renders.length, rendersBeforeHiddenGate, 'hidden page / hidden node does no GPU work')

    // Inactive: everything stops; the advanced look is kept as one clean frame.
    t.renderer.update(input(video, { temporal: tmp({ flicker: 0.5, speed: 2 }), active: false }))
    assert.equal(t.clock.subscribers, 0, 'inactive leaves the clock')
    assert.equal(video.callbacks.size, 0, 'inactive cancels the frame callback')
    assert.equal(t.fake.renders.at(-1).temporal, null, 'the kept frame is redrawn without temporal effects')
    assert.equal(t.renderer.live, true, 'an advanced frame stays shown while paused')
    assert.ok(t.fake.released >= 1, 'GPU textures are released while inactive')
    const rendersWhileInactive = t.fake.renders.length
    t.clock.tick(0.1)
    video.fire()
    assert.equal(t.fake.renders.length, rendersWhileInactive, 'no work while inactive')
    t.renderer.update(input(video, { temporal: tmp({ flicker: 0.5, speed: 2 }) }))
    t.clock.tick(0.1)
    assert.equal(t.fake.renders.length, rendersWhileInactive + 1, 'resumes on activation')
    t.renderer.dispose()
  }

  // Temporal-only inactive / reduced motion (temporal null from the consumer).
  {
    const t = setup()
    const video = createVideo()
    t.renderer.update(input(video, { advanced: null, temporal: tmp({ grain: 0.5 }) }))
    t.clock.tick()
    assert.equal(t.renderer.live, true)
    t.renderer.update(input(video, { advanced: null, temporal: tmp({ grain: 0.5 }), active: false }))
    assert.deepEqual(t.liveChanges, [true, false], 'temporal-only returns to the original media when paused')
    // Reduced motion: the consumer drops temporal, advanced keeps rendering.
    t.renderer.update(input(video, { advanced: glitchy, temporal: null }))
    assert.equal(t.clock.subscribers, 0, 'reduced motion: no temporal clock')
    assert.equal(t.renderer.live, true, 'reduced motion keeps advanced')
    assert.equal(t.fake.renders.at(-1).temporal, null)
    // Turning both off returns to the plain dynamic path.
    const before = t.fake.renders.length
    t.renderer.update(input(video, { advanced: off, temporal: offTemporal }))
    assert.equal(t.renderer.live, false, 'turning advanced / temporal off shows the original media')
    assert.equal(t.renderer.running, false)
    video.fire()
    assert.equal(t.fake.renders.length, before, 'and does no more work')
    t.renderer.dispose()
  }

  // Failures: staging that cannot reproduce Basic, GPU failure, context loss.
  for (const [name, breakIt] of [
    ['staging failure', t => { t.state.stageOk = false }],
    ['GPU failure', t => { t.fake.fail = true }],
    ['context loss', t => { t.fake.throwOnRender = true }],
    ['present failure', t => { t.state.presentOk = false }],
  ]) {
    const t = setup()
    const video = createVideo()
    t.renderer.update(input(video))
    breakIt(t)
    video.fire()
    assert.equal(t.renderer.live, false, `${name}: falls back to the original media`)
    assert.deepEqual(t.liveChanges, [true, false], `${name}: the consumer is told once`)
    assert.equal(t.renderer.running, false, `${name}: stops scheduling`)
    assert.equal(video.callbacks.size, 0)
    const renders = t.fake.renders.length
    t.renderer.update(input(video))
    video.fire()
    assert.equal(t.fake.renders.length, renders, `${name}: the same input does not retry every frame`)
    t.fake.fail = false
    t.fake.throwOnRender = false
    t.state.stageOk = true
    t.state.presentOk = true
    t.renderer.update(input(video, { stageKey: 'resized' }))
    assert.equal(t.renderer.live, true, `${name}: a new geometry / source tries again`)
    t.renderer.dispose()
  }
  {
    const t = setup()
    const video = createVideo()
    t.renderer.update(input(video))
    t.state.gpu = false
    t.renderer.update(input(video))
    assert.equal(t.renderer.live, false, 'GPU becoming unavailable falls back')
    t.renderer.dispose()
  }

  // No frame yet: wait, never show an empty output.
  {
    const t = setup()
    const video = createVideo()
    video.readyState = 1
    t.renderer.update(input(video))
    assert.equal(t.fake.renders.length, 0, 'no frame is drawn before the video has data')
    assert.equal(t.renderer.live, false, 'the original media stays visible meanwhile')
    video.readyState = 4
    video.fire()
    assert.equal(t.renderer.live, true)
    t.renderer.dispose()
  }

  // Source replacement: old frames never stand in for the new resource.
  {
    const t = setup()
    const first = createVideo()
    t.renderer.update(input(first))
    const oldCallbacks = [...first.callbacks.values()]
    const second = createVideo()
    second.readyState = 1
    t.renderer.update(input(second, { sourceKey: 'video:b' }))
    assert.deepEqual(t.liveChanges, [true, false], 'a new source hides the previous output immediately')
    assert.equal(first.callbacks.size, 0, 'the old video callback is cancelled')
    const renders = t.fake.renders.length
    oldCallbacks.forEach(callback => callback(0, {}))
    assert.equal(t.fake.renders.length, renders, 'a late callback of the old video is ignored')
    second.readyState = 4
    second.fire()
    assert.equal(t.fake.renders.at(-1).frameId > t.fake.renders[0].frameId, true, 'the new source uploads its own frame')
    assert.equal(t.renderer.live, true)
    // Same element, new src (Vue reuses the <video>): also a new source.
    t.renderer.update(input(second, { sourceKey: 'video:c' }))
    assert.equal(t.renderer.live, true, 'the current frame of the reused element is drawn again right away')
    assert.deepEqual(t.liveChanges, [true, false, true, false, true])
    // Candidate fallback to a static image: no video.
    t.renderer.update(input(null, { sourceKey: 'image:fallback' }))
    assert.equal(t.renderer.live, false, 'a static fallback candidate never keeps a video frame')
    assert.equal(t.renderer.running, false)
    t.renderer.dispose()
  }

  // Dispose: nothing is scheduled afterwards.
  {
    const t = setup()
    const video = createVideo()
    t.renderer.update(input(video, { temporal: tmp({ glitch: 0.3 }) }))
    t.clock.tick()
    const callbacks = [...video.callbacks.values()]
    t.renderer.dispose()
    assert.equal(t.clock.subscribers, 0, 'dispose leaves the clock')
    assert.equal(video.callbacks.size, 0, 'dispose cancels the frame callback')
    assert.equal(t.fake.disposed, 1, 'dispose disposes the GPU session')
    assert.deepEqual([t.canvases.created[0].width, t.canvases.created[0].height], [0, 0], 'dispose frees the staging raster')
    const renders = t.fake.renders.length
    callbacks.forEach(callback => callback(0, {}))
    t.renderer.update(input(video))
    assert.equal(t.fake.renders.length, renders, 'a disposed renderer never draws again')
  }

  // Browsers without requestVideoFrameCallback: the shared clock polls currentTime.
  {
    const t = setup()
    const video = createVideo({ frameCallbacks: false })
    t.renderer.update(input(video))
    assert.equal(t.fake.renders.length, 0, 'fallback waits for the shared clock')
    assert.equal(t.clock.subscribers, 1, 'fallback uses the shared clock, not its own RAF')
    t.clock.tick()
    assert.equal(t.fake.renders.length, 1)
    t.clock.tick()
    t.clock.tick()
    assert.equal(t.fake.renders.length, 1, 'no redraw while currentTime is unchanged')
    video.currentTime = 0.04
    t.clock.tick()
    assert.equal(t.fake.renders.length, 2, 'a new playback position is processed once')
    video.pausePlayback()
    assert.equal(t.clock.subscribers, 0, 'fallback polling also stops when video pauses')
    const fallbackPausedRenders = t.fake.renders.length
    t.clock.tick()
    assert.equal(t.fake.renders.length, fallbackPausedRenders)
    video.playPlayback()
    assert.equal(t.clock.subscribers, 1, 'fallback polling resumes on play')
    video.currentTime = 0.08
    t.clock.tick()
    assert.equal(t.fake.renders.length, fallbackPausedRenders + 1)
    t.renderer.update(input(video, { active: false }))
    assert.equal(t.clock.subscribers, 0)
    t.renderer.dispose()
  }

  // Many visuals share one clock subscription each, never their own loop.
  {
    const clock = createManualClock()
    const renderers = Array.from({ length: 4 }, () => live.createMediaFxLiveRenderer({
      clock, session: createFakeSession(), createCanvas: createStagingCanvases().create, gpuSupported: () => true, isHidden: () => false,
      stage: () => true, present: () => true,
    }))
    renderers.forEach(renderer => renderer.update(input(createVideo(), { temporal: tmp({ grain: 0.2 }) })))
    assert.equal(clock.subscribers, 4, 'each temporal visual is one listener of the shared clock')
    renderers.forEach(renderer => renderer.dispose())
    assert.equal(clock.subscribers, 0)
  }

  // End to end with the real GPU session: basic-staged frame -> advanced -> temporal.
  {
    const e2eMock = createMock()
    installMock(e2eMock)
    const e2eCache = {}
    loadModule('./media-fx-gpu', {}, e2eCache)
    const e2eLive = loadModule('./media-fx-live', {}, e2eCache)
    const clock = createManualClock()
    const canvases = createStagingCanvases()
    const outputs = []
    const renderer = e2eLive.createMediaFxLiveRenderer({
      clock, createCanvas: canvases.create, isHidden: () => false,
      stage: (context, video, size) => { context.filter = 'sepia(0.5)'; context.drawImage(video, 0, 0, size.width, size.height); return true },
      present: (value) => { outputs.push(value); return true },
    })
    const video = createVideo()
    renderer.update(input(video, { temporal: tmp({ scanlineRoll: 0.5 }) }))
    for (let index = 0; index < 4; index += 1) clock.tick()
    video.fire()
    clock.tick()
    assert.equal(e2eMock.uploads.length, 2, 'two video frames, two uploads over five temporal ticks')
    assert.ok(e2eMock.uploads.every(upload => upload.source === canvases.created[0]), 'uploads come from the basic-filtered staging raster')
    const kinds = e2eMock.draws.map(draw => (draw.target ? 'advanced' : 'present'))
    assert.deepEqual(kinds, ['advanced', 'present', 'present', 'present', 'present', 'advanced', 'present'], 'advanced once per video frame, temporal every tick')
    assert.equal(outputs.length, 5)
    renderer.dispose()
    assert.equal(e2eMock.deleted.filter(entry => entry.width !== undefined).length >= 2, true, 'dispose deletes the session textures')
  }

  // --- Konva adapter (Stage objects / surfaces) -------------------------------------------
  {
    // Konva nodes need the real (absent) document; earlier sections installed fakes.
    const fakeDocument = global.document
    global.document = originalDocument
    const Konva = (await import('konva')).default
    const konvaModule = loadModule('./media-fx-konva', {
      konva: { __esModule: true, default: Konva },
      './media-fx-gpu': { mediaFxGpuSupported: () => true, createMediaFxGpuFilter: () => null },
      './media-fx-canvas': { canvasFilterSupported: () => true },
    })
    let draws = 0
    const layer = { batchDraw: () => { draws += 1 } }
    const motionGroup = new Konva.Group()
    motionGroup.getLayer = () => layer
    const sourceNode = new Konva.Image({ image: { width: 200, height: 100 }, width: 200, height: 100 })
    const sibling = new Konva.Rect({ width: 10, height: 10 })
    motionGroup.add(sourceNode)
    motionGroup.add(sibling)
    let caches = 0
    sourceNode.cache = () => { caches += 1; return sourceNode }
    global.document = fakeDocument
    const hidden = []
    let rendererOptions = null
    const updates = []
    let rendererLive = false
    let rendererDisposed = false
    const outputs = []
    const controller = konvaModule.createKonvaMediaFxLiveController({
      sourceNode,
      stage: () => true,
      setSourceHidden: value => hidden.push(value),
      createRenderer: (options) => {
        rendererOptions = options
        return {
          update: input => updates.push(input),
          get live() { return rendererLive },
          dispose: () => { rendererDisposed = true },
        }
      },
      createCanvas: () => {
        const canvas = { width: 0, height: 0, draws: [] }
        canvas.getContext = () => ({ clearRect: () => {}, drawImage: (...args) => canvas.draws.push(args) })
        outputs.push(canvas)
        return canvas
      },
    })
    const output = controller.outputNode
    assert.equal(output.getParent(), motionGroup, 'output shares the source parent (motion group / clip)')
    assert.equal(output.zIndex(), sourceNode.zIndex() + 1, 'output sits right above its source')
    assert.equal(output.visible(), false, 'output is hidden until the first frame')
    assert.equal(output.listening(), false, 'hit testing stays on the source node')
    const video = createVideo().video
    controller.update({
      video, sourceKey: 'a', stageKey: '', rect: { x: 5, y: 6, width: 200, height: 100 }, displayScale: 2, opacity: 0.5,
      advanced: { ...core.createDefaultMediaFxSpec().advanced, sharpen: 0.5 }, temporal: null, active: true,
    })
    assert.deepEqual([output.x(), output.y(), output.width(), output.height(), output.opacity()], [5, 6, 200, 100, 0.5])
    assert.deepEqual([updates[0].raster.width, updates[0].raster.height, updates[0].raster.pixelRatio], [400, 200, 2], 'raster follows display size x DPR')
    assert.equal(rendererOptions.canRender(), true)
    motionGroup.visible(false)
    assert.equal(rendererOptions.canRender(), false, 'invisible parents do no live work')
    motionGroup.visible(true)
    const frame = { canvas: { width: 400, height: 200 }, width: 400, height: 200 }
    assert.equal(rendererOptions.present(frame), true)
    assert.equal(output.image(), outputs[0], 'frames are copied into the output node canvas')
    rendererLive = true
    rendererOptions.onLiveChange(true)
    assert.deepEqual([output.visible(), hidden.at(-1)], [true, true], 'live output replaces the source drawing')
    assert.equal(caches, 0, 'live media never builds a Konva cache')
    rendererLive = false
    rendererOptions.onLiveChange(false)
    assert.deepEqual([output.visible(), hidden.at(-1), output.image(), outputs[0].width], [false, false, undefined, 0], 'stopping restores the source and frees the output')
    rendererLive = true
    rendererOptions.onLiveChange(true)
    const drawsBefore = draws
    controller.dispose()
    assert.equal(rendererDisposed, true)
    assert.equal(hidden.at(-1), false, 'dispose while live shows the source again')
    assert.equal(output.getParent(), null, 'dispose removes the output node')
    assert.ok(draws > drawsBefore, 'dispose redraws the layer')
    assert.equal(sourceNode.getParent(), motionGroup, 'the source node is untouched')
    rendererOptions.onLiveChange(false)
    assert.equal(hidden.length, 4, 'late callbacks after dispose are ignored')

    // StageApp wiring: dynamic objects keep the static cache path off; surfaces skip tiles.
    const stageSource = fs.readFileSync(path.join(__dirname, '../src/views/theater/stage/StageApp.vue'), 'utf8')
    const liveSync = stageSource.slice(stageSource.indexOf('const syncObjectLiveFx'), stageSource.indexOf('const syncObjectLiveFx') + 4000)
    assert.equal(/\.cache\(/.test(liveSync), false, 'object live sync never caches')
    assert.ok(stageSource.includes('if (slot.liveFx?.live)'), 'surface media drawing yields to live output')
    assert.equal(/getImageData|readPixels|putImageData/.test(stageSource.slice(stageSource.indexOf('const drawSurfaceLiveFrame'), stageSource.indexOf('const drawSurfaceLiveFrame') + 2000)), false)
  }

  // Source hygiene: the live core never reads pixels on the CPU and owns no RAF loop.
  const liveSource = fs.readFileSync(path.join(featureDir, 'media-fx-live.ts'), 'utf8')
  assert.equal(/getImageData|putImageData|readPixels/.test(liveSource), false, 'no CPU pixel access in the live frame loop')
  assert.equal(/requestAnimationFrame|setInterval|setTimeout/.test(liveSource), false, 'no per-visual RAF / timer loop')
  const gpuSource = fs.readFileSync(path.join(featureDir, 'media-fx-gpu.ts'), 'utf8')
  assert.equal((gpuSource.match(/const FRAGMENT_SHADER = /g) || []).length, 1, 'still exactly one main fragment shader')
  assert.equal(/LIVE_FRAGMENT|LIVE_SHADER/.test(gpuSource), false, 'no second shader for live frames')

  console.warn = originalWarn
  global.document = originalDocument
  global.WebGL2RenderingContext = originalWebGL2
  console.log('media-fx live regression passed')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
