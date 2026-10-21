// LOG 图片素材层：当前工程素材登记、样式只读图片、引用统计、现场上传与缩略图。
// 文件本体复用聊天附件上传；登记写入草稿（draft.assets），由草稿保存统一落盘与校验。
import { computed, ref, shallowReactive, watch, type Ref } from 'vue';
import { useMessage } from 'naive-ui';
import type { LogDraft, LogProjectAsset, LogStyleAsset, LogStylePackage } from '@/types/log';
import { uploadImageAttachment } from '@/views/chat/composables/useAttachmentUploader';
import { packageImageAssets, uuid } from '../logDraftOps';
import {
  imageRefToken,
  imageUsages,
  projectAssetNameFromFile,
  projectAssets as draftProjectAssets,
  removeProjectAsset,
  type LogImageRef,
  type LogImageUsage,
} from '../logAssetRefs';

/** 发布快照只解码这三种格式；GIF/AVIF 等在设计态能显示但发布会失败，上传时直接拒绝。 */
export const LOG_PROJECT_IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp';
const ACCEPTED = new Set(LOG_PROJECT_IMAGE_ACCEPT.split(','));

interface AssetHost {
  seed: (token: string, data: ArrayBuffer, mime: string) => void;
  objectUrl: (token: string) => Promise<string | null>;
}

export interface LogImageInfo {
  name: string;
  /** 来源说明：工程素材 / 样式资源。 */
  sourceLabel: string;
  /** 引用指向的素材已不存在（登记被移除或不在当前样式包中）。 */
  missing: boolean;
}

export const useLogAssetLibrary = (options: {
  draft: Ref<LogDraft>;
  update: (mutate: (d: LogDraft) => void) => boolean;
  stylePackage: () => LogStylePackage | null;
  canEdit: () => boolean;
  assets: AssetHost;
}) => {
  const toast = useMessage();
  const projectAssets = computed<LogProjectAsset[]>(() => draftProjectAssets(options.draft.value));
  const styleImages = computed<LogStyleAsset[]>(() => packageImageAssets(options.stylePackage()));
  const projectUsages = computed<Map<string, LogImageUsage[]>>(() => imageUsages(options.draft.value, 'project'));
  const styleUsages = computed<Map<string, LogImageUsage[]>>(() => imageUsages(options.draft.value, 'style'));
  const canEdit = computed(() => options.canEdit());
  const uploading = ref(0);

  /** 上传一张图片并登记为当前工程素材；返回可直接写入引用的 ref，失败时提示并返回 null。 */
  const upload = async (file: File): Promise<LogImageRef | null> => {
    if (!canEdit.value) return null;
    if (!ACCEPTED.has(file.type)) {
      toast.error('只支持 PNG / JPEG / WebP 图片');
      return null;
    }
    uploading.value += 1;
    try {
      const [{ attachmentId }, bytes] = await Promise.all([
        uploadImageAttachment(file, { channelId: null }),
        file.arrayBuffer(),
      ]);
      const asset: LogProjectAsset = { id: uuid(), attachmentId: attachmentId.replace(/^id:/, ''), name: projectAssetNameFromFile(file.name) };
      // 先用本地字节预置资源缓存，草稿保存前预览与缩略图即可显示。
      options.assets.seed(`proj:${asset.id}`, bytes, file.type);
      const ok = options.update((d) => {
        d.assets = [...draftProjectAssets(d), asset];
      });
      if (!ok) {
        toast.error('草稿存在冲突，图片未登记');
        return null;
      }
      return { source: 'project', id: asset.id };
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : '上传失败');
      return null;
    } finally {
      uploading.value -= 1;
    }
  };

  /** 只移除工程登记关系；仍被引用时拒绝并说明，不触碰附件本体。 */
  const remove = (id: string): boolean => {
    const used = projectUsages.value.get(id)?.length || 0;
    if (used) {
      toast.warning(`该素材正被 ${used} 处使用，请先替换或清除这些引用`);
      return false;
    }
    let removed = false;
    options.update((d) => {
      removed = removeProjectAsset(d, id);
    });
    return removed;
  };

  const describe = (image: LogImageRef): LogImageInfo => {
    if (image.source === 'project') {
      const asset = projectAssets.value.find((a) => a.id === image.id);
      return { name: asset ? asset.name || '未命名图片' : '已移除的素材', sourceLabel: '工程素材', missing: !asset };
    }
    const asset = styleImages.value.find((a) => a.id === image.id);
    return { name: asset ? asset.path.replace(/^assets\//, '') : image.id, sourceLabel: '样式资源', missing: !asset };
  };

  // 缩略图：样式令牌按包版本区分，切换样式后不会复用旧包的 Blob URL。
  const thumbs = shallowReactive(new Map<string, string | null>());
  const requested = new Set<string>();
  let generation = 0;
  // 宿主在样式包变化时回收 style: 的 Blob URL（含预览后切回同一版本），这里同步丢弃旧条目。
  watch(() => options.stylePackage(), () => {
    generation += 1;
    for (const key of Array.from(requested)) {
      if (!key.includes('|')) continue;
      requested.delete(key);
      thumbs.delete(key);
    }
  });
  const thumbKey = (token: string) => {
    if (!token.startsWith('style:')) return token;
    const pkg = options.stylePackage();
    return pkg ? `${pkg.id}@${pkg.version}|${token}` : '';
  };
  const thumb = (image: LogImageRef | null): string | null => {
    const token = imageRefToken(image);
    const key = token ? thumbKey(token) : '';
    if (!token || !key) return null;
    if (!requested.has(key)) {
      requested.add(key);
      // 渲染期间只登记请求，加载在渲染之后进行。
      const current = generation;
      queueMicrotask(() => {
        void options.assets.objectUrl(token).then((url) => {
          if (current === generation || !key.includes('|')) thumbs.set(key, url);
        });
      });
    }
    return thumbs.get(key) || null;
  };

  return { projectAssets, styleImages, projectUsages, styleUsages, canEdit, uploading, upload, remove, describe, thumb };
};

export type LogAssetLibrary = ReturnType<typeof useLogAssetLibrary>;

/** 引用位置的简短描述（素材面板与删除提示共用）。 */
export const describeImageUsage = (usage: LogImageUsage, labels: Record<string, string>) =>
  usage.kind === 'background' ? '页面背景' : labels[usage.elementType || ''] || String(usage.elementType || '元素');
