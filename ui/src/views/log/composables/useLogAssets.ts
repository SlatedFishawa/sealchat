// 资源令牌 → 字节：外层按权限获取后交给隔离 iframe（转为 iframe 内的 Blob URL）。
// 令牌：att:（历史聊天附件）、body:（LOG 正文）、style:（样式包）、pub:（公开快照）。
import { onBeforeUnmount } from 'vue';
import {
  fetchAttachmentBytes,
  fetchLogBodyAssetBytes,
  fetchLogStyleAssetBytes,
  fetchPublicAssetBytes,
  publicAssetPath,
} from '@/services/log/logApi';
import type { FrameAsset } from '@/services/log/pagination/logFrameHost';

const MAX_PARALLEL = 6;

export interface AssetScope {
  /** 设计态：服务端生成的正文资源上下文属于当前工程。 */
  projectId?: () => string;
  /** 设计态：当前样式包（用于 style: 令牌）。 */
  stylePackage?: () => { id: string; version: string } | null;
  /** 公开态：当前展示 slug（用于 pub: 令牌）。 */
  publicSlug?: () => string;
}

export const useLogAssets = (scope: AssetScope) => {
  const cache = new Map<string, Promise<FrameAsset>>();
  const controller = new AbortController();
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

  /** 样式包切换后，style: 令牌指向另一个包版本，必须失效。 */
  const invalidate = (prefix: string) => {
    for (const key of Array.from(cache.keys())) {
      if (key.startsWith(prefix)) cache.delete(key);
    }
  };

  onBeforeUnmount(() => {
    controller.abort();
    cache.clear();
  });

  return { ensure, invalidate };
};
