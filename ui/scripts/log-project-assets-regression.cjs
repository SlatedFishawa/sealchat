// LOG 图片素材引用回归：node scripts/log-project-assets-regression.cjs
// 覆盖引用语义（样式资源 vs 工程素材）、插入元素、样式切换兼容与设计态资源令牌。
// logRenderer 使用真实实现；它依赖的正文/模板/字体模块与本回归无关，替换为空模块。
const path = require('node:path')
const fs = require('node:fs')
const Module = require('node:module')
const assert = require('node:assert/strict')
const ts = require('typescript')

const src = path.join(__dirname, '../src')
const stubs = {
  './logContent': {},
  './logTemplateCompiler': {},
  './logFontPlan': {},
}
const original = Module._resolveFilename
Module._resolveFilename = function (request, parent, ...args) {
  if (request in stubs) return `stub:${request}`
  if (request.startsWith('@/')) request = path.join(src, request.slice(2))
  return original.call(this, request, parent, ...args)
}
for (const [name, exports] of Object.entries(stubs)) {
  Module._cache[`stub:${name}`] = { id: name, filename: name, loaded: true, exports }
}
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText, filename)

const refs = require(path.join(src, 'views/log/logAssetRefs.ts'))
const ops = require(path.join(src, 'views/log/logDraftOps.ts'))
const renderer = require(path.join(src, 'services/log/logRenderer.ts'))

const A = '00000000-0000-4000-8000-0000000000a1'
const B = '00000000-0000-4000-8000-0000000000b1'
const templates = { cover: '<section></section>', imagePlate: '<figure></figure>', heading: '<h2></h2>', body: '<div></div>' }
const pkg = (id, assets = []) => ({ id, version: '1.0.0', name: id, templates, settingsSchema: {}, tokens: {}, rules: [], css: '', assets })
const noImages = pkg('plain')
const withImage = pkg('pictures', [{ id: 'bg', path: 'assets/bg.png', mime: 'image/png', sha256: '' }])
const page = () => ({ preset: 'a5', widthMm: 148, heightMm: 210, marginsMm: { top: 15, right: 15, bottom: 15, left: 15 }, gutterMm: 0, columns: 1, backgroundColor: '#ffffff', backgroundAssetId: null, fontFamily: 'sans-serif', fontSizePt: 12, lineHeight: 1.5, headerTemplateId: null, footerTemplateId: null, showPageNumbers: true, mergeNeighbors: true })
const draft = (extra = {}) => ({ schemaVersion: 1, title: 'LOG', sections: [], elements: [], page: page(), stylePackageId: 'pictures', stylePackageVersion: '1.0.0', themeTokens: {}, ...extra })
const anchor = { kind: 'sectionStart', sectionId: 's1' }

// ---- 旧协议：assetId / backgroundAssetId 仍是样式资源 ----
assert.deepEqual(refs.elementImageRef({ assetId: 'bg' }), { source: 'style', id: 'bg' })
assert.deepEqual(refs.elementImageRef({ projectAssetId: A }), { source: 'project', id: A })
assert.equal(refs.elementImageRef({ title: 'x' }), null)
const legacyPage = { ...page(), backgroundAssetId: 'bg' }
assert.deepEqual(refs.pageBackgroundRef(legacyPage), { source: 'style', id: 'bg' })
assert.equal(renderer.designBackgroundToken(legacyPage), 'style:bg')
assert.equal(renderer.designElementAssetToken({ assetId: 'bg' }), 'style:bg')
assert.equal(renderer.designElementAssetToken({ projectAssetId: A }), `proj:${A}`)
// 工程素材 id 只接受 UUID；不会把附件 id 或 URL 交给 iframe。
assert.equal(renderer.designElementAssetToken({ projectAssetId: 'https://evil.example/x.png' }), null)
assert.equal(renderer.designBackgroundToken({ ...page(), backgroundProjectAssetId: 'att-123' }), null)

// ---- 写入：同一位置最多一个来源 ----
const content = { assetId: 'bg', caption: '' }
refs.setElementImageRef(content, { source: 'project', id: A })
assert.deepEqual(content, { caption: '', projectAssetId: A })
refs.setElementImageRef(content, { source: 'style', id: 'bg' })
assert.deepEqual(content, { caption: '', assetId: 'bg' })
refs.setElementImageRef(content, null)
assert.deepEqual(content, { caption: '' })
const bgPage = page()
refs.setPageBackgroundRef(bgPage, { source: 'project', id: A })
assert.equal(bgPage.backgroundAssetId, null)
assert.equal(bgPage.backgroundProjectAssetId, A)
assert.equal(renderer.designBackgroundToken(bgPage), `proj:${A}`)
refs.setPageBackgroundRef(bgPage, { source: 'style', id: 'bg' })
assert.equal(bgPage.backgroundAssetId, 'bg')
assert.ok(!('backgroundProjectAssetId' in bgPage), 'switching to a style background drops the project field')
refs.setPageBackgroundRef(bgPage, null)
assert.equal(bgPage.backgroundAssetId, null)

