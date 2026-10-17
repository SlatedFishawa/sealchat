// LOG 排版器 v1 wire DTO（doc/log-layout/01-contract.md）。
// 新 LOG REST 为 camelCase；消息命令仍沿用既有 snake_case 协议。

export interface LogCapabilities {
  editDraft: boolean;
  manageSources: boolean;
  manageLinks: boolean;
  publish: boolean;
  editOwnMessages: boolean;
  editOthersMessages: boolean;
  bulkAppearance: boolean;
}

export interface LogMessageCapabilities {
  edit: boolean;
  changeIdentity: boolean;
  reorder: boolean;
  revoke: boolean;
  remove: boolean;
  editAppearance: boolean;
}

export interface LogSourceSpec {
  channelId: string;
  fromTime: string | null;
  toTime: string;
  includeOoc: boolean;
  includeArchived: boolean;
  identityIds: string[];
}

export interface LogSection {
  id: string;
  title: string;
  source: LogSourceSpec;
  order: number;
}

export type LogAnchor =
  | { kind: 'sectionStart' | 'sectionEnd'; sectionId: string }
  | { kind: 'message'; sectionId: string; messageId: string; side: 'before' | 'after' };

export const LOG_ELEMENT_TYPES = [
  'cover', 'imagePlate', 'pageBreak', 'transition', 'quote',
  'prologue', 'epilogue', 'heading', 'toc', 'custom',
] as const;
export type LogElementType = typeof LOG_ELEMENT_TYPES[number];

export interface LogElement {
  id: string;
  type: LogElementType;
  anchor: LogAnchor;
  order: number;
  templateId: string;
  content: Record<string, unknown>;
  style: Record<string, unknown>;
}

export interface LogPageSettings {
  preset: 'a4' | 'a5' | 'custom';
  widthMm: number;
  heightMm: number;
  marginsMm: { top: number; right: number; bottom: number; left: number };
  gutterMm: number;
  columns: 1 | 2;
  backgroundColor: string;
  backgroundAssetId: string | null;
  fontFamily: string;
  fontSizePt: number;
  lineHeight: number;
  headerTemplateId: string | null;
  footerTemplateId: string | null;
  showPageNumbers: boolean;
  mergeNeighbors: boolean;
}

export type LogTokenValue = string | number | boolean;

export interface LogDraft {
  schemaVersion: 1;
  title: string;
  sections: LogSection[];
  elements: LogElement[];
  page: LogPageSettings;
  stylePackageId: string;
  stylePackageVersion: string;
  themeTokens: Record<string, LogTokenValue>;
}

export interface LogProjectContext {
  projectId: string;
  worldId: string;
  enabled: boolean;
  draftVersion: number;
  draft: LogDraft;
  capabilities: LogCapabilities;
  publishedReleaseId: string | null;
  management: null | { layoutSlug: string; viewSlug: string };
}

/** 设计接口返回的既有协议消息；只声明 LOG 使用到的字段。 */
export interface LogProtocolMessage {
  id: string;
  version?: number;
  channel?: { id: string; name?: string } | null;
  user?: { id: string; nick?: string; name?: string; username?: string; avatar?: string; is_bot?: boolean; isBot?: boolean } | null;
  member?: { nick?: string; name?: string } | null;
  identity?: {
    id: string;
    variantId?: string;
    sharedIdentityId?: string;
    displayName: string;
    color: string;
    avatarAttachment: string;
  } | null;
  content: string;
  createdAt: number;
  updatedAt?: number;
  displayOrder: number;
  icMode?: string;
  isWhisper?: boolean;
  isArchived?: boolean;
  isDeleted?: boolean;
  isEdited?: boolean;
  quote?: LogProtocolMessage | null;
  diceVisual?: unknown;
  sender_identity_id?: string;
  sender_identity_variant_id?: string;
  sender_member_name?: string;
}

export interface LogDesignMessage {
  message: LogProtocolMessage;
  version: number;
  capabilities: LogMessageCapabilities;
}

