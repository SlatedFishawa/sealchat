// node --test scripts/log-font-pagination-regression.cjs
// 在最小测量 DOM 中执行真实 iframe runtime，核验字体等待、分页和旧修订丢弃。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase(); this.childNodes = []; this.attrs = {}; this.className = '';
    this.style = { setProperty() {}, removeProperty() {} };
    this.classList = {
      contains: value => this.className.split(' ').includes(value),
      add: value => { this.className += ` ${value}`; }, remove() {}, toggle() {},
    };
  }
  addEventListener() {}
  setAttribute(key, value) { this.attrs[key] = value; }
  getAttribute(key) { return this.attrs[key] ?? null; }
  removeAttribute(key) { delete this.attrs[key]; }
  appendChild(child) { child.remove(); this.childNodes.push(child); child.parentNode = this; return child; }
  removeChild(child) { this.childNodes.splice(this.childNodes.indexOf(child), 1); child.parentNode = null; }
  replaceChildren(...children) { for (const child of this.childNodes.slice()) child.remove(); children.forEach(child => this.appendChild(child)); }
  remove() { this.parentNode?.removeChild(this); }
  get firstElementChild() { return this.childNodes[0] || null; }
  get offsetHeight() { return this.scrollHeight; }
  get scrollHeight() { return this.classList.contains('log-node') ? Number(this.innerHTML) : this.childNodes.reduce((sum, child) => sum + child.scrollHeight, 0); }
  get clientHeight() { return Number.parseFloat(this.style.height) || 10000; }
  get clientWidth() { return 10000; }
  get scrollWidth() { return 0; }
  getBoundingClientRect() { return { top: 0, bottom: 80 }; }
  matches(selector) {
    if (selector === '[data-log-node]') return 'data-log-node' in this.attrs;
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    return false;
  }
  querySelectorAll(selector) {
    return this.childNodes.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest(selector); }
}

const createRuntime = (options = {}) => {
  const root = new Element('main');
  const pkg = new Element('style');
  const body = new Element('body');
  const nodes = { 'log-root': root, 'log-package': pkg, 'log-page-rule': new Element('style') };
  const messages = [];
  let releaseFont = () => {};
  const fontReady = options.neverReady ? new Promise(() => {}) : new Promise(resolve => { releaseFont = resolve; });
  let loadCalls = 0;
  const document = {
    body, documentElement: new Element('html'), addEventListener() {}, getElementById: id => nodes[id],
    createElement: tag => new Element(tag), getElementsByTagName: () => [],
    fonts: { ready: fontReady, forEach: fn => fn({ family: 'sc-log-platform-font', load: () => {
      assert.ok(pkg.textContent.includes('blob:chunk'), '@font-face 必须先将占位符替换为 Blob URL');
      assert.ok(body.childNodes[0].childNodes[0].childNodes.length > 0, '字体等待时正文已挂入隐藏 staging');
      loadCalls++; return options.neverReady ? new Promise(() => {}) : fontReady;
    } }) },
  };
  const context = {
    document, window: { addEventListener() {}, scrollBy() {}, CSS: { escape: value => value } },
    URL: { createObjectURL: () => 'blob:chunk' }, Blob, ArrayBuffer, CSS: { escape: value => value },
    performance,
    setTimeout: options.fastTimeout ? ((fn, ms) => setTimeout(fn, ms === 3000 ? 0 : ms)) : setTimeout,
    clearTimeout,
    requestAnimationFrame: fn => fn(),
    getComputedStyle: () => ({ breakBefore: 'auto', breakAfter: 'auto' }),
  };
  const source = fs.readFileSync(path.join(__dirname, '../src/services/log/pagination/logFrameRuntime.js'), 'utf8');
  vm.runInNewContext(source.replace(/\}\)\(\);\s*$/, 'globalThis.hooks = { render, receiveAssets, setPort: value => { port = value; } };})();'), context);
  context.hooks.setPort({ postMessage: message => messages.push(message) });
  context.hooks.receiveAssets([{ token: 'platform-font:font:chunk:aa', data: new ArrayBuffer(3), mime: 'font/woff2' }]);
  return { ...context.hooks, root, messages, releaseFont, loadCalls: () => loadCalls };
};

