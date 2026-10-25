import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { compileScript, parse } from '@vue/compiler-sfc'
import { createRenderer, h, nextTick, shallowRef, toRaw, type Component } from 'vue'
import ts from 'typescript'
import { createDefaultMediaFxSpec, mediaFxFilterToCss } from '../src/features/media-fx/media-fx'
import { vMediaFx } from '../src/features/media-fx/media-fx-dom'
import { createDefaultTheaterPresentation, normalizeTheaterPresentation, type TheaterMediaRef } from '../src/types/theaterPresentation'
import { createTheaterPresentationEditorState, createTheaterVisualLayer, dispatchTheaterEditorCommand } from '../src/components/theater-presentation/theaterPresentationEditorState'
import { createTheaterMediaFxAdvancedController, type TheaterMediaFxRasterJob } from '../src/components/theater-presentation/theaterMediaFxAdvanced'

const still: TheaterMediaRef = { assetId: 'host-still', resourceAttachmentId: 'host-primary', mimeType: 'image/png', kind: 'static_image', width: 400, height: 800 }
const frame = createTheaterVisualLayer(still, 'dialogue', 'frame')
const night = () => ({ ...createDefaultMediaFxSpec(), filter: { ...createDefaultMediaFxSpec().filter, brightness: 0.6 } })
const glitch = () => ({ ...night(), advanced: { ...createDefaultMediaFxSpec().advanced, rgbSplit: 0.4, edge: 0.3, grain: 0.2 } })
const rolling = (patch = {}) => ({ ...night(), temporal: { ...createDefaultMediaFxSpec().temporal, scanlineRoll: 0.5, ...patch } })
const settle = () => new Promise(resolve => setImmediate(resolve))