export interface LogMessageWindow {
  items: LogDesignMessage[];
  nextCursor: string | null;
  sourceVersion: number;
}

export type LogJobState = 'queued' | 'running' | 'done' | 'failed';

export interface LogReleaseJob {
  jobId: string;
  status: LogJobState;
  progress: { done: number; total: number };
  releaseId?: string;
  error?: { code: string; message: string };
}

export interface LogReleaseSummary {
  id: string;
  draftVersion: number;
  createdAt: string;
  status: 'active' | 'superseded' | 'withdrawn';
}

export interface LogStyleSummary {
  id: string;
  version: string;
  name: string;
  builtin: boolean;
  previewAssetId: string | null;
}

export interface LogStyleRule {
  messageType?: string;
  identityKey?: string;
  variantKey?: string;
  templateId: string;
}

export interface LogStyleAsset {
  id: string;
  path: string;
  mime: string;
  sha256: string;
}

export interface LogStylePackage {
  schemaVersion: 1;
  id: string;
  version: string;
  name: string;
  license: string;
  minRendererVersion: string;
  tokens: Record<string, LogTokenValue>;
  templates: Record<string, string>;
  css: string;
  rules: LogStyleRule[];
  settingsSchema: Record<string, unknown>;
  assets: LogStyleAsset[];
}

export interface LogPublicStylePackage {
  schemaVersion: 1;
  version: string;
  name: string;
  license: string;
  minRendererVersion: string;
  tokens: Record<string, LogTokenValue>;
  templates: Record<string, string>;
  css: string;
  rules: LogStyleRule[];
  settingsSchema: Record<string, unknown>;
  assets: Array<{ assetKey: string; mime: string; sha256: string }>;
}

export type LogPublicMessageType = 'ic' | 'ooc' | 'narration' | 'dice' | 'bot' | 'image' | 'unknown';

export interface LogPublicMessageNode {
  id: string;
  kind: 'message';
  sectionId: string;
  messageType: LogPublicMessageType;
  speaker: { key: string; name: string; color: string | null; avatarAssetKey: string | null; variantKey: string | null };
  bodyHtml: string;
  plainText: string;
  createdAt: string | null;
  quoteNodeId: string | null;
}

export interface LogPublicElementNode {
  id: string;
  kind: 'element';
  sectionId: string;
  type: LogElementType;
  templateId: string;
  content: Record<string, unknown>;
  style: Record<string, unknown>;
}

export type LogPublicNode = LogPublicMessageNode | LogPublicElementNode;

export interface LogPublicDocument {
  schemaVersion: 1;
  title: string;
  releaseId: string;
  privacyVersion: number;
  sections: Array<{ id: string; title: string }>;
  page: LogPageSettings;
  style: LogPublicStylePackage | null;
}

export interface LogPublicItems {
  releaseId: string;
  privacyVersion: number;
  items: LogPublicNode[];
  nextCursor?: string | null;
}

export interface LogPublicSearchHit {
  nodeId: string;
  sectionId: string;
  excerpt: string;
}

export interface LogAppearancePatch {
  name?: string;
  color?: string;
  avatar_attachment_id?: string;
  variant_id?: string;
}

export interface LogAppearanceSelection {
  identity_id: string | null;
  shared_identity_id: string | null;
  variant_id: string | null;
  from_time: string;
  to_time: string;
}

export interface LogAppearancePreview {
  preview_id: string;
  expires_at: string;
  matched_count: number;
  allowed_count: number;
  denied_count: number;
  samples: Array<{ message_id: string; before: Record<string, unknown>; after: Record<string, unknown> }>;
}

export interface LogMutationJob {
  jobId: string;
  status: LogJobState;
  matched: number;
  succeeded: number;
  conflicted: number;
  denied: number;
  failed: number;
  itemsCursor?: string | null;
}

export interface LogMutationJobItem {
  messageId: string;
  status: 'success' | 'conflict' | 'denied' | 'failed';
  code?: string;
}
