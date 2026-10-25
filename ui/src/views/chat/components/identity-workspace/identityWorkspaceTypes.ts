import type { AvatarDecoration, ChannelIdentityVariant } from '@/types';
import type { TheaterPresentation, TheaterPresentationPatch } from '@/types/theaterPresentation';
import type { GeneratedAvatarStyle } from '@/utils/generatedAvatarImage';
import { resolveAttachmentUrl } from '@/composables/useAttachmentResolver';

export type IdentityVariantMatchMode = 'prefix' | 'keyword' | 'regex';

export type IdentityWorkspaceTab = 'profile' | 'variants';

export interface IdentityMatchDraft {
  config: string;
  content: string;
}

/** 频道角色资料草稿：由 chat.vue 持有生命周期（重置 / 保存），工作区就地编辑。 */
export interface IdentityProfileDraft {
  avatarTextStyle: '' | GeneratedAvatarStyle;
  displayName: string;
  color: string;
  avatarAttachmentId: string;
  avatarDecorations: AvatarDecoration[];
  theaterPresentation: TheaterPresentation | null;
  isDefault: boolean;
  isTemporary: boolean;
  botAppearanceMode: '' | 'inherit' | 'custom';
  variantResetMatchMode: IdentityVariantMatchMode;
  variantResetMatchConfig: string;
  variantResetMatchContent: string;
  icOocOnActivate: '' | 'ic' | 'ooc';
  characterCardId: string;
  promoteToShared: boolean;
}

/** 头像差分草稿：由 chat.vue 持有生命周期，工作区就地编辑。 */
export interface IdentityVariantDraft {
  selectorEmoji: string;
  matchMode: IdentityVariantMatchMode;
  matchDrafts: Record<IdentityVariantMatchMode, IdentityMatchDraft>;
  note: string;
  avatarAttachmentId: string;
  displayName: string;
  color: string;
  theaterPresentation: TheaterPresentationPatch;
  enabled: boolean;
}

/** 恢复默认规则草稿。 */
export interface IdentityVariantResetDraft {
  matchMode: IdentityVariantMatchMode;
  matchDrafts: Record<IdentityVariantMatchMode, IdentityMatchDraft>;
}

/** 传给 AvatarVue 的头像展示参数。 */
export interface IdentityWorkspaceAvatar {
  src: string;
  useTextFallback: boolean;
  textFallbackStyle: '' | GeneratedAvatarStyle;
  textFallbackAccentColor?: string;
  fallbackText: string;
}

export interface IdentityWorkspaceBadge {
  label: string;
  type: 'default' | 'info' | 'success' | 'warning';
}

export interface IdentityGeneratedAvatarStyleOption {
  style: GeneratedAvatarStyle;
  label: string;
  src: string;
}

export const identityVariantMatchModeOptions: Array<{ label: string; value: IdentityVariantMatchMode }> = [
  { label: '前缀', value: 'prefix' },
  { label: '关键词', value: 'keyword' },
  { label: '正则', value: 'regex' },
];

export const identityVariantKeywordMatchOptions = [
  { label: '任一关键词', value: 'any' },
  { label: '全部关键词', value: 'all' },
];

export const identityVariantRegexMatchOptions = [
  { label: '区分大小写', value: 'sensitive' },
  { label: '忽略大小写', value: 'insensitive' },
];

export const resolveVariantSelectorEmojiSrc = (selectorEmoji?: string) => {
  const raw = String(selectorEmoji || '').trim();
  if (!raw.startsWith('id:')) {
    return '';
  }
  return resolveAttachmentUrl(raw);
};

export const resolveVariantNote = (variant?: ChannelIdentityVariant | null) => {
  const note = String(variant?.note || '').trim();
  if (note) {
    return note;
  }
  const keyword = String(variant?.keyword || '').trim();
  if (keyword) {
    return `=${keyword}`;
  }
  return '未备注';
};

/** 将匹配规则压缩为一行可读摘要，仅用于展示。 */
export const describeIdentityMatchRule = (mode: IdentityVariantMatchMode | string | undefined, config: string, content: string) => {
  const text = String(content || '').trim();
  if (!text) return '未设置匹配内容';
  if (mode === 'keyword') {
    return `${config === 'all' ? '包含全部' : '包含任一'}：${text}`;
  }
  if (mode === 'regex') {
    return `/${text}/${config === 'insensitive' ? 'i' : ''}`;
  }
  return `${String(config || '').trim() || '='}${text}`;
};
