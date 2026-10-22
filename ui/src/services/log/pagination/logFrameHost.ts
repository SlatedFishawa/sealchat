// 分页引擎外层接口：一个接口、一个默认引擎（自研测量分页，运行于隔离 iframe）。
// iframe: srcdoc + sandbox="allow-scripts allow-modals"（无 same-origin / forms / popups / top-navigation），
// CSP 只允许带 nonce 的应用脚本，禁止 connect 与外部资源；图片/字体由外层按权限取字节后传入。
import runtimeSource from './logFrameRuntime.js?raw';
import baseCss from './logFrame.css?raw';
import type { LogPageSettings } from '@/types/log';
import type { LogImageResize } from '../logImageLayout';

export interface FrameBlock {
  id: string;
  kind: 'message' | 'element';
  html: string;
  classes: string[];
  attrs: Record<string, string>;
  vars: Record<string, string>;
  breakBefore: boolean;
  breakAfter: boolean;
}

export interface FrameDocument {
  page: LogPageSettings;
  css: string;
  rootVars: Record<string, string>;
  rootAttrs: Record<string, string>;
  blocks: FrameBlock[];
  headerHtml: string | null;
  footerHtml: string | null;
  backgroundToken: string | null;
  pageNumberStart: number;
}

export interface FrameAnchor { nodeId: string; fragmentIndex: number; offsetWithinViewport: number }

export interface FrameLayoutResult {
  revision: number;
  pageCount: number;
  map: Record<string, number[]>;
  warnings: Array<{ code: string; nodeId: string | null }>;
  missingAssets: number;
  nodes: number;
  domNodes: number;
  elapsedMs: number;
}

export type FrameEvent =
  | ({ type: 'imageResize' } & LogImageResize)
  | { type: 'select'; nodeId: string | null; kind?: string; shift?: boolean; additive?: boolean }
  | { type: 'open'; nodeId: string; kind?: string }
  | { type: 'drop'; nodeId: string; targetId: string; side: 'before' | 'after' }
  | { type: 'action'; nodeId: string; action: 'edit' | 'insert-before' | 'insert-after' }
  | { type: 'anchor'; anchor: FrameAnchor | null; nearEnd?: boolean }
  | { type: 'key'; key: string }
  | { type: 'progress'; revision: number; done: number; total: number }
  | { type: 'scrollMiss'; nodeId: string };

export interface FrameAsset { token: string; data: ArrayBuffer | null; mime: string }
export interface FrameRelocation { sourceMessageIds: string[] }
export interface FramePrintRange { fromPage: number; toPage: number }

export interface LayoutRequest {
  doc: FrameDocument;
  mode: 'paged' | 'flow';
  spread: boolean;
  design: boolean;
  canResizeImages: boolean;
  selection: string[];
  relocation?: FrameRelocation | null;
  anchor?: FrameAnchor | null;
}

const randomToken = () => {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
};

export const LOG_FRAME_SANDBOX = 'allow-scripts allow-modals';