// Mount the real host and media component together for source-lifecycle regression.
// Pixel work is controlled, but
// Vue owns prop replacement, source watchers, keyed images, refs and output visibility.
export const runAdvancedHostTests = async () => {
  type Node = {
    tag: string
    props: Record<string, unknown>
    children: Node[]
    parent?: Node
    style: { display: string, filter: string, removeProperty(name: string): void }
    animations: Array<{ cancelled: boolean, cancel(): void }>
    animate(): { cancelled: boolean, cancel(): void }
    currentTime: number
    playbackRate: number
    defaultPlaybackRate: number
    playCalls: number
    pauseCalls: number
    sourceWrites: number
    play(): Promise<void>
    pause(): void
    width: number
    height: number
    getBoundingClientRect(): { width: number, height: number }
    getContext(): { drawImage(output: unknown): void } | null
  }
  const control = {
    gate: null as Promise<void> | null,
    failSource: false,
    failRaster: false,
    failPresent: false,
    fit: 'cover' as 'cover' | null,
    maxTextureSize: 4096 as number | null,
    gpuAvailable: true,
    canvasFilter: true,
  }
  let notifyGpu: ((available: boolean) => void) | null = null
  const presented: unknown[] = []
  class ElementStub {}
  const node = (tag: string): Node => Object.assign(new ElementStub(), {
    tag, props: {}, children: [],
    style: { display: '', filter: '', removeProperty(name: string) { if (name === 'filter') this.filter = '' } },
    animations: [] as Node['animations'],
    animate(this: Node) {
      const animation = { cancelled: false, cancel() { this.cancelled = true } }
      this.animations.push(animation)
      return animation
    },
    currentTime: 0, playbackRate: 1, defaultPlaybackRate: 1, playCalls: 0, pauseCalls: 0, sourceWrites: 0,
    play(this: Node) { this.playCalls += 1; return Promise.resolve() },
    pause(this: Node) { this.pauseCalls += 1 },
    width: 300, height: 150,
    getBoundingClientRect: () => ({ width: 300, height: 150 }),
    getContext: () => control.failPresent ? null : ({ drawImage: (output: unknown) => { presented.push(output) } }),
  })
  const renderer = createRenderer<Node, Node>({
    createElement: node,
    createText: () => node('#text'),
    createComment: () => node('#comment'),
    setText: () => undefined,
    setElementText: () => undefined,
    patchProp: (el, key, _old, value) => {
      el.props[key] = value
      if (key === 'src') el.sourceWrites += 1
    },
    insert: (el, parent, anchor) => {
      if (el.parent) el.parent.children = el.parent.children.filter(child => child !== el)
      el.parent = parent
      const index = anchor ? parent.children.indexOf(anchor) : -1
      if (index < 0) parent.children.push(el)
      else parent.children.splice(index, 0, el)
    },
    remove: (el) => { if (el.parent) el.parent.children = el.parent.children.filter(child => child !== el) },
    parentNode: el => el.parent || null,
    nextSibling: el => el.parent?.children[el.parent.children.indexOf(el) + 1] || null,
  })
  // Temporal player stub: the real player / clock are covered by media-fx-temporal-regression.
  type TemporalPlayerStub = {
    options: { present: (frame: unknown) => boolean, onLiveChange?: (live: boolean) => void }
    baselines: Array<{ source: unknown, width: number, height: number, pixelRatio: number } | null>
    updates: Array<{ temporal: { glitch: number, scanlineRoll: number }, active: boolean }>
    live: boolean
    disposed: boolean
  }
  const temporalPlayers: TemporalPlayerStub[] = []
  // Live renderer stub: the real scheduling / GPU session are covered by media-fx-live-regression.
  type LiveRendererStub = {
    options: { onLiveChange: (live: boolean) => void }
    updates: Array<{ video: unknown, sourceKey: string, stageKey: string, advanced: unknown, temporal: unknown, active: boolean }>
    disposed: boolean
  }
  const liveRenderers: LiveRendererStub[] = []
  const hostProps = shallowRef<Record<string, unknown>>({})
  const timers: Array<() => void> = []
  const rasters: TheaterMediaFxRasterJob[] = []
  const loads: string[] = []
  const advancedModule = require('../src/components/theater-presentation/theaterMediaFxAdvanced')
  let mediaComponent: { default: Component }
  const localRequire = (id: string): unknown => {
    if (id === '@/stores/display') return { useDisplayStore: () => ({ settings: { preferStaticAvatarDecoration: false } }) }
    if (id === '@/composables/useAttachmentResolver') return { resolveAttachmentUrl: (id: string) => `https://cdn.test/${id}.png` }
    if (id === '@/features/media-fx/media-fx-dom') return { vMediaFx }
    if (id === '@/features/media-fx/media-fx-gpu') return {
      mediaFxGpuSupported: () => control.gpuAvailable,
      mediaFxGpuMaxTextureSize: () => control.maxTextureSize,
      subscribeMediaFxGpuAvailability: (listener: (available: boolean) => void) => {
        notifyGpu = listener
        return () => { notifyGpu = null }
      },
    }
    if (id === '@/features/media-fx/media-fx-canvas') return {
      ...require('../src/features/media-fx/media-fx-canvas'),
      canvasFilterSupported: () => control.canvasFilter,
    }
    if (id === '@/features/media-fx/media-fx-live') return {
      ...require('../src/features/media-fx/media-fx-live'),
      createMediaFxLiveRenderer: (options: LiveRendererStub['options']) => {
        const live: LiveRendererStub & Record<string, unknown> = {
          options, updates: [], disposed: false,
          update(input: LiveRendererStub['updates'][number]) { live.updates.push(input) },
          dispose() { live.disposed = true },
        }
        liveRenderers.push(live)
        return live
      },
    }
    if (id === '@/features/media-fx/media-fx-temporal') return {
      createMediaFxTemporalPlayer: (options: TemporalPlayerStub['options']) => {
        const player: TemporalPlayerStub & Record<string, unknown> = {
          options, baselines: [], updates: [], live: false, disposed: false,
          setBaseline(baseline: TemporalPlayerStub['baselines'][number]) { player.baselines.push(baseline) },
          update(input: TemporalPlayerStub['updates'][number]) { player.updates.push(input) },
          dispose() { player.disposed = true },
        }
        temporalPlayers.push(player)
        return player
      },
      presentMediaFxTemporalFrame: () => true,
    }
    if (id === './TheaterPresentationMedia.vue') return mediaComponent
    if (id === './theaterPresentationMedia') return require('../src/components/theater-presentation/theaterPresentationMedia')
    if (id === './theaterMediaFxAdvanced') return {
      ...advancedModule,
      readTheaterMediaFit: () => control.fit,
      loadTheaterMediaFxSource: async (image: { attachmentId: string }) => {
        loads.push(image.attachmentId)
        const fail = control.failSource
        if (control.gate) await control.gate
        return fail ? null : { source: image.attachmentId, width: 400, height: 800 }
      },
      rasterizeTheaterMediaFx: (_source: unknown, job: TheaterMediaFxRasterJob) => {
        rasters.push(job)
        return control.failRaster ? null : { width: job.raster.width, height: job.raster.height }
      },
      createTheaterMediaFxAdvancedController: (deps: Parameters<typeof createTheaterMediaFxAdvancedController>[0]) => createTheaterMediaFxAdvancedController({
        ...deps,
        setTimer: callback => { timers.push(callback); return callback },
        clearTimer: handle => {
          const index = timers.indexOf(handle as () => void)
          if (index >= 0) timers.splice(index, 1)
        },
      }),
    }
    return require(id)
  }
  const compileComponent = (file: string) => {
    const filename = path.join(__dirname, '../src/components/theater-presentation', file)
    const { descriptor } = parse(fs.readFileSync(filename, 'utf8'))
    const compiled = compileScript(descriptor, { id: 'advanced-host-regression', inlineTemplate: true })
    const module = { exports: {} as { default: Component } }
    new Function('exports', 'require', 'module', ts.transpileModule(compiled.content, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText)(module.exports, localRequire, module)
    return module.exports
  }
  mediaComponent = compileComponent('TheaterPresentationMedia.vue')
  const visualComponent = compileComponent('TheaterMediaFxVisual.vue')
  const presentation = createDefaultTheaterPresentation()
  presentation.dialogue.frame = { ...frame, media: { ...still, fallbackAttachmentId: 'host-fallback' }, mediaFx: night() }
  const state = shallowRef(createTheaterPresentationEditorState({ mode: 'base', presentation }))
  const layer = () => state.value.draft.dialogue.frame!
  const dispatch = (command: Parameters<typeof dispatchTheaterEditorCommand>[1]) => {
    state.value = dispatchTheaterEditorCommand(state.value, command, { recordHistory: false })
  }
  const createApp = () => renderer.createApp({ render: () => h(visualComponent.default, { media: layer().media, mediaFx: layer().mediaFx, ...hostProps.value }) })
  let app = createApp()
  const originalDocument = globalThis.document
  const originalWindow = globalThis.window
  const originalHTMLElement = globalThis.HTMLElement
  globalThis.HTMLElement = ElementStub as unknown as typeof HTMLElement
  globalThis.document = { createElement: () => ({ canPlayType: () => 'probably', width: 0, height: 0, getContext: () => ({ drawImage: () => undefined }) }) } as unknown as Document
  globalThis.window = { devicePixelRatio: 1 } as unknown as Window & typeof globalThis
  const root = node('root')
  const image = () => root.children[0].children.find(child => child.tag === 'img')!
  const canvas = () => root.children[0].children.find(child => child.tag === 'canvas')!
  const originalHidden = () => (image().props.style as { visibility?: string } | undefined)?.visibility === 'hidden'
  const changeSource = (id: string) => dispatch({ type: 'set-media', target: { kind: 'dialogue-frame' }, media: { ...layer().media, resourceAttachmentId: id } })
  const loadImage = () => {
    const img = image()
    const element = { complete: true, naturalWidth: 400, naturalHeight: 800, currentSrc: img.props.src, dataset: { attachmentId: img.props['data-attachment-id'] } }
    ;(img.props.onLoad as (event: { target: unknown }) => void)({ target: element })
  }
  const flush = async () => {
    await nextTick()
    for (let round = 0; round < 10; round += 1) {
      const callback = timers.shift()
      if (!callback) break
      callback()
      await settle()
      await nextTick()
    }
  }
  try {
    app.mount(root)
    assert.equal(originalHidden(), false, 'basic-only layers display normally')
    loadImage()
    await flush()
    const initialImage = image()
    const initialMedia = layer().media
    dispatch({ type: 'set-media-fx', target: { kind: 'dialogue-frame' }, mediaFx: glitch() })
    await nextTick()
    assert.equal(originalHidden(), true, 'pending Advanced never flashes the basic-only image')
    assert.equal(canvas().style.display, 'none')
    await flush()
    assert.notEqual(layer().media, initialMedia, 'real editor dispatch replaces the media object')
    assert.equal(image(), initialImage, 'unchanged attachment reuses the image without another load')
    assert.equal(rasters.length, 1, 'enabling Advanced after an editor clone must rasterize the loaded image')
    assert.deepEqual(rasters[0].spec.advanced, glitch().advanced)
    assert.equal(canvas().style.display, '', 'successful output is visible')
    assert.equal((image().props.style as { visibility?: string }).visibility, 'hidden')

    // The overlay's async presentation replacement has the same new-object / same-ID shape.
    state.value = { ...state.value, draft: normalizeTheaterPresentation(JSON.parse(JSON.stringify(state.value.draft))) }
    await flush()
    assert.equal(image(), initialImage)
    assert.equal(rasters.length, 1, 'equivalent live presentation keeps the existing output')
    assert.equal(canvas().width, 300)
    assert.equal(canvas().style.display, '')

    dispatch({ type: 'set-media-fx', target: { kind: 'dialogue-frame' }, mediaFx: { ...glitch(), advanced: { ...glitch().advanced, edge: 0.8 } } })
    await nextTick()
    assert.equal(canvas().style.display, '', 'same-source edits retain the previous processed output while pending')
    await flush()
    assert.equal(rasters.length, 2, 'later slider edits still rasterize without a load event')
    assert.equal(rasters[1].spec.advanced.edge, 0.8)
    assert.equal(loads.length, 1, 'unchanged source retains its decoded pixels')

    dispatch({ type: 'set-media', target: { kind: 'dialogue-frame' }, media: { ...layer().media, resourceAttachmentId: 'host-new-primary' } })
    await flush()
    assert.notEqual(image(), initialImage)
    assert.equal(canvas().width, 0, 'actual primary change clears the previous output before loading')
    assert.equal(canvas().style.display, 'none')
    assert.equal(originalHidden(), true, 'a new primary waits without flashing its original')
    loadImage()
    await flush()
    assert.equal(rasters.at(-1)?.attachmentId, 'host-new-primary')

    ;(image().props.onError as () => void)()
    await nextTick()
    assert.equal(canvas().width, 0, 'candidate switch clears stale output before fallback load')
    assert.equal(originalHidden(), true, 'fallback loading also suppresses the unprocessed image')
    loadImage()
    await flush()
    const fallbackImage = image()
    const rasterCount = rasters.length
    assert.equal(rasters.at(-1)?.attachmentId, 'host-fallback')
    state.value = { ...state.value, draft: normalizeTheaterPresentation(JSON.parse(JSON.stringify(state.value.draft))) }
    await flush()
    assert.equal(image(), fallbackImage, 'equivalent presentation must retain the active fallback candidate')
    assert.equal(rasters.length, rasterCount)
    assert.equal(canvas().style.display, '')

    dispatch({ type: 'set-media', target: { kind: 'dialogue-frame' }, media: { ...layer().media, fallbackAttachmentId: 'host-new-fallback' } })
    await flush()
    assert.equal(canvas().width, 0, 'actual fallback change still invalidates the loaded source')
    assert.equal(canvas().style.display, 'none')
    assert.equal(image().props['data-attachment-id'], 'host-new-primary')
    assert.ok(presented.length >= 4)

    // Initial mount, including a long decode/proxy wait, must never expose original pixels.
    changeSource('host-first-appearance')
    await nextTick()
    app.unmount()
    app = createApp()
    app.mount(root)
    assert.equal(originalHidden(), true, 'first Advanced appearance is hidden before image load')
    let release!: () => void
    control.gate = new Promise(resolve => { release = resolve })
    loadImage()
    await flush()
    assert.equal(originalHidden(), true, 'slow source acquisition keeps original pixels hidden')
    assert.equal(canvas().style.display, 'none')
    control.gate = null
    release()
    await settle()
    await nextTick()
    assert.equal(canvas().style.display, '')
    assert.equal(originalHidden(), true)

    // Every terminal failure must reveal the fallback even before the first commit.
    for (const failure of ['source', 'raster', 'present', 'fit', 'texture'] as const) {
      control.failSource = failure === 'source'
      control.failRaster = failure === 'raster'
      control.failPresent = failure === 'present'
      control.fit = failure === 'fit' ? null : 'cover'
      control.maxTextureSize = failure === 'texture' ? null : 4096
      changeSource(`host-failure-${failure}`)
      await nextTick()
      assert.equal(originalHidden(), true, `${failure}: a new source starts hidden`)
      loadImage()
      await flush()
      assert.equal(originalHidden(), false, `${failure}: processing failure reveals the DOM fallback`)
      assert.equal(canvas().style.display, 'none')
      if (failure === 'source') {
        const loadCount = loads.length
        app.unmount()
        app = createApp()
        app.mount(root)
        loadImage()
        await flush()
        assert.equal(loads.length, loadCount, 'a source in cooldown is not fetched again')
        assert.equal(originalHidden(), false, 'cooldown remount reveals fallback instead of staying hidden')
      }
    }
    control.failPresent = false
    control.maxTextureSize = 4096

    changeSource('host-retry-raster')
    control.failRaster = true
    await nextTick()
    loadImage()
    await flush()
    assert.equal(originalHidden(), false)
    dispatch({ type: 'set-media-fx', target: { kind: 'dialogue-frame' }, mediaFx: glitch() })
    await nextTick()
    assert.equal(originalHidden(), false, 'retrying a failed source does not blink the visible fallback')
    control.failRaster = false
    await flush()
    assert.equal(canvas().style.display, '', 'a later successful pass replaces the fallback')

    notifyGpu!(false)
    await nextTick()
    assert.equal(originalHidden(), false, 'GPU availability loss reveals the DOM fallback')
    assert.equal(canvas(), undefined)
    notifyGpu!(true)
    await nextTick()
    assert.equal(originalHidden(), true, 'GPU recovery waits for processed output')
    await flush()
    assert.equal(canvas().style.display, '')

    // Failure from a replaced source must not reveal the new source's original pixels.
    let releaseOld!: () => void
    let releaseNew!: () => void
    control.gate = new Promise(resolve => { releaseOld = resolve })
    control.failSource = true
    changeSource('host-stale-failure')
    await nextTick()
    loadImage()
    await flush()
    control.failSource = false
    control.gate = new Promise(resolve => { releaseNew = resolve })
    changeSource('host-current-pending')
    await nextTick()
    loadImage()
    await flush()
    releaseOld()
    await settle()
    await nextTick()
    assert.equal(originalHidden(), true, 'stale failure cannot expose the current pending image')
    assert.equal(canvas().style.display, 'none')
    control.gate = null
    releaseNew()
    await settle()
    await nextTick()
    assert.equal(canvas().style.display, '')

    dispatch({ type: 'set-media-fx', target: { kind: 'dialogue-frame' }, mediaFx: night() })
    await flush()
    assert.equal(originalHidden(), false, 'turning Advanced off restores the basic DOM path')
    assert.equal(canvas(), undefined)

    // --- V3.5 Temporal over the static baseline ---------------------------------------
    const player = temporalPlayers.at(-1)!
    assert.ok(player.updates.every(update => !update.active), 'without temporal content the player never runs')
    let temporalRasters = rasters.length
    dispatch({ type: 'set-media-fx', target: { kind: 'dialogue-frame' }, mediaFx: rolling() })
    await nextTick()
    assert.equal(originalHidden(), true, 'temporal-only waits for its static baseline instead of flashing')
    await flush()
    assert.equal(rasters.length, temporalRasters + 1, 'temporal-only rasterizes the basic look once as the baseline')
    assert.deepEqual(rasters.at(-1)!.spec.temporal, createDefaultMediaFxSpec().temporal, 'temporal never reaches the static raster')
    assert.deepEqual(rasters.at(-1)!.spec.filter, night().filter, 'basic filter is baked into the baseline')
    assert.equal(canvas().style.display, '', 'the baseline is shown')
    const baseline = player.baselines.at(-1)!
    assert.ok(baseline && baseline.width === 300 && baseline.pixelRatio === 1, 'the presented output becomes the baseline')
    assert.equal(player.updates.at(-1)!.active, true, 'the player runs once the baseline is ready')
    assert.equal(player.updates.at(-1)!.temporal.scanlineRoll, 0.5)

    temporalRasters = rasters.length
    const baselineCount = player.baselines.length
    dispatch({ type: 'set-media-fx', target: { kind: 'dialogue-frame' }, mediaFx: rolling({ glitch: 0.3 }) })
    await flush()
    assert.equal(rasters.length, temporalRasters, 'temporal edits never re-raster')
    assert.equal(player.baselines.length, baselineCount, 'temporal edits keep the uploaded baseline')
    assert.equal(player.updates.at(-1)!.temporal.glitch, 0.3)
    assert.equal(player.updates.at(-1)!.active, true)

    // A live failure (or stop) repaints the static baseline; the visual never disappears.
    const presentedBefore = presented.length
    player.options.onLiveChange?.(false)
    assert.equal(presented.at(-1), baseline.source, 'live stop repaints the baseline')
    assert.ok(presented.length > presentedBefore)
    assert.equal(canvas().style.display, '')
    assert.equal(originalHidden(), true)

    // Static edits invalidate the baseline; a new output replaces it.
    dispatch({ type: 'set-media-fx', target: { kind: 'dialogue-frame' }, mediaFx: { ...rolling({ glitch: 0.3 }), advanced: glitch().advanced } })
    await flush()
    assert.equal(rasters.length, temporalRasters + 1, 'advanced change rebuilds the baseline once')
    assert.notEqual(player.baselines.at(-1), baseline, 'a new static output is a new baseline')

    // Reduced motion: temporal stops, the static look stays (advanced keeps its output).
    hostProps.value = { reducedMotion: true }
    await flush()
    assert.equal(player.updates.at(-1)!.active, false, 'reduced motion stops the live tick')
    assert.equal(canvas().style.display, '', 'advanced output stays under reduced motion')
    dispatch({ type: 'set-media-fx', target: { kind: 'dialogue-frame' }, mediaFx: rolling() })
    await flush()
    assert.equal(canvas(), undefined, 'temporal-only under reduced motion keeps the plain DOM path')
    assert.equal(originalHidden(), false)
    hostProps.value = { active: false }
    await flush()
    assert.equal(player.updates.at(-1)!.active, false, 'an inactive layer does no live work')
    hostProps.value = {}
    await flush()
    assert.equal(player.updates.at(-1)!.active, true)

    // --- V3.6 Bloom / glow: static raster content, the temporal baseline ----------------
    const lit = (advancedPatch: Record<string, number>, temporalPatch: Record<string, number> = {}) => ({
      ...rolling(temporalPatch),
      advanced: { ...createDefaultMediaFxSpec().advanced, ...advancedPatch },
    })
    const lightRasters = rasters.length
    const lightBaselines = player.baselines.length
    dispatch({ type: 'set-media-fx', target: { kind: 'dialogue-frame' }, mediaFx: lit({ bloom: 0.6 }) })
    await nextTick()
    assert.equal(originalHidden(), true, 'a pending bloom raster never flashes the unprocessed image')
    await flush()
    assert.equal(rasters.length, lightRasters + 1, 'a bloom edit re-rasterizes once')
    assert.equal(rasters.at(-1)!.spec.advanced.bloom, 0.6, 'bloom reaches the shared static raster job')
    assert.deepEqual(rasters.at(-1)!.spec.temporal, createDefaultMediaFxSpec().temporal, 'temporal never reaches the bloom raster')
    assert.equal(player.baselines.length, lightBaselines + 1, 'the bloom output becomes the new temporal baseline')
    assert.equal(player.updates.at(-1)!.active, true, 'temporal resumes over the bloom baseline')
    dispatch({ type: 'set-media-fx', target: { kind: 'dialogue-frame' }, mediaFx: lit({ bloom: 0.6 }, { glitch: 0.7, speed: 2 }) })
    await flush()
    assert.equal(rasters.length, lightRasters + 1, 'temporal edits never re-raster bloom')
    assert.equal(player.baselines.length, lightBaselines + 1, 'temporal edits keep the bloom baseline')
    assert.equal(player.updates.at(-1)!.temporal.glitch, 0.7)
    dispatch({ type: 'set-media-fx', target: { kind: 'dialogue-frame' }, mediaFx: lit({ bloom: 0.6, glow: 0.3 }, { glitch: 0.7, speed: 2 }) })
    await flush()
    assert.equal(rasters.length, lightRasters + 2, 'a glow edit re-rasterizes once')
    assert.equal(rasters.at(-1)!.spec.advanced.glow, 0.3, 'the static signature includes glow')
    assert.equal(player.baselines.length, lightBaselines + 2)
    const glowOnly = { ...night(), advanced: { ...createDefaultMediaFxSpec().advanced, glow: 0.4 } }
    dispatch({ type: 'set-media-fx', target: { kind: 'dialogue-frame' }, mediaFx: glowOnly })
    await flush()
    assert.equal(canvas().style.display, '', 'static glow alone uses the processed output')
    assert.equal(rasters.at(-1)!.spec.advanced.glow, 0.4)
    assert.deepEqual([rasters.at(-1)!.raster.width, rasters.at(-1)!.raster.height], [300, 150], 'glow never changes the raster / layer geometry')
    control.failRaster = true
    dispatch({ type: 'set-media-fx', target: { kind: 'dialogue-frame' }, mediaFx: { ...glowOnly, advanced: { ...glowOnly.advanced, bloom: 0.9 } } })
    await flush()
    assert.equal(originalHidden(), false, 'a failed bloom / glow raster reveals the DOM fallback, never an empty layer')
    assert.equal(canvas().style.display, 'none')
    control.failRaster = false
    // A slow load of an old source with bloom never replaces the current source's output.
    let releaseLightOld!: () => void
    control.gate = new Promise(resolve => { releaseLightOld = resolve })
    changeSource('host-light-old')
    await nextTick()
    loadImage()
    await flush()
    control.gate = null
    changeSource('host-light-current')
    await nextTick()
    assert.equal(originalHidden(), true, 'the current bloom source waits hidden')
    loadImage()
    await flush()
    releaseLightOld()
    await settle()
    await nextTick()
    assert.equal(rasters.at(-1)!.attachmentId, 'host-light-current', 'the stale bloom job never commits over the new source')
    assert.equal(canvas().style.display, '')

    // Motion + all seven Basic Filters use the real directive on the original media.
    // Stored GPU effects on animated media must never hide it or schedule a raster.
    const dynamicFx = {
      ...lit({ bloom: 0.6, glow: 0.3 }),
      motion: { preset: 'breathe' as const, intensity: 0.5, durationMs: 4000, loop: true },
      filter: { brightness: 0.7, contrast: 1.2, saturation: 0.5, grayscale: 0.2, sepia: 0.3, hueRotate: 45, blurPx: 1.5 },
    }
    const css = 'brightness(0.7) contrast(1.2) saturate(0.5) grayscale(0.2) sepia(0.3) hue-rotate(45deg) blur(1.5px)'
    const host = root.children[0]
    const dynamicRasterCount = rasters.length
    const dynamicLoadCount = loads.length
    const setFx = (mediaFx: unknown) => dispatch({ type: 'set-media-fx', target: { kind: 'dialogue-frame' }, mediaFx })
    for (const [kind, mimeType] of [
      ['static_image', 'image/png'], ['static_image', 'image/webp'],
      ['animated_image', 'image/webp'],
      ['video', 'video/webm'],
    ] as const) {
      const dynamic = kind !== 'static_image'
      dispatch({ type: 'set-media', target: { kind: 'dialogue-frame' }, media: {
        ...still, kind, mimeType, resourceAttachmentId: `host-${mimeType}`, fallbackAttachmentId: 'host-dynamic-fallback',
      } })
      setFx(dynamic ? dynamicFx : { ...dynamicFx, advanced: night().advanced, temporal: night().temporal })
      await flush()
      const element = root.children[0].children.find(child => child.tag === (kind === 'video' ? 'video' : 'img'))!
      if (kind === 'video') (element.props.onLoadeddata as () => void)()
      else loadImage()
      await flush()
      assert.equal(canvas() !== undefined, kind === 'video', `${mimeType}: only a loaded WebM video gets a (live) output canvas`)
      assert.notEqual((element.props.style as { visibility?: string })?.visibility, 'hidden')
      const liveRenderer = liveRenderers.at(-1)!
      const lastLive = () => liveRenderer.updates.at(-1)!
      if (kind === 'video') {
        // Phase 2: the loaded video is the live renderer's input; it stays visible with its
        // CSS basic filter until the first processed frame is presented.
        assert.equal(canvas().style.display, 'none', 'live output stays hidden before its first frame')
        assert.equal(toRaw(lastLive().video), element)
        assert.equal(lastLive().active, true)
        assert.ok(lastLive().advanced, 'video gets live advanced')
        assert.ok(lastLive().stageKey.includes(css), 'Basic is staged before advanced')
        liveRenderer.options.onLiveChange(true)
        await flush()
        assert.equal((element.props.style as { visibility?: string }).visibility, 'hidden', 'live output replaces the video')
        assert.equal((element.props.style as { filter?: string }).filter, undefined, 'basic is not applied twice while live')
        assert.equal(canvas().style.display, '')
        assert.equal(host.animations.at(-1)!.cancelled, false, 'Motion stays on the wrapper around the live output')
        liveRenderer.options.onLiveChange(false)
        await flush()
        assert.notEqual((element.props.style as { visibility?: string })?.visibility, 'hidden', 'a failed live run shows the video again')
        assert.equal((element.props.style as { filter?: string })?.filter, css, 'fallback keeps the CSS basic filter')
        control.canvasFilter = false
        setFx({ ...dynamicFx })
        await flush()
        assert.equal(lastLive().video, null, 'Basic that cannot be staged keeps the whole live path off')
        assert.equal(canvas(), undefined)
        control.canvasFilter = true
        setFx(dynamicFx)
        await flush()
        assert.equal(toRaw(lastLive().video), element)
        notifyGpu!(false)
        await flush()
        assert.equal(lastLive().video, null, 'losing the GPU falls back to the original video')
        assert.equal((element.props.style as { filter?: string })?.filter, css)
        notifyGpu!(true)
        await flush()
        assert.equal(toRaw(lastLive().video), element)
      } else {
        assert.ok(liveRenderer.updates.every(update => update.video === null), `${mimeType}: no live input`)
      }
      if (dynamic) {
        assert.equal(host.style.filter, '', `${mimeType}: dynamic filters stay off the motion wrapper`)
        assert.equal((element.props.style as { filter?: string })?.filter, css, `${mimeType}: every Basic Filter reaches the live media element`)
      } else {
        assert.equal(host.style.filter, css, `${mimeType}: static Basic Filters keep the wrapper path`)
      }
      const animation = host.animations.at(-1)!
      assert.equal(animation.cancelled, false, `${mimeType}: Motion plays alongside filters`)
      const animationCount = host.animations.length
      element.currentTime = 12.5
      const playback = () => [element.currentTime, element.playCalls, element.pauseCalls, element.playbackRate, element.defaultPlaybackRate, element.sourceWrites]
      const beforeEdits = playback()
      const edit = { ...dynamicFx, filter: { ...dynamicFx.filter, brightness: 1.4 }, advanced: dynamic ? dynamicFx.advanced : night().advanced, temporal: dynamic ? dynamicFx.temporal : night().temporal }
      setFx(edit)
      await flush()
      if (dynamic) {
        assert.equal(host.style.filter, '')
        assert.equal((element.props.style as { filter?: string })?.filter, mediaFxFilterToCss(edit.filter))
      } else {
        assert.equal(host.style.filter, mediaFxFilterToCss(edit.filter))
      }
      assert.equal(root.children[0].children.includes(element), true, 'filter edits reuse the media node')
      assert.deepEqual(playback(), beforeEdits, 'filter edits never reload, seek, play or pause media')
      setFx({ ...edit, filter: createDefaultMediaFxSpec().filter })
      await flush()
      assert.equal(host.style.filter, '', 'clearing only the filter removes stale wrapper CSS')
      if (dynamic) assert.equal((element.props.style as { filter?: string })?.filter, undefined, 'clearing removes direct media CSS')
      assert.equal(host.animations.length, animationCount, 'filter changes preserve the Motion clock')
      assert.equal(animation.cancelled, false)
      assert.deepEqual(playback(), beforeEdits)

      setFx(edit)
      hostProps.value = { reducedMotion: true }
      await flush()
      assert.equal(animation.cancelled, true, 'reduced motion stops only Motion')
      if (kind === 'video') assert.equal(lastLive().temporal, null, 'reduced motion stops live temporal')
      if (dynamic) assert.equal((element.props.style as { filter?: string })?.filter, mediaFxFilterToCss(edit.filter), 'reduced motion keeps direct Basic Filters')
      else assert.equal(host.style.filter, mediaFxFilterToCss(edit.filter), 'reduced motion keeps Basic Filters')
      assert.deepEqual(playback(), beforeEdits)
      hostProps.value = {}
      await flush()

      if (kind === 'video') {
        hostProps.value = { active: false, playbackRate: 1.5 }
        await flush()
        assert.equal(lastLive().active, false, 'inactive visuals stop live work')
        assert.equal(element.pauseCalls, beforeEdits[2] + 1, 'existing active control pauses the video')
        assert.equal(element.playbackRate, 1.5)
        assert.equal(element.defaultPlaybackRate, 1.5)
        const paused = playback()
        setFx({ ...edit, filter: { ...edit.filter, contrast: 0.8 } })
        await flush()
        assert.deepEqual(playback(), paused, 'filter edits keep paused video and its rate / time')
        setFx(edit)
        hostProps.value = {}
        await flush()
        assert.equal(element.playCalls, paused[1] + 1, 'existing active control resumes the video')
        assert.equal(element.currentTime, paused[0])
      }

      if (dynamic) {
        ;(element.props.onError as () => void)()
        await flush()
        loadImage()
        await flush()
        assert.equal(image().props['data-attachment-id'], 'host-dynamic-fallback')
        assert.equal((image().props.style as { filter?: string })?.filter, mediaFxFilterToCss(edit.filter), 'fallback retains the current basic look')
        assert.equal(originalHidden(), false, 'animated fallback never enters Advanced')
        assert.equal(canvas(), undefined)
      }
      for (const empty of [null, createDefaultMediaFxSpec()]) {
        if (empty === null) changeSource(`host-switched-${mimeType}`)
        setFx(empty)
        await flush()
        assert.equal(host.style.filter, '', 'empty / default FX clears the previous source look')
        assert.ok(host.animations.every(animation => animation.cancelled), 'empty / default FX has no running Motion')
        assert.equal(temporalPlayers.at(-1)!.updates.at(-1)!.active, false)
        assert.equal(timers.length, 0, 'empty / default FX schedules no raster work')
        assert.equal(canvas(), undefined)
        assert.equal(lastLive().video, null, 'empty FX / source replacement leaves no live input')
      }
    }
    assert.equal(rasters.length, dynamicRasterCount, 'dynamic / basic-only media never rasterize')
    assert.equal(loads.length, dynamicLoadCount, 'dynamic media never decode a static GPU source')
    app.unmount()
    assert.equal(host.style.filter, '', 'unmount clears the directive style')
    assert.equal(player.disposed, true, 'unmount disposes the player')
    app = createApp()
    app.mount(root)
  } finally {
    app.unmount()
    globalThis.document = originalDocument
    globalThis.window = originalWindow
    globalThis.HTMLElement = originalHTMLElement
  }
}
