import type { LogDraft } from '@/types/log';

export const normalizeImageWidth = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0.15, value)) : undefined;

export const messageImageKey = (messageId: string, index: number) => `message:${messageId}:image:${index}`;

export interface LogImageResize {
  targetKind: 'element' | 'message';
  nodeId: string;
  imageKey?: string;
  /** null 恢复自动尺寸。 */
  width: number | null;
}

/** 只接受当前节点的内部图片 key；不接受选择器、CSS 或 URL。 */
export const updateDraftImageWidth = (draft: LogDraft, event: LogImageResize): void => {
  const width = event.width === null ? undefined : normalizeImageWidth(event.width);
  if (event.width !== null && width === undefined) return;
  if (event.targetKind === 'element') {
    const element = draft.elements.find((e) => `el-${e.id}` === event.nodeId);
    if (!element || (element.type !== 'cover' && element.type !== 'imagePlate')) return;
    if (width === undefined) delete element.content.imageWidth;
    else element.content.imageWidth = width;
  } else if (event.targetKind === 'message') {
    const prefix = `message:${event.nodeId}:image:`;
    if (!event.imageKey?.startsWith(prefix) || !/^(0|[1-9]\d*)$/.test(event.imageKey.slice(prefix.length))) return;
    if (width === undefined) {
      if (draft.imageWidths) {
        delete draft.imageWidths[event.imageKey];
        if (!Object.keys(draft.imageWidths).length) delete draft.imageWidths;
      }
    } else {
      (draft.imageWidths ||= {})[event.imageKey] = width;
    }
  }
};

/** 仅由已清洗的正文插槽或元素图片调用；原文无法注入控制属性。 */
export const markLogImages = (html: string, target: {
  kind: 'element' | 'message'; id: string; assetToken?: string | null; width?: number;
  widths?: Record<string, number>;
}): string => {
  if (!/<img\b/i.test(html)) return html;
  const holder = document.createElement('template');
  holder.innerHTML = html;
  const images = holder.content.querySelectorAll<HTMLImageElement>('img');
  let index = 0;
  images.forEach((img) => {
    if (target.kind === 'element' && (!target.assetToken || img.getAttribute('data-log-asset') !== target.assetToken)) return;
    const key = target.kind === 'message' ? messageImageKey(target.id, index++) : undefined;
    const width = normalizeImageWidth(key ? target.widths?.[key] : target.width);
    img.setAttribute('data-log-resizable-image', target.kind);
    if (key) img.setAttribute('data-log-image-key', key);
    if (width !== undefined) img.setAttribute('data-log-image-width', String(width));
  });
  return holder.innerHTML;
};
