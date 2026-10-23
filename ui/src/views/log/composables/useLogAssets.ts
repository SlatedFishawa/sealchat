// 资源令牌 → 字节：外层按权限获取后交给隔离 iframe（转为 iframe 内的 Blob URL）。
// 令牌：att:（历史聊天附件）、body:（LOG 正文）、style:（样式包）、proj:（LOG 工程素材）、pub:（公开快照）。
// 缓存、并发与字体规划在 createLogAssetLoader 中，与后台 PDF Render Surface 共用。
import { onBeforeUnmount } from 'vue';
import {
  buildPlatformFontFileUrl,
  buildPlatformFontSubsetUrl,
  getPlatformFontManifest,
  getPlatformFontMeta,
  getPublicPlatformFontManifest,
  getPublicPlatformFontMeta,
} from '@/services/font/platformFontApi';
import { resolvePlatformFontChunkUrl } from '@/services/font/platformFontSubsetRuntime';
import { createLogAssetLoader, type PreparedLogFrame } from '@/services/log/logAssetLoader';
import {
  fetchAttachmentBytes,
  fetchLogBodyAssetBytes,
  fetchLogProjectAssetBytes,
  fetchLogStyleAssetBytes,
  fetchPublicAssetBytes,
  publicAssetPath,
} from '@/services/log/logApi';
import type { FrameAsset } from '@/services/log/pagination/logFrameHost';

export type { PreparedLogFrame };

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
  const publicScope = !!scope.publicSlug;
  const loader = createLogAssetLoader({
    fontInfo: async (id) => {
      const meta = await (publicScope ? getPublicPlatformFontMeta(id) : getPlatformFontMeta(id));
      const manifest = meta.deliveryMode === 'subset'
        ? await (publicScope ? getPublicPlatformFontManifest(id) : getPlatformFontManifest(id)).catch(() => undefined)
        : undefined;
      return { meta, manifest };
    },
    fetchFont: async (_token, fontId, chunk, signal) => {
      const url = chunk
        ? resolvePlatformFontChunkUrl(chunk, name => buildPlatformFontSubsetUrl(fontId, name), true)
        : buildPlatformFontFileUrl(fontId);
      const response = await fetch(url, { signal, credentials: publicScope ? 'omit' : 'include' });
      if (!response.ok) return null;
      return { data: await response.arrayBuffer(), mime: response.headers.get('content-type') || '' };
    },
    fetchAsset: async (token, signal): Promise<FrameAsset> => {
      const [kind, ...rest] = token.split(':');
      const id = rest.join(':');
      if (kind === 'att' && id) {
        const r = await fetchAttachmentBytes(id, signal);
        return { token, data: r.data, mime: r.mime };
      }
      if (kind === 'body' && id) {
        const projectId = scope.projectId?.();
        if (!projectId) return { token, data: null, mime: '' };
        const r = await fetchLogBodyAssetBytes(projectId, id, signal);
        return { token, data: r.data, mime: r.mime };
      }
      if (kind === 'proj' && PROJECT_ASSET_ID.test(id)) {
        const projectId = scope.projectId?.();
        if (!projectId) return { token, data: null, mime: '' };
        const r = await fetchLogProjectAssetBytes(projectId, id, signal);
        return { token, data: r.data, mime: r.mime };
      }
      if (kind === 'style' && id) {
        const pkg = scope.stylePackage?.();
        if (!pkg) return { token, data: null, mime: '' };
        const r = await fetchLogStyleAssetBytes(pkg.id, pkg.version, id, signal);
        return { token, data: r.data, mime: r.mime };
      }
      if (kind === 'pub' && id) {
        const slug = scope.publicSlug?.();
        if (!slug) return { token, data: null, mime: '' };
        const r = await fetchPublicAssetBytes(publicAssetPath(slug, id), signal);
        return { token, data: r.data, mime: r.mime };
      }
      return { token, data: null, mime: '' };
    },
  });
  const { ensure, prepare } = loader;

  /**
   * 刚上传的工程素材在草稿保存前服务端还读不到：上传者用本地字节预置缓存，
   * 预览与缩略图立即可用；同一 proj: 令牌永远对应同一附件，无需失效。
   */
  const seed = loader.seed;

  // 外层界面（素材网格、图片选择）用的 Blob URL：与资源宿主同生命周期，卸载时统一回收。
  const objectUrls = new Map<string, Promise<string | null>>();
  const objectUrl = (token: string) => {
    let task = objectUrls.get(token);
    if (!task) {
      task = ensure([token]).then(([asset]) => {
        const mime = String(asset?.mime || '').split(';')[0].trim().toLowerCase();
        if (loader.signal.aborted || !asset?.data || !/^image\/(png|jpeg|webp|gif|avif)$/.test(mime)) return null;
        return URL.createObjectURL(new Blob([asset.data], { type: mime }));
      });
      objectUrls.set(token, task);
    }
    return task;
  };

  /** 样式包切换后，style: 令牌指向另一个包版本，必须失效。 */
  const invalidate = (prefix: string) => {
    loader.invalidate(prefix);
    for (const [key, task] of Array.from(objectUrls.entries())) {
      if (!key.startsWith(prefix)) continue;
      objectUrls.delete(key);
      void task.then((url) => url && URL.revokeObjectURL(url));
    }
  };

  onBeforeUnmount(() => {
    loader.dispose();
    objectUrls.forEach((task) => void task.then((url) => url && URL.revokeObjectURL(url)));
    objectUrls.clear();
  });

  return { ensure, prepare, invalidate, seed, objectUrl };
};
