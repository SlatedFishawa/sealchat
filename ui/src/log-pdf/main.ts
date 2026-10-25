// 后台 PDF Render Surface 入口（独立 Vite 页面）：不挂载 SPA、路由或 Store。
// 运行时脚本在本顶层文档中执行，渲染完成后通过 window.__SEALCHAT_LOG_PDF__ 报告 ready / failed，
// 由服务端的 Chromium 适配器读取后再打印。
import '@/services/log/pagination/logFrameRuntime.js';
import baseCss from '@/services/log/pagination/logFrame.css?raw';
import { LogFrameSelfChannel } from '@/services/log/pagination/logFrameChannel';
import { READY_GLOBAL, createSessionAssetLoader, renderChunk, type LogPdfPayload } from './surface';

const RUNTIME_TOKEN = '__LOG_FRAME_TOKEN__';

type ReadyState = { status: 'pending' } | ({ status: 'ready' } & Record<string, unknown>) | { status: 'failed'; error: string };

const report = (state: ReadyState) => {
  (window as unknown as Record<string, unknown>)[READY_GLOBAL] = state;
};

const installBaseStyle = () => {
  // 与预览 iframe 相同的层叠顺序：基础样式 → @page → 样式包。
  const style = document.createElement('style');
  style.id = 'log-base';
  style.textContent = baseCss;
  const pageRule = document.getElementById('log-page-rule');
  document.head.insertBefore(style, pageRule);
};

const main = async () => {
  report({ status: 'pending' });
  installBaseStyle();
  const response = await fetch('payload', { credentials: 'omit', cache: 'no-store' });
  if (!response.ok) throw new Error(`payload 请求失败（HTTP ${response.status}）`);
  const payload = await response.json() as LogPdfPayload;
  if (!payload || payload.version !== 1) throw new Error('payload 版本不受支持');

  const root = document.getElementById('log-root');
  const done = document.getElementById('log-pdf-pages');
  if (!root || !done) throw new Error('渲染容器缺失');

  const channel = new LogFrameSelfChannel(RUNTIME_TOKEN);
  const loader = createSessionAssetLoader(payload);
  try {
    const result = await renderChunk(payload, loader, {
      hasAsset: (token) => channel.hasAsset(token),
      provideAssets: (assets) => channel.provideAssets(assets),
      layout: (doc, revision) => channel.layout({
        doc,
        mode: 'paged',
        spread: false,
        design: false,
        canResizeImages: false,
        selection: [],
      }, revision),
    }, {
      collectPages: () => {
        const host = root.querySelector('.log-pages');
        if (!host) return 0;
        const count = host.querySelectorAll(':scope > .log-page').length;
        done.appendChild(host);
        return count;
      },
      tocCells: () => Array.from(done.querySelectorAll<HTMLElement>('[data-log-toc-target]')).map((el) => ({
        target: el.getAttribute('data-log-toc-target') || '',
        set: (text: string) => { el.textContent = text; },
        current: () => (el.textContent || '').trim(),
      })),
    });
    // 等两帧，让 log-laid-out 等收尾样式落定后再交给打印。
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    report({ ...result });
  } finally {
    loader.dispose();
  }
};

main().catch((err) => {
  report({ status: 'failed', error: String((err && (err as Error).message) || err).slice(0, 300) });
});
