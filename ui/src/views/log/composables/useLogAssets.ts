// 资源令牌 → 字节：外层按权限获取后交给隔离 iframe（转为 iframe 内的 Blob URL）。
// 令牌：att:（历史聊天附件）、body:（LOG 正文）、style:（样式包）、proj:（LOG 工程素材）、pub:（公开快照）。
import { onBeforeUnmount } from 'vue';
import {
  buildPlatformFontFileUrl,
  buildPlatformFontSubsetUrl,
  getPlatformFontManifest,
  getPlatformFontMeta,
  getPublicPlatformFontManifest,
  getPublicPlatformFontMeta,
} from '@/services/font/platformFontApi';
import type { PlatformFontAsset, PlatformFontSubsetManifest } from '@/services/font/platformFontTypes';
import { inferPlatformFontFormat, resolvePlatformFontChunkUrl } from '@/services/font/platformFontSubsetRuntime';
import { buildLogFontPlan, collectLogFontText, logFontChunkToken, logPlatformFontId } from '@/services/log/logFontPlan';
import {
  fetchAttachmentBytes,
  fetchLogBodyAssetBytes,
  fetchLogProjectAssetBytes,
  fetchLogStyleAssetBytes,
  fetchPublicAssetBytes,
  publicAssetPath,
} from '@/services/log/logApi';
import type { FrameAsset, FrameDocument } from '@/services/log/pagination/logFrameHost';

const MAX_PARALLEL = 6;
const FONT_MIME = /^(font\/(ttf|otf|sfnt|woff|woff2)|application\/(x-font-ttf|x-font-otf|font-sfnt))$/;

export interface PreparedLogFrame { doc: FrameDocument; assets: FrameAsset[] }

const PROJECT_ASSET_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export interface AssetScope {
  /** 设计态：服务端生成的正文资源上下文与 proj: 工程素材都属于当前工程。 */
  projectId?: () => string;
  /** 设计态：当前样式包（用于 style: 令牌）。 */
  stylePackage?: () => { id: string; version: string } | null;
  /** 公开态：当前展示 slug（用于 pub: 令牌）。 */
  publicSlug?: () => string;
}

