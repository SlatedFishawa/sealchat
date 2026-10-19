// LOG 消息语义投影回归：node scripts/log-message-presentation-regression.cjs
// 覆盖悄悄话收件人、引用、嵌入展开在设计态/发布态节点上的一致性与合并规则。
// 正文渲染依赖 DOM（DOMPurify），这里替换为直通模块，只验证语义字段的流转。
const path = require('node:path')
const fs = require('node:fs')
const Module = require('node:module')
const assert = require('node:assert/strict')
const ts = require('typescript')

const src = path.join(__dirname, '../src')
const contentStub = path.join(__dirname, '__log-content-stub.cjs')
const compilerStub = path.join(__dirname, '__log-template-compiler-stub.cjs')
const original = Module._resolveFilename
Module._resolveFilename = function (request, parent, ...args) {
  if (request === './logContent') return contentStub
  if (request === './logTemplateCompiler') return compilerStub
  if (request.startsWith('@/')) request = path.join(src, request.slice(2))
  return original.call(this, request, parent, ...args)
}
const body = (html, plainText) => ({ html, plainText, assets: [] })
Module._cache[contentStub] = { id: contentStub, filename: contentStub, loaded: true, exports: {
  renderMessageBody: (content) => body(`<p>${content}</p>`, content),
  renderPresentedBody: (html, plainText) => body(html, plainText),
  normalizeMentionClasses: () => {},
  attachmentToken: (id) => `att:${id}`,
} }
Module._cache[compilerStub] = { id: compilerStub, filename: compilerStub, loaded: true, exports: {
  buildTemplateLibrary: () => null, fragmentToHtml: () => '', instantiateTemplate: () => null,
  isSafeTokenValue: () => true, sanitizeBodyHtml: (html) => html, templateUsesField: () => false,
} }
// publicHtmlToBody 只需要无图片时的最小 template/div 行为。
globalThis.document = {
  createElement: () => {
    const el = { innerHTML: '', content: { querySelectorAll: () => [] }, appendChild: (frag) => { el.innerHTML = frag.html } }
    Object.defineProperty(el.content, 'html', { get: () => el.innerHTML })
    return el
  },
}
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText, filename)

const r = require(path.join(src, 'services/log/logRenderer.ts'))

const design = (id, presentation, extra = {}) => r.designMessageToNode({
  message: { id, content: extra.content || `正文 ${id}`, createdAt: '2026-10-18T12:00:00Z', icMode: extra.icMode || 'ic', identity: { id: 'alice', displayName: '艾丽丝' }, user: { id: 'u-alice' } },
  capabilities: { reorder: true },
  presentation,
})
const whisper = (...targets) => ({ whisper: { targets: targets.map(([key, name]) => ({ key, name })) } })

// 普通消息不带任何投影，行为与旧版一致。
{
  const n = design('plain')
  assert.equal(n.whisper, null)
  assert.equal(n.quote, null)
  assert.equal(n.embed, null)
  assert.equal(n.bodyHtml, '<p>正文 plain</p>')
}

// 悄悄话收件人保持结构化，显示文本与传统导出「对 A、B」一致；悄悄话与 IC/OOC 正交。
{
  const ic = design('w-ic', whisper(['u1', '甲'], ['u2', '乙']))
  assert.deepEqual(ic.whisper, { targets: [{ key: 'u1', name: '甲' }, { key: 'u2', name: '乙' }] })
  assert.equal(r.whisperTargetsText(ic.whisper), '甲、乙')
  assert.equal(ic.messageType, 'ic')
  const ooc = design('w-ooc', whisper(['u1', '甲']), { icMode: 'ooc' })
  assert.equal(ooc.messageType, 'ooc')
  assert.equal(r.whisperTargetsText(ooc.whisper), '甲')
  assert.equal(design('w-empty', whisper(['u1', '  '])).whisper, null, '空名收件人被丢弃')
}

// 合并：收件人集合相同才合并；收件人变化、普通与悄悄话相邻、带引用的消息都另起一组。
{
  const a = design('a', whisper(['u1', '甲'], ['u2', '乙']))
  const sameSet = design('b', whisper(['u2', '乙'], ['u1', '甲']))
  const other = design('c', whisper(['u3', '丙']))
  const plain = design('d')
  assert.equal(r.canMergeMessageNodes(a, sameSet), true)
  assert.equal(r.canMergeMessageNodes(sameSet, other), false)
  assert.equal(r.canMergeMessageNodes(other, plain), false)
  assert.equal(r.canMergeMessageNodes(plain, design('e', whisper(['u3', '丙']))), false)
  assert.equal(r.canMergeMessageNodes(plain, design('f')), true)
  assert.equal(r.canMergeMessageNodes(plain, design('g', { quote: { speakerName: '乙', text: '原话' } })), false)
}

// 嵌入：设计态展示服务端展开结果，原文 content 不受影响。
{
  const n = design('embed', { embed: { kind: 'stickyNote', bodyHtml: '<div class="log-embed">[便签: 地图]</div>', plainText: '[便签: 地图]' } }, { content: 'https://x/#/w/c?snote=1' })
  assert.equal(n.embed, 'stickyNote')
  assert.equal(n.bodyHtml, '<div class="log-embed">[便签: 地图]</div>')
  assert.equal(n.plainText, '[便签: 地图]')
}

// 发布节点与设计节点读出同样的语义字段。
{
  const pub = r.publicNodeToRender({
    kind: 'message', id: 'n1', messageType: 'ic', speaker: { key: 'k', name: '艾丽丝', color: null, avatarAssetKey: null },
    bodyHtml: '<div class="log-embed log-embed--world-clue"><p>线索</p></div>', plainText: '线索', createdAt: '2026-10-18T12:00:00Z',
    embed: 'worldClue', quote: { speakerName: '乙', text: '原话' },
  })
  assert.equal(pub.embed, 'worldClue')
  assert.deepEqual(pub.quote, { speakerName: '乙', text: '原话' })
  assert.equal(pub.whisper, null)
  const legacy = r.publicNodeToRender({ kind: 'message', id: 'n2', messageType: 'ic', speaker: { key: 'k', name: 'x' }, bodyHtml: '', plainText: '', createdAt: '' })
  assert.equal(legacy.embed, null, '旧发布节点没有新字段时保持兼容')
  assert.equal(legacy.quote, null)
}

console.log('log message presentation regression: ok')
