// 分页引擎外层接口：一个接口、一个默认引擎（自研测量分页，运行于隔离 iframe）。
// iframe: srcdoc + sandbox="allow-scripts allow-modals"（无 same-origin / forms / popups / top-navigation），
// CSP 只允许带 nonce 的应用脚本，禁止 connect 与外部资源；图片/字体由外层按权限取字节后传入。
import runtimeSource from './logFrameRuntime.js?raw';
import baseCss from './logFrame.css?raw';
import type { LogPageSettings } from '@/types/log';
import type { LogImageResize } from '../logImageLayout';
import { LogFrameChannel } from './logFrameChannel';

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
  /** 设计态在原消息上打开右键菜单；x/y 为 iframe 视口坐标。 */
  | { type: 'context'; nodeId: string; x: number; y: number }
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
  /** 多选模式：隐藏单条快捷操作与图片手柄，点击只切换选择。 */
  multi?: boolean;
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
 * 协议本身在 LogFrameChannel 中，与后台 PDF Render Surface 共用。
 */
export class LogFrameEngine extends LogFrameChannel {
  private readonly onLoad = () => this.handshake();

  constructor(private readonly iframe: HTMLIFrameElement, onEvent: (event: FrameEvent) => void) {
    super(randomToken(), onEvent);
    iframe.setAttribute('sandbox', LOG_FRAME_SANDBOX);
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    iframe.addEventListener('load', this.onLoad);
    iframe.srcdoc = buildSrcdoc(this.token, randomToken());
  }

  private handshake() {
    if (this.disposed || !this.iframe.contentWindow) return;
    this.connect(this.iframe.contentWindow);
  }

  dispose() {
    if (this.disposed) return;
    this.iframe.removeEventListener('load', this.onLoad);
    super.dispose();
  }
}
