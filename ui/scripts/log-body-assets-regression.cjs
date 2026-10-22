// node scripts/log-body-assets-regression.cjs
// 验证真实正文令牌转换和外层资源分发；最小 DOM 仅承载 img 属性操作，
// 不替代浏览器对 DOMPurify 的安全验证，也不引入新的测试框架。
const path = require('node:path')
const fs = require('node:fs')
const Module = require('node:module')
const assert = require('node:assert/strict')
const ts = require('typescript')
const src = path.join(__dirname, '../src')
const authRequests = []
const publicRequests = []
const cleanups = []
const escape = (s) => String(s).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')

const fragment = (html) => {
  const images = []
  const markup = html.replace(/<img\b[^>]*>/gi, (tag) => {
    const attrs = new Map(Array.from(tag.matchAll(/([\w-]+)="([^"]*)"/g), (m) => [m[1], m[2]]))
    const img = {
      getAttribute: (k) => attrs.get(k) ?? null,
      removeAttribute: (k) => attrs.delete(k),
      setAttribute: (k, v) => attrs.set(k, v),
      replaceWith: (el) => { img.replacement = el },
      html: () => img.replacement ? `<span class="${img.replacement.className}">${escape(img.replacement.textContent)}</span>`
        : `<img ${Array.from(attrs, ([k, v]) => `${k}="${escape(v)}"`).join(' ')}>`,
    }
    images.push(img)
    return `__IMAGE_${images.length - 1}__`
  })
  return {
    querySelectorAll: (selector) => selector === 'img' ? images : [],
    html: () => markup.replace(/__IMAGE_(\d+)__/g, (_, i) => images[Number(i)].html()),
  }
}
globalThis.document = {
  createElement: () => ({ className: '', textContent: '', innerHTML: '', appendChild(frag) { this.innerHTML = frag.html() } }),
}
const response = { data: new Uint8Array([1, 2, 3]).buffer, headers: { 'content-type': 'image/png' } }
const stubs = {
  dompurify: { sanitize: (html) => fragment(html) },
  '@satorijs/element': {},
  '@/composables/useAttachmentResolver': { normalizeAttachmentId: (s) => s.replace(/^id:/, '').replace(/^\/api\/v1\/attachment\//, '') },
  '@/utils/plainQuickFormat': {},
  '@/utils/tiptap-render': {},
  '@/utils/tools': { contentEscape: escape },
  '@/utils/uploadTimeout': { getUploadTimeoutMs: () => 30000 },
  '@/stores/_config': { urlBase: '', api: { get: async (url, options) => { authRequests.push({ url, options }); return response } } },
  axios: { create: () => ({ get: async (url, options) => { publicRequests.push({ url, options }); return response } }), isAxiosError: () => false },
  vue: { onBeforeUnmount: (fn) => cleanups.push(fn) },
}
const originalResolve = Module._resolveFilename
Module._resolveFilename = function (request, parent, ...args) {
  if (Object.hasOwn(stubs, request)) return `__log_asset_stub_${request}`
  if (request.startsWith('@/')) request = path.join(src, request.slice(2))
  return originalResolve.call(this, request, parent, ...args)
}
for (const [name, exports] of Object.entries(stubs)) {
  const id = `__log_asset_stub_${name}`
  Module._cache[id] = { id, filename: id, loaded: true, exports }
}
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText, filename)

const { renderPresentedBody, bodyAssetToken } = require(path.join(src, 'services/log/logContent.ts'))
const { fetchLogBodyAssetBytes } = require(path.join(src, 'services/log/logApi.ts'))
const { useLogAssets } = require(path.join(src, 'views/log/composables/useLogAssets.ts'))
const context = `section/message/${'a'.repeat(32)}`
const token = `body:${context}`
const other = `body:section/message/${'b'.repeat(32)}`
const templateCompilerSource = fs.readFileSync(path.join(src, 'services/log/logTemplateCompiler.ts'), 'utf8')
const frameCss = fs.readFileSync(path.join(src, 'services/log/pagination/logFrame.css'), 'utf8')

const body = renderPresentedBody(`<p>images</p><img src="/__log_body_asset/${context}" srcset="https://evil.invalid/a.png 2x"><img src="/__log_body_asset/section/message/${'b'.repeat(32)}"><img src="/api/v1/attachment/ordinary-image"><img src="https://evil.invalid/a.png"><img src="/api/v1/worlds/w/clues/c/image"><img src="data:image/png;base64,AAAA">`, 'images')
assert.deepEqual(body.assets, [token, other, 'att:ordinary-image'])
assert.ok(body.html.includes(`data-log-asset="${token}"`))
assert.ok(!/\bsrc(?:set)?=/.test(body.html), '正文送入 FrameDocument 前必须移除所有图片 src/srcset')
assert.ok(!body.html.includes('evil.invalid'))
assert.ok(!body.html.includes('/api/v1/worlds/'))
assert.ok(body.html.includes('外链图片未嵌入'))
assert.equal(bodyAssetToken('../attachment/id'), '')
assert.equal(bodyAssetToken('section/message/attachment-id'), '')
assert.equal(bodyAssetToken(`47c49d8c-5c72-4a71-ab3d-9f38efd37811/djZbxBWoyEdQChnW/${'c'.repeat(32)}`), `body:47c49d8c-5c72-4a71-ab3d-9f38efd37811/djZbxBWoyEdQChnW/${'c'.repeat(32)}`)
assert.match(templateCompilerSource, /ADD_URI_SAFE_ATTR:\s*\[\s*['\"]data-log-asset['\"]\s*\]/, '模板正文二次清洗必须保留 data-log-asset 的非 http 资源令牌')
assert.match(frameCss, /\.log-body\s*\{[^}]*font-family:\s*var\(--log-font-family\)/, '页面字体必须直接作用于消息正文，不能只依赖消息外壳继承')

;(async () => {
  const assets = useLogAssets({ projectId: () => 'project', stylePackage: () => ({ id: 'style', version: '1.0.0' }), publicSlug: () => 'publicslug' })
  const tokens = [token, other, 'att:ordinary-image', 'style:paper', `pub:${'c'.repeat(32)}`]
  const result = await assets.ensure(tokens)
  assert.ok(result.every((a) => a.data instanceof ArrayBuffer && a.mime === 'image/png'))
  assert.deepEqual(authRequests.map((r) => r.url), [
    `api/v1/log/projects/project/sections/section/messages/message/assets/${'a'.repeat(32)}`,
    `api/v1/log/projects/project/sections/section/messages/message/assets/${'b'.repeat(32)}`,
    'api/v1/attachment/ordinary-image?proxy=1',
    'api/v1/log/styles/style/versions/1.0.0/assets/paper',
  ])
  assert.equal(publicRequests[0].url, `api/v1/public/log/publicslug/assets/${'c'.repeat(32)}`)
  assert.ok(authRequests.every((r) => r.options.responseType === 'arraybuffer' && r.options.signal instanceof AbortSignal))
  await assets.ensure(tokens)
  assert.equal(authRequests.length, 4, '重复资源应复用已取字节')
  await assert.rejects(fetchLogBodyAssetBytes('project', '../message/id'))
  assert.equal(authRequests.length, 4, '无效上下文不得触发业务 API')
  const missing = await assets.ensure(['body:section/message/not-a-key', 'https://evil.invalid/image.png'])
  assert.ok(missing.every((a) => a.data === null))
  cleanups.forEach((fn) => fn())
  assert.ok(authRequests.every((r) => r.options.signal.aborted))
  console.log('log body assets regression: ok')
})().catch((err) => { console.error(err); process.exitCode = 1 })