const buildSrcdoc = (token: string, nonce: string) => {
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    'img-src blob: data:',
    'font-src blob: data:',
    "connect-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
  const script = runtimeSource.replace("'__LOG_FRAME_TOKEN__'", JSON.stringify(token));
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">`
    + `<meta http-equiv="Content-Security-Policy" content="${csp}">`
    + `<meta name="referrer" content="no-referrer">`
    + `<style id="log-base">${baseCss}</style><style id="log-page-rule"></style><style id="log-package"></style>`
    + `</head><body><main id="log-root" role="document" aria-label="LOG 预览"></main>`
    + `<script nonce="${nonce}">${script.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
};

/**
 * 隔离预览宿主。layout(input, revision) 返回该修订的结果；旧修订即使完成也被丢弃。
 */
export class LogFrameEngine {
  private readonly token = randomToken();
  private readonly nonce = randomToken();
  private channel: MessageChannel | null = null;
  private readyPromise: Promise<void>;
  private resolveReady: (() => void) | null = null;
  private pending = new Map<number, { resolve: (r: FrameLayoutResult) => void; reject: (e: Error) => void; started: number }>();
  private pendingPrint = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
  private printSeq = 0;
  private deliveredAssets = new Set<string>();
  private disposed = false;
  private readonly onLoad = () => this.handshake();

  constructor(private readonly iframe: HTMLIFrameElement, private readonly onEvent: (event: FrameEvent) => void) {
    this.readyPromise = new Promise((resolve) => { this.resolveReady = resolve; });
    iframe.setAttribute('sandbox', LOG_FRAME_SANDBOX);
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    iframe.addEventListener('load', this.onLoad);
    iframe.srcdoc = buildSrcdoc(this.token, this.nonce);
  }

  private handshake() {
    if (this.disposed || !this.iframe.contentWindow) return;
    this.channel?.port1.close();
    this.deliveredAssets.clear();
    const channel = new MessageChannel();
    this.channel = channel;
    channel.port1.onmessage = (ev) => this.receive(ev.data);
    // opaque origin 为 "null"，因此只能用 '*' 投递；接收端校验 source 与会话令牌。
    this.iframe.contentWindow.postMessage({ type: 'log-frame-init', token: this.token }, '*', [channel.port2]);
  }

  private receive(msg: any) {
    if (!msg || typeof msg.type !== 'string') return;
    switch (msg.type) {
      case 'ready':
        this.resolveReady?.();
        break;
      case 'layout': {
        const entry = this.pending.get(msg.revision);
        if (!entry) return;
        this.pending.delete(msg.revision);
        entry.resolve({ ...msg, elapsedMs: Math.round(performance.now() - entry.started) } as FrameLayoutResult);
        break;
      }
      case 'error': {
        const entry = this.pending.get(msg.revision);
        if (!entry) return;
        this.pending.delete(msg.revision);
        entry.reject(new Error(String(msg.message || '排版失败')));
        break;
      }
      case 'printDone': {
        const entry = this.pendingPrint.get(Number(msg.requestId));
        if (!entry) return;
        this.pendingPrint.delete(Number(msg.requestId));
        entry.resolve();
        break;
      }
      case 'printError': {
        const entry = this.pendingPrint.get(Number(msg.requestId));
        if (!entry) return;
        this.pendingPrint.delete(Number(msg.requestId));
        entry.reject(new Error(String(msg.message || '打印准备失败')));
        break;
      }
      case 'select':
      case 'imageResize':
      case 'open':
      case 'drop':
      case 'action':
      case 'anchor':
      case 'key':
      case 'progress':
      case 'scrollMiss':
        this.onEvent(msg as FrameEvent);
        break;
      default:
        break;
    }
  }

  get ready() {
    return this.readyPromise;
  }

  /** 只投递 iframe 尚未持有的资源；字节被复制而非转移，外层缓存保持可用。 */
  async provideAssets(assets: FrameAsset[]) {
    await this.readyPromise;
    const fresh = assets.filter((a) => !this.deliveredAssets.has(a.token));
    if (!fresh.length || !this.channel) return;
    fresh.forEach((a) => this.deliveredAssets.add(a.token));
    this.channel.port1.postMessage({ type: 'assets', items: fresh });
  }

  hasAsset(token: string) {
    return this.deliveredAssets.has(token);
  }

  async layout(input: LayoutRequest, revision: number): Promise<FrameLayoutResult | null> {
    await this.readyPromise;
    if (this.disposed || !this.channel) return null;
    // 新修订开始时，所有更早的等待者以 null 结束（结果作废）。
    for (const [rev, entry] of this.pending) {
      if (rev < revision) {
        this.pending.delete(rev);
        entry.resolve(null as unknown as FrameLayoutResult);
      }
    }
    const result = new Promise<FrameLayoutResult>((resolve, reject) => {
      this.pending.set(revision, { resolve, reject, started: performance.now() });
    });
    this.channel.port1.postMessage({ type: 'render', revision, ...input });
    const r = await result;
    return r && r.revision === revision ? r : null;
  }

  select(ids: string[]) {
    this.channel?.port1.postMessage({ type: 'select', ids });
  }

  relocate(state: FrameRelocation | null) {
    this.channel?.port1.postMessage({ type: 'relocate', state });
  }

  scrollTo(nodeId: string, flash = true) {
    this.channel?.port1.postMessage({ type: 'scrollTo', nodeId, flash });
  }

  zoom(value: number) {
    this.channel?.port1.postMessage({ type: 'zoom', zoom: value });
  }

  /** 设置工作区（纸张之外）的底色；color 为 null 时恢复默认。 */
  canvas(color: string | null, dark = false, accent?: string) {
    this.channel?.port1.postMessage({ type: 'canvas', color, dark, accent });
  }

  async print(range?: FramePrintRange) {
    await this.readyPromise;
    if (this.disposed || !this.channel) throw new Error('打印预览不可用');
    const requestId = ++this.printSeq;
    const result = new Promise<void>((resolve, reject) => {
      this.pendingPrint.set(requestId, { resolve, reject });
    });
    this.channel.port1.postMessage({
      type: 'print',
      requestId,
      fromPage: range?.fromPage,
      toPage: range?.toPage,
    });
    return result;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.iframe.removeEventListener('load', this.onLoad);
    try {
      this.channel?.port1.postMessage({ type: 'dispose' });
    } catch {
      // 端口可能已关闭
    }
    this.channel?.port1.close();
    this.channel = null;
    for (const entry of this.pending.values()) entry.resolve(null as unknown as FrameLayoutResult);
    this.pending.clear();
    for (const entry of this.pendingPrint.values()) entry.reject(new Error('打印已取消'));
    this.pendingPrint.clear();
    this.deliveredAssets.clear();
  }
}
