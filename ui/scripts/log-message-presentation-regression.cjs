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
  bodyAssetToken: (context) => /^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[a-f0-9]{32}$/.test(context) ? `body:${context}` : '',
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

// 普通正文即使服务端残留旧 body 投影，也必须继续走聊天原始内容渲染；
// 这样“高级 TipTap 格式 + 图片”不会因为图片存在而切到精简的 AgentRich 渲染器。
// 历史头像仍可独立使用通用 body: 资源域，空头像投影不能回退成 att:。
{
  const token = `body:section/message/${'a'.repeat(32)}`
  const content = 'client-tip-tap-with-spoiler-ruby-performance-smart-link-and-image'
  const n = design('image', { body: { bodyHtml: '<p>server simplified body</p>', plainText: 'server simplified body' }, avatarToken: token }, { content })
  assert.equal(n.bodyHtml, `<p>${content}</p>`)
  assert.equal(n.plainText, content)
  assert.equal(n.embed, null)
  assert.equal(n.avatarToken, token)
  assert.deepEqual(n.assets, [token])
  assert.equal(design('missing-avatar', { avatarToken: '' }).avatarToken, null)
  assert.equal(design('unsafe-avatar', { avatarToken: 'https://example.com/avatar.png' }).avatarToken, null)
}

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

// 线索：设计态与发布态读出同样的公开展示语义；只收 text/image/iframe 与 http(s) 来源，非线索嵌入不带线索字段。
{
  const clues = [
    { title: '旧照片', kind: 'image', kindLabel: '图片' },
    { title: '港口地图', kind: 'iframe', kindLabel: '网页', source: 'https://maps.example.com/harbor' },
  ]
  const html = '<div class="log-embed log-embed--world-clue"><div class="log-clue log-clue--image">…</div><div class="log-clue log-clue--iframe">…</div></div>'
  const d = design('clue', { embed: { kind: 'worldClue', bodyHtml: html, plainText: '[线索: 旧照片 · 图片]', clues } })
  const pub = r.publicNodeToRender({
    kind: 'message', id: 'n-clue', messageType: 'ooc', speaker: { key: 'k', name: '艾丽丝' }, bodyHtml: html, plainText: '', createdAt: '', embed: 'worldClue', clues,
  })
  assert.deepEqual(d.clues, clues)
  assert.deepEqual(pub.clues, d.clues, '设计态与发布态线索语义一致')
  assert.equal(pub.messageType, 'ooc', '线索与 messageType 正交')
  assert.deepEqual(r.clueTemplateFields(d.clues), {
    'clue.title': '旧照片、港口地图', 'clue.kind': 'image iframe', 'clue.kindLabel': '图片、网页', 'clue.source': 'https://maps.example.com/harbor',
  })
  assert.deepEqual(r.clueTemplateFields([]), { 'clue.title': '', 'clue.kind': '', 'clue.kindLabel': '', 'clue.source': '' })
  const odd = design('clue-odd', { embed: { kind: 'worldClue', bodyHtml: '', plainText: '', clues: [
    { title: '  ', kind: 'text', kindLabel: '文本' },
    { title: '密信', kind: 'script', kindLabel: '', source: 'javascript:alert(1)', privateContent: '成员专属' },
  ] } })
  assert.deepEqual(odd.clues, [{ title: '密信', kind: 'text', kindLabel: 'text' }], '未知类型按文本处理，非 http(s) 来源与额外字段被丢弃')
  assert.deepEqual(design('note', { embed: { kind: 'stickyNote', bodyHtml: '', plainText: '', clues } }).clues, [], '便签不带线索字段')
  assert.deepEqual(r.publicNodeToRender({ kind: 'message', id: 'old', messageType: 'ic', speaker: { key: 'k', name: 'x' }, bodyHtml: '', plainText: '', createdAt: '', embed: 'worldClue' }).clues, [], '旧发布节点没有 clues 字段')

  // 旧样式（无模板库/模板不认识新字段）仍完整显示正文；节点带 data-log-embed / data-log-clue-kind 供 CSS 选择。
  const page = { mergeNeighbors: true, backgroundColor: '#ffffff', fontFamily: 'sans-serif', fontSizePt: 12, lineHeight: 1.5, headerTemplateId: null, footerTemplateId: null, showPageNumbers: false }
  const built = r.buildFrameDocument({ style: null, page, title: 'T', sectionTitle: 'S', nodes: [d, design('clue-next', { embed: { kind: 'worldClue', bodyHtml: html, plainText: '', clues } })], toc: [], backgroundToken: null })
  const [first, second] = built.doc.blocks
  assert.ok(first.html.includes(html), '兜底模板保留完整线索正文')
  assert.equal(first.attrs['data-log-embed'], 'worldClue')
  assert.equal(first.attrs['data-log-clue-kind'], 'image iframe')
  assert.equal(second.attrs['data-log-merged'], '1')
  assert.ok(second.html.includes('log-clue--iframe'), '合并只隐藏发言者，线索标题/类型/来源仍在正文中')
  assert.equal(r.buildFrameDocument({ style: null, page, title: 'T', sectionTitle: 'S', nodes: [design('plain-2')], toc: [], backgroundToken: null }).doc.blocks[0].attrs['data-log-clue-kind'], undefined)
}

console.log('log message presentation regression: ok')