// ---- 插入：插图页可用性只看模板；必须带图片，封面图片可选 ----
assert.deepEqual(ops.elementAvailability('imagePlate', noImages), { templateId: 'imagePlate', reason: '' })
assert.equal(ops.elementAvailability('imagePlate', { ...noImages, templates: { cover: '' } }).templateId, null)
const d0 = draft({ stylePackageId: 'plain' })
assert.equal(ops.createElement(d0, 'imagePlate', anchor, noImages), null, 'image plate needs an image')
const plate = ops.createElement(d0, 'imagePlate', anchor, noImages, { source: 'project', id: A })
assert.deepEqual(plate.content, { caption: '', fit: 'contain', projectAssetId: A })
assert.equal(renderer.designElementToNode(plate).assetToken, `proj:${A}`)
const bareCover = ops.createElement(d0, 'cover', anchor, noImages)
assert.deepEqual(bareCover.content, { title: '标题', subtitle: '' })
const cover = ops.createElement(d0, 'cover', anchor, withImage, { source: 'style', id: 'bg' })
assert.equal(cover.content.assetId, 'bg')
const heading = ops.createElement(d0, 'heading', anchor, noImages, { source: 'project', id: A })
assert.ok(!('projectAssetId' in heading.content), 'non-image elements ignore images')

// ---- 引用统计与移除：被引用的登记不能静默移除 ----
const used = draft({
  assets: [{ id: A, attachmentId: 'att-a', name: 'a' }, { id: B, attachmentId: 'att-b', name: 'b' }],
  page: { ...page(), backgroundProjectAssetId: A },
  elements: [
    { ...plate, id: 'e1' },
    { ...plate, id: 'e2', content: { caption: '', fit: 'cover', projectAssetId: A } },
    { ...cover, id: 'e3' },
  ],
})
const usages = refs.imageUsages(used, 'project')
assert.equal(usages.get(A).length, 3)
assert.deepEqual(usages.get(A).map((u) => u.kind), ['background', 'element', 'element'])
assert.equal(usages.has(B), false)
assert.equal(refs.imageUsages(used, 'style').get('bg').length, 1)
const working = ops.cloneJson(used)
assert.equal(refs.removeProjectAsset(working, A), false)
assert.equal(working.assets.length, 2)
assert.equal(refs.removeProjectAsset(working, B), true)
assert.deepEqual(working.assets.map((a) => a.id), [A])
working.page.backgroundProjectAssetId = undefined
working.elements = []
assert.equal(refs.removeProjectAsset(working, A), true)
assert.ok(!('assets' in working), 'empty registry is dropped')

// ---- 样式切换：工程素材原样保留，样式资源按旧规则检查 ----
const mixed = draft({
  assets: [{ id: A, attachmentId: 'att-a', name: 'a' }],
  page: { ...page(), backgroundProjectAssetId: A },
  elements: [
    { id: 'p1', type: 'imagePlate', anchor, order: 0, templateId: 'imagePlate', content: { caption: '', fit: 'contain', projectAssetId: A }, style: {} },
    { id: 'c1', type: 'cover', anchor, order: 1, templateId: 'cover', content: { title: 't', subtitle: '', projectAssetId: A }, style: {} },
  ],
})
const switched = ops.rebindStyle(mixed, noImages)
assert.deepEqual(switched.problems, [], 'project references raise no style problems')
assert.deepEqual(switched.next.assets, mixed.assets)
assert.equal(switched.next.page.backgroundProjectAssetId, A)
assert.deepEqual(switched.next.elements.map((e) => e.content.projectAssetId), [A, A])
assert.equal(switched.next.stylePackageId, 'plain')

const styleRefs = draft({
  page: { ...page(), backgroundAssetId: 'bg' },
  elements: [
    { id: 'p1', type: 'imagePlate', anchor, order: 0, templateId: 'imagePlate', content: { caption: '', fit: 'contain', assetId: 'bg' }, style: {} },
    { id: 'c1', type: 'cover', anchor, order: 1, templateId: 'cover', content: { title: 't', subtitle: '', assetId: 'bg' }, style: {} },
  ],
})
const strict = ops.rebindStyle(styleRefs, noImages)
assert.ok(strict.problems.some((p) => p.id === 'p1' && !p.fixable), 'style-only image plate still blocks without replacement')
assert.ok(strict.problems.some((p) => p.id === 'c1' && p.fixable))
assert.ok(strict.problems.some((p) => p.kind === 'background' && p.fixable))
assert.equal(strict.next.page.backgroundAssetId, null)
const kept = ops.rebindStyle(styleRefs, { ...withImage, id: 'other' })
assert.deepEqual(kept.problems, [], 'same style asset id in the new package stays valid')

assert.equal(refs.projectAssetNameFromFile('  旅途\u0007插图.final.webp'), '旅途 插图.final')
assert.equal(refs.projectAssetNameFromFile('.png'), '图片')

console.log('log project asset regression: ok')
