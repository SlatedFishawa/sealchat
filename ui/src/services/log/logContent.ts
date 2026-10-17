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
  const assets = new Set<string>();
  const frag = DOMPurify.sanitize(html, { RETURN_DOM_FRAGMENT: true, FORBID_TAGS: ['style', 'script', 'iframe', 'svg', 'math', 'form', 'input', 'button', 'video', 'audio', 'source'] }) as DocumentFragment;
  frag.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') || '';
    img.removeAttribute('src');
    img.removeAttribute('srcset');
    if (src.startsWith(ASSET_SCHEME)) {
      const token = src.slice(ASSET_SCHEME.length);
      img.setAttribute('data-log-asset', token);
      assets.add(token);
    } else {
      const holder = document.createElement('span');
      holder.className = 'log-img-missing';
      holder.textContent = '外链图片未嵌入';
      img.replaceWith(holder);
    }
  });
  const box = document.createElement('div');
  box.appendChild(frag);
  if (!plainText) plainText = (box.textContent || '').replace(/\s+/g, ' ').trim();
  return { html: box.innerHTML, plainText, assets: Array.from(assets) };
};

/** 编辑器模式：TipTap JSON 使用富文本编辑器，其他内容按原格式在文本框中编辑。 */
export const detectContentFormat = (content: string): 'tiptap' | 'plain' => (isTipTapJson(String(content || '')) ? 'tiptap' : 'plain');
