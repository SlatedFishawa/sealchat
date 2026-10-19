// 原消息内容 → 设计预览正文。复用聊天现有的 TipTap / satori 元素解析，
// 但图片只转换为资源令牌（att:<附件ID>），由外层带权限取字节后交给隔离 iframe。
import DOMPurify from 'dompurify';
import Element from '@satorijs/element';
import { normalizeAttachmentId } from '@/composables/useAttachmentResolver';
import { renderQuickFormatHtmlFromEscaped } from '@/utils/plainQuickFormat';
import { isTipTapJson, tiptapJsonToHtml, tiptapJsonToPlainText } from '@/utils/tiptap-render';
import { contentEscape } from '@/utils/tools';

const ASSET_SCHEME = 'log-asset:';

export const attachmentToken = (value: string): string => {
  const id = normalizeAttachmentId(String(value || '').trim());
  // 只接受附件 ID；外链 URL 不进入 iframe。
  return id && /^[A-Za-z0-9_-]{4,128}$/.test(id) ? `att:${id}` : '';
};

const resolveToMarker = (value: string) => {
  const token = attachmentToken(value);
  return token ? `${ASSET_SCHEME}${token}` : '';
};

export interface RenderedBody {
  html: string;
  plainText: string;
  assets: string[];
}

const renderLegacy = (content: string): string => {
  try {
    const parts: string[] = [];
    for (const item of Element.parse(content)) {
      if (item.type === 'img') {
        const marker = resolveToMarker(String(item.attrs?.src || ''));
        parts.push(marker ? `<img src="${contentEscape(marker)}" alt="图片">` : '<span class="log-img-missing">图片不可用</span>');
        continue;
      }
      if (item.type === 'audio') {
        parts.push('<span class="log-audio">[语音]</span>');
        continue;
      }
      if (item.type === 'at') {
        const name = String(item.attrs?.name || item.attrs?.id || '用户');
        parts.push(`<span class="log-mention">@${contentEscape(name)}</span>`);
        continue;
      }
      if (item.type === 'text') {
        const raw = typeof item.attrs?.content === 'string' ? item.attrs.content : item.toString();
        parts.push(renderQuickFormatHtmlFromEscaped(contentEscape(String(raw || ''))));
        continue;
      }
      parts.push(contentEscape(item.toString()));
    }
    return parts.join('');
  } catch {
    return renderQuickFormatHtmlFromEscaped(contentEscape(content));
  }
};

const BODY_FORBID_TAGS = ['style', 'script', 'iframe', 'svg', 'math', 'form', 'input', 'button', 'video', 'audio', 'source'];
const ATTACHMENT_SRC = /^\/api\/v1\/attachment\/[A-Za-z0-9_-]{4,128}$/;

/** 聊天 TipTap、旧格式与服务端 AgentRich 的提及类名统一补上 log-mention，样式只需认一个类。 */
export const normalizeMentionClasses = (root: ParentNode) => {
  root.querySelectorAll('span.mention, span.mention-capsule').forEach((el) => el.classList.add('log-mention'));
};

/**
 * 清洗并收集资源：图片只认资源标记或站内附件路径（转为 att: 令牌），其余替换为占位。
 * src 不经 DOMPurify 的 URI 白名单（log-asset: 会被剥掉）；清洗后所有 src 都会被移除或转换。
 */
const finalizeBody = (html: string, plainText: string): RenderedBody => {
  const assets = new Set<string>();
  const frag = DOMPurify.sanitize(html, { RETURN_DOM_FRAGMENT: true, FORBID_TAGS: BODY_FORBID_TAGS, ADD_URI_SAFE_ATTR: ['src'] }) as DocumentFragment;
  frag.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') || '';
    img.removeAttribute('src');
    img.removeAttribute('srcset');
    const token = src.startsWith(ASSET_SCHEME) ? src.slice(ASSET_SCHEME.length) : ATTACHMENT_SRC.test(src) ? attachmentToken(src) : '';
    if (token) {
      img.setAttribute('data-log-asset', token);
      assets.add(token);
    } else {
      const holder = document.createElement('span');
      holder.className = 'log-img-missing';
      holder.textContent = '外链图片未嵌入';
      img.replaceWith(holder);
    }
  });
  normalizeMentionClasses(frag);
  const box = document.createElement('div');
  box.appendChild(frag);
  if (!plainText) plainText = (box.textContent || '').replace(/\s+/g, ' ').trim();
  return { html: box.innerHTML, plainText, assets: Array.from(assets) };
};

/** 将正文渲染为白名单 HTML，并收集需要的资源令牌。 */
export const renderMessageBody = (content: string): RenderedBody => {
  const raw = String(content || '');
  let html = '';
  let plainText = '';
  if (isTipTapJson(raw)) {
    html = tiptapJsonToHtml(raw, { attachmentResolver: resolveToMarker });
    try {
      plainText = tiptapJsonToPlainText(raw);
    } catch {
      plainText = '';
    }
  } else {
    html = renderLegacy(raw);
  }
  return finalizeBody(html, plainText);
};

/** 服务端展示投影（便签/线索展开）的正文：与发布版同一渲染，只在这里转换资源令牌。 */
export const renderPresentedBody = (html: string, plainText: string): RenderedBody => finalizeBody(String(html || ''), String(plainText || ''));

/** 编辑器模式：TipTap JSON 使用富文本编辑器，其他内容按原格式在文本框中编辑。 */
export const detectContentFormat = (content: string): 'tiptap' | 'plain' => (isTipTapJson(String(content || '')) ? 'tiptap' : 'plain');
