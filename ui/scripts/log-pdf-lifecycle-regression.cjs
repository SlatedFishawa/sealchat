// PDF 任务恢复与打印 revision 竞态：执行真实组件中的轮询 / waiter / Frame host 逻辑。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');

const read = (file) => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8');
const script = (file) => read(file).split('<script setup lang="ts">')[1].split('</script>')[0];
const pick = (source, names) => {
  const ast = ts.createSourceFile('component.ts', source, ts.ScriptTarget.Latest, true);
  return ast.statements.filter((s) => ts.isVariableStatement(s) && s.declarationList.declarations.some((d) => names.includes(d.name.getText(ast))))
    .map((s) => s.getText(ast)).join('\n');
};
const execute = (source, context) => vm.runInNewContext(ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, { exports: {}, ...context });
const ref = (value) => ({ value });
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

async function polling() {
  const api = {};
  execute(read('services/log/logApi.ts').slice(read('services/log/logApi.ts').indexOf('export type LogErrorCode'), read('services/log/logApi.ts').indexOf('const unwrap')),
    { exports: api, isAxiosError: (e) => !!e?.isAxiosError });
  const timers = new Map();
  let nextTimer = 0;
  const stored = new Map();
  const props = { show: true, projectId: 'project' };
  let nextResponse;
  let reopen;
  const exported = {};
  execute(script('views/log/components/LogPdfExportDialog.vue') + '\nObject.assign(exposed, { poll, stopPolling, taskId, taskState, errorText, recallTask });', {
    exposed: exported, defineProps: () => props, defineEmits: () => () => {},
    require: (name) => {
      if (name === 'vue') return { ref, computed: (fn) => ({ get value() { return fn(); } }), watch: (_, cb) => { reopen = cb; }, onBeforeUnmount() {} };
      if (name === 'naive-ui') return { useMessage: () => ({}) };
      if (name.includes('logApi')) return { ...api, fetchLogPdfCapability: async () => ({ available: true }) };
      if (name.includes('stores/chat')) return { useChatStore: () => ({ getExportTaskStatus: async () => nextResponse() }) };
      throw new Error(name);
    },
    localStorage: { getItem: (key) => stored.get(key), setItem: (key, value) => stored.set(key, value), removeItem: (key) => stored.delete(key) },
    setTimeout: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
  });
  const remember = () => { exported.taskId.value = 'task'; exported.taskState.value = 'processing'; stored.set('sealchat.log.pdfTask.project', 'task'); };
  const httpError = (status) => ({ isAxiosError: true, response: { status, data: {} } });
  for (const error of [httpError(502), httpError(503), { isAxiosError: true, code: 'ECONNABORTED' }, new Error('offline')]) {
    remember();
    nextResponse = () => { throw error; };
    exported.poll('task');
    await flush();
    assert.equal(exported.taskId.value, 'task');
    assert.equal(exported.recallTask(), 'task');
    assert.equal(exported.taskState.value, 'processing');
    assert.match(exported.errorText.value, /自动重试/);
    assert.equal(timers.size, 1);
    for (let i = 0; i < 5; i++) {
      const [id, timer] = timers.entries().next().value;
      assert.ok(timer.delay <= 30000);
      timers.delete(id); timer.fn(); await flush();
    }
    // 关闭只清理前端 timer，再打开从持久任务恢复。
    props.show = false; reopen([false]);
    assert.equal(timers.size, 0);
    assert.equal(exported.recallTask(), 'task');
    nextResponse = () => ({ status: 'processing' });
    props.show = true; reopen([true]); await flush();
    assert.equal(exported.taskId.value, 'task');
    assert.equal(exported.errorText.value, '');
    assert.equal(timers.size, 1);
    exported.stopPolling();
  }
  for (const status of [403, 404]) {
    remember(); nextResponse = () => { throw httpError(status); };
    exported.poll('task'); await flush();
    assert.equal(exported.taskId.value, '');
    assert.equal(exported.recallTask(), '');
    assert.equal(exported.taskState.value, 'idle');
    assert.equal(timers.size, 0);
  }
  for (const status of ['done', 'failed']) {
    remember(); nextResponse = () => ({ status });
    exported.poll('task'); await flush();
    assert.equal(exported.taskState.value, status);
    assert.equal(exported.recallTask(), 'task');
    assert.equal(timers.size, 0);
  }
}

async function printRevision() {
  const exposed = {};
  execute(pick(script('views/log/components/LogWorkbench.vue'), ['printLayoutWaiter', 'onLayout', 'waitForPrintLayout'])
    + '\nObject.assign(exposed, { onLayout, waitForPrintLayout });', {
    exposed, frameRevision: 2, layoutInfo: ref(null), layoutError: ref(''), relocateScrollId: null,
    setTimeout, clearTimeout, Error,
  });
  let resolved = false;
  const ready = exposed.waitForPrintLayout(2, 1000).then((result) => { resolved = true; return result; });
  const old = { revision: 19, pageCount: 1, map: {} };
  exposed.onLayout(old, 1);
  await flush();
  assert.equal(resolved, false, '旧 layout 返回且新 Frame 尚未 layout 时不可结束打印等待');
  const latest = { revision: 20, pageCount: 8, map: {} };
  exposed.onLayout(latest, 2);
  assert.equal(await ready, latest);

  // host 的事件必须携带 run 开始时捕获的 Frame revision，而非返回时的 props 值。
  let finish;
  const props = { doc: {}, frameRevision: 2, assetTokens: [], selection: [], prepareAssets: async () => ({ doc: {}, assets: [] }) };
  const events = [];
  const host = {};
  execute(pick(script('views/log/components/LogPreviewFrame.vue'), ['run']) + '\nhost.run = run;', {
    host, props, revision: 0, busy: ref(false), progress: ref(null), lastAnchor: null,
    engine: ref({ hasAsset: () => false, provideAssets: async () => {}, layout: () => new Promise((resolve) => { finish = resolve; }) }),
    emit: (...args) => events.push(args), JSON, Error, String,
  });
  const running = host.run(); await flush();
  props.frameRevision = 3;
  finish(latest); await running;
  assert.equal(events.find(([type]) => type === 'layout')[2], 2);
}

(async () => {
  await polling();
  await printRevision();
  console.log('log-pdf-lifecycle regression ok');
})().catch((error) => { console.error(error); process.exitCode = 1; });