const input = (revision, mode = 'paged') => ({
  revision, mode, selection: [], doc: {
    css: '@font-face{font-family:"sc-log-platform-font";src:url("__LOGASSET_platform-font:font:chunk:aa__")}',
    page: { widthMm: 100, heightMm: 26.4583333, marginsMm: { top: 0, right: 0, bottom: 0, left: 0 }, columns: 1 },
    blocks: ['a', 'b'].map(id => ({ id, kind: 'message', html: '80' })),
    rootVars: {}, rootAttrs: {},
  },
});

test('Blob 字体完成加载后才测量分页，正文分页结果稳定', async () => {
  const runtime = createRuntime();
  const work = runtime.render(input(1));
  await new Promise(setImmediate);
  assert.equal(runtime.loadCalls(), 1);
  assert.equal(runtime.messages.length, 0, '字体未完成时不得返回排版');
  assert.equal(runtime.root.childNodes.length, 0);
  runtime.releaseFont();
  await work;
  const layout = runtime.messages.find(message => message.type === 'layout');
  assert.equal(layout.pageCount, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(layout.map)), { a: [1], b: [2] });
});

test('字体永久 pending 时总超时后继续分页，不无限等待 face.load 或 fonts.ready', async () => {
  const runtime = createRuntime({ neverReady: true, fastTimeout: true });
  await runtime.render(input(3));
  assert.equal(runtime.loadCalls(), 1);
  const layout = runtime.messages.find(message => message.type === 'layout');
  assert.equal(layout.revision, 3);
  assert.equal(layout.pageCount, 2);
});

test('字体等待期间新修订覆盖旧修订；flow 与 paged 共用等待链路', async () => {
  const runtime = createRuntime();
  const old = runtime.render(input(1));
  const current = runtime.render(input(2, 'flow'));
  runtime.releaseFont();
  await Promise.all([old, current]);
  const layouts = runtime.messages.filter(message => message.type === 'layout');
  assert.equal(layouts.length, 1);
  assert.equal(layouts[0].revision, 2);
  assert.equal(layouts[0].pageCount, 0);
  assert.equal(runtime.root.childNodes[0].childNodes.length, 2);
});

test('真实 LogFrameEngine 对已投递字体只补充新 chunk，不重复传输字节', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/services/log/pagination/logFrameHost.ts'), 'utf8');
  const messages = [];
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText, {
    module, exports: module.exports, require: name => {
      assert.ok(name.endsWith('?raw'));
      return '';
    }, crypto, performance,
    MessageChannel: class { constructor() {
      this.port1 = { postMessage: message => messages.push(message), close() {} }; this.port2 = {};
    } },
  });
  const iframe = { setAttribute() {}, addEventListener() {}, removeEventListener() {}, contentWindow: { postMessage() {} } };
  const engine = new module.exports.LogFrameEngine(iframe, () => {});
  engine.handshake(); engine.receive({ type: 'ready' });
  const a = { token: 'platform-font:font:chunk:aa', data: new ArrayBuffer(3), mime: 'font/woff2' };
  const b = { ...a, token: 'platform-font:font:chunk:bb' };
  await engine.provideAssets([a]);
  await engine.provideAssets([a, b]);
  await engine.provideAssets([a, b]);
  assert.deepEqual(messages.map(message => Array.from(message.items, item => item.token)), [[a.token], [b.token]]);
  assert.equal(a.data.byteLength, 3, '发送后字节缓存不被转移/清空');
  assert.ok(engine.hasAsset(a.token));
  assert.ok(engine.hasAsset(b.token));
  engine.dispose();
});
