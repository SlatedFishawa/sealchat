// LOG 图片引用语义（纯函数）：同一处图片只有一个来源。
// - 样式资源：元素 content.assetId / 页面 backgroundAssetId，随样式包兼容检查；
// - 工程素材：元素 content.projectAssetId / 页面 backgroundProjectAssetId，引用 draft.assets，切换样式不受影响。
import type { LogDraft, LogElementType, LogPageSettings, LogProjectAsset } from '@/types/log';

export type LogImageSource = 'project' | 'style';
export interface LogImageRef { source: LogImageSource; id: string }

/** 会引用图片的元素类型：封面可无图，插图页必须有一张。 */
export const IMAGE_ELEMENT_TYPES: ReadonlySet<LogElementType> = new Set<LogElementType>(['cover', 'imagePlate']);
export const elementNeedsImage = (type: LogElementType) => type === 'imagePlate';

const str = (v: unknown) => (typeof v === 'string' && v ? v : '');

export const sameImageRef = (a: LogImageRef | null, b: LogImageRef | null) =>
  (!a && !b) || (!!a && !!b && a.source === b.source && a.id === b.id);

export const elementImageRef = (content: Record<string, unknown> | null | undefined): LogImageRef | null => {
  const project = str(content?.projectAssetId);
  if (project) return { source: 'project', id: project };
  const style = str(content?.assetId);
  return style ? { source: 'style', id: style } : null;
};

/** 写入元素图片：先清掉两种来源，保证最多一个。 */
export const setElementImageRef = (content: Record<string, unknown>, ref: LogImageRef | null) => {
  delete content.assetId;
  delete content.projectAssetId;
  if (ref) content[ref.source === 'project' ? 'projectAssetId' : 'assetId'] = ref.id;
};

export const pageBackgroundRef = (page: LogPageSettings): LogImageRef | null => {
  if (page.backgroundProjectAssetId) return { source: 'project', id: page.backgroundProjectAssetId };
  return page.backgroundAssetId ? { source: 'style', id: page.backgroundAssetId } : null;
};

/** 写入页面背景：旧字段 backgroundAssetId 保持样式资源语义，工程素材使用新字段。 */
export const setPageBackgroundRef = (page: LogPageSettings, ref: LogImageRef | null) => {
  page.backgroundAssetId = ref?.source === 'style' ? ref.id : null;
  if (ref?.source === 'project') page.backgroundProjectAssetId = ref.id;
  else delete page.backgroundProjectAssetId;
};

export const imageRefToken = (ref: LogImageRef | null) => (ref ? `${ref.source === 'project' ? 'proj' : 'style'}:${ref.id}` : null);

export interface LogImageUsage {
  kind: 'background' | 'element';
  elementId?: string;
  elementType?: LogElementType;
  sectionId?: string;
}

/** 按来源统计图片被页面背景与元素引用的位置；未登记的 id 也会出现，便于发现悬空引用。 */
export const imageUsages = (draft: LogDraft, source: LogImageSource): Map<string, LogImageUsage[]> => {
  const out = new Map<string, LogImageUsage[]>();
  const add = (id: string, usage: LogImageUsage) => {
    const list = out.get(id) || [];
    list.push(usage);
    out.set(id, list);
  };
  const bg = pageBackgroundRef(draft.page);
  if (bg?.source === source) add(bg.id, { kind: 'background' });
  for (const e of draft.elements) {
    const ref = elementImageRef(e.content);
    if (ref?.source === source) add(ref.id, { kind: 'element', elementId: e.id, elementType: e.type, sectionId: e.anchor.sectionId });
  }
  return out;
};

export const projectAssets = (draft: LogDraft): LogProjectAsset[] => draft.assets || [];

/** 移除工程素材登记：仍被引用时拒绝（返回 false），不级联删除引用。 */
export const removeProjectAsset = (draft: LogDraft, id: string): boolean => {
  if (imageUsages(draft, 'project').has(id)) return false;
  const next = projectAssets(draft).filter((a) => a.id !== id);
  if (next.length) draft.assets = next;
  else delete draft.assets;
  return true;
};

/** 文件名 → 素材名：去扩展名、裁剪长度（服务端上限 200 字）。 */
export const projectAssetNameFromFile = (fileName: string) => {
  const base = String(fileName || '').replace(/\.[^.]+$/, '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return Array.from(base || '图片').slice(0, 80).join('');
};