export const useLogAssets = (scope: AssetScope) => {
  const cache = new Map<string, Promise<FrameAsset>>();
  const controller = new AbortController();
  const publicScope = !!scope.publicSlug;
  // 与当前资源宿主同生命周期，编辑文本时复用清单，不建立全局字体缓存。
  const fontInfo = new Map<string, Promise<{ meta?: PlatformFontAsset; manifest?: PlatformFontSubsetManifest }>>();
  const getFontInfo = (id: string) => {
    let task = fontInfo.get(id);
    if (!task) {
      task = (async () => {
        const meta = await (publicScope ? getPublicPlatformFontMeta(id) : getPlatformFontMeta(id));
        const manifest = meta.deliveryMode === 'subset'
          ? await (publicScope ? getPublicPlatformFontManifest(id) : getPlatformFontManifest(id)).catch(() => undefined)
          : undefined;
        return { meta, manifest };
      })().catch(() => ({}));
      fontInfo.set(id, task);
    }
    return task;
  };
  let active = 0;
  const queue: Array<() => void> = [];

  const acquire = () => new Promise<void>((resolve) => {
    if (active < MAX_PARALLEL) {
      active += 1;
      resolve();
    } else {
      queue.push(() => {
        active += 1;
        resolve();
      });
    }
  });
  const release = () => {
    active -= 1;
    queue.shift()?.();
  };

  const fetchToken = async (token: string): Promise<FrameAsset> => {
    const [kind, ...rest] = token.split(':');
    const id = rest.join(':');
    await acquire();
    try {
      if (kind === 'platform-font') {
        const match = /^([A-Za-z0-9_-]{1,100}):(full|chunk:[a-f0-9]+)$/.exec(id);
        if (!match) return { token, data: null, mime: '' };
        const fontId = match[1];
        const info = await getFontInfo(fontId);
        const chunk = match[2] === 'full' ? undefined : info.manifest?.chunks?.find(item => logFontChunkToken(fontId, item) === token);
        if (match[2] !== 'full' && !chunk) return { token, data: null, mime: '' };
        const url = chunk
          ? resolvePlatformFontChunkUrl(chunk, name => buildPlatformFontSubsetUrl(fontId, name), true)
          : buildPlatformFontFileUrl(fontId);
        const response = await fetch(url, { signal: controller.signal, credentials: publicScope ? 'omit' : 'include' });
        if (!response.ok) return { token, data: null, mime: '' };
        let mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (!mime || mime === 'application/octet-stream') {
          const format = inferPlatformFontFormat(chunk?.name || info.meta?.sourceFileName || '', chunk?.mimeType || info.meta?.sourceMimeType);
          mime = ({ woff2: 'font/woff2', woff: 'font/woff', opentype: 'font/otf', truetype: 'font/ttf' } as Record<string, string>)[format] || '';
        }
        if (!FONT_MIME.test(mime)) return { token, data: null, mime: '' };
        return { token, data: await response.arrayBuffer(), mime };
      }
      if (kind === 'att' && id) {
        const r = await fetchAttachmentBytes(id, controller.signal);
        return { token, data: r.data, mime: r.mime };
      }
      if (kind === 'body' && id) {
        const projectId = scope.projectId?.();
        if (!projectId) return { token, data: null, mime: '' };
        const r = await fetchLogBodyAssetBytes(projectId, id, controller.signal);
        return { token, data: r.data, mime: r.mime };
      }
      if (kind === 'proj' && PROJECT_ASSET_ID.test(id)) {
        const projectId = scope.projectId?.();
        if (!projectId) return { token, data: null, mime: '' };
        const r = await fetchLogProjectAssetBytes(projectId, id, controller.signal);
        return { token, data: r.data, mime: r.mime };
      }
      if (kind === 'style' && id) {
        const pkg = scope.stylePackage?.();
        if (!pkg) return { token, data: null, mime: '' };
        const r = await fetchLogStyleAssetBytes(pkg.id, pkg.version, id, controller.signal);
        return { token, data: r.data, mime: r.mime };
      }
      if (kind === 'pub' && id) {
        const slug = scope.publicSlug?.();
        if (!slug) return { token, data: null, mime: '' };
        const r = await fetchPublicAssetBytes(publicAssetPath(slug, id), controller.signal);
        return { token, data: r.data, mime: r.mime };
      }
      return { token, data: null, mime: '' };
    } catch {
      return { token, data: null, mime: '' };
    } finally {
      release();
    }
  };

  const ensure = (tokens: string[]) => Promise.all(tokens.map((token) => {
    let p = cache.get(token);
    if (!p) {
      p = fetchToken(token);
      cache.set(token, p);
    }
    return p;
  }));

  /** 在任何字节送入 iframe 前完成分片规划和必要的 full 降级。 */
  const prepare = async (doc: FrameDocument, tokens: string[], hasAsset: (token: string) => boolean): Promise<PreparedLogFrame> => {
    const id = logPlatformFontId(doc.page.fontFamily);
    if (!id) return { doc, assets: await ensure(tokens.filter(token => !hasAsset(token))) };
    const text = collectLogFontText(doc);
    const info = text.text || !text.reliable ? await getFontInfo(id) : {};
    let plan = buildLogFontPlan(id, text, info.meta, info.manifest);
    const missing = (items: string[]) => items.filter(token => !hasAsset(token));
    let assets = await ensure(missing([...tokens, ...plan.tokens]));
    if (plan.subset && assets.some(asset => plan.tokens.includes(asset.token) && !asset.data)) {
      plan = buildLogFontPlan(id, text, info.meta, undefined, true);
      assets = [...assets.filter(asset => !asset.token.startsWith('platform-font:')), ...await ensure(missing(plan.tokens))];
    }
    return { doc: { ...doc, css: `${plan.css}\n${doc.css}` }, assets };
  };

  /**
   * 刚上传的工程素材在草稿保存前服务端还读不到：上传者用本地字节预置缓存，
   * 预览与缩略图立即可用；同一 proj: 令牌永远对应同一附件，无需失效。
   */
  const seed = (token: string, data: ArrayBuffer, mime: string) => {
    if (!cache.has(token)) cache.set(token, Promise.resolve({ token, data, mime }));
  };

  // 外层界面（素材网格、图片选择）用的 Blob URL：与资源宿主同生命周期，卸载时统一回收。
  const objectUrls = new Map<string, Promise<string | null>>();
  const objectUrl = (token: string) => {
    let task = objectUrls.get(token);
    if (!task) {
      task = ensure([token]).then(([asset]) => {
        const mime = String(asset?.mime || '').split(';')[0].trim().toLowerCase();
        if (controller.signal.aborted || !asset?.data || !/^image\/(png|jpeg|webp|gif|avif)$/.test(mime)) return null;
        return URL.createObjectURL(new Blob([asset.data], { type: mime }));
      });
      objectUrls.set(token, task);
    }
    return task;
  };

  /** 样式包切换后，style: 令牌指向另一个包版本，必须失效。 */
  const invalidate = (prefix: string) => {
    for (const key of Array.from(cache.keys())) {
      if (key.startsWith(prefix)) cache.delete(key);
    }
    for (const [key, task] of Array.from(objectUrls.entries())) {
      if (!key.startsWith(prefix)) continue;
      objectUrls.delete(key);
      void task.then((url) => url && URL.revokeObjectURL(url));
    }
  };

  onBeforeUnmount(() => {
    controller.abort();
    cache.clear();
    fontInfo.clear();
    objectUrls.forEach((task) => void task.then((url) => url && URL.revokeObjectURL(url)));
    objectUrls.clear();
  });

  return { ensure, prepare, invalidate, seed, objectUrl };
};
