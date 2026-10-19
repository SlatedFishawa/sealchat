import type { useChatStore } from '@/stores/chat';
import type { useUserStore } from '@/stores/user';
import { isPrivateChatChannel } from './channelSendPermission';

// 消息按钮类交互（富文本 messageAction、快捷消息按钮等）共享的发送执行器：
// 校验频道上下文、旁观/只读、连接状态与发送权限，再以当前身份、差分和 IC/OOC 发送。

export interface ChatMessageActionNotice {
  warning: (content: string) => unknown;
  error: (content: string) => unknown;
}

export interface ChatMessageActionContext {
  /** 按钮所在内容声明的世界/频道；为空表示使用当前频道 */
  worldId?: string;
  channelId?: string;
}

export interface ExecuteChatMessageActionOptions {
  chat: ReturnType<typeof useChatStore>;
  user: ReturnType<typeof useUserStore>;
  notice: ChatMessageActionNotice;
  content: string;
  context?: ChatMessageActionContext;
  /** 可选发送上下文；快捷发送映射用它保持原消息的身份/场内外/悄悄话语义。 */
  identityId?: string | null;
  identityVariantId?: string;
  icMode?: 'ic' | 'ooc';
  whisperTargetIds?: string[];
  /** 触发元素：发送期间加锁并标记 aria-disabled，防止重复点击 */
  element?: HTMLElement | null;
}

const pendingElements = new WeakSet<HTMLElement>();

export const isChatMessageActionPending = (element: HTMLElement | null | undefined) =>
  !!element && pendingElements.has(element);

export const executeChatMessageAction = async ({
  chat,
  user,
  notice,
  content: rawContent,
  context,
  identityId: identityIdOverride,
  identityVariantId: identityVariantIdOverride,
  icMode: icModeOverride,
  whisperTargetIds,
  element,
}: ExecuteChatMessageActionOptions): Promise<Record<string, any> | null> => {
  const content = String(rawContent || '').trim();
  if (!content) {
    notice.warning('消息按钮没有可发送内容');
    return null;
  }
  if (content.length > 10000) {
    notice.error('消息过长，无法发送');
    return null;
  }

  const currentWorldId = String(chat.currentWorldId || '').trim();
  const currentChannelId = String(chat.curChannel?.id || '').trim();
  const expectedWorldId = String(context?.worldId || '').trim();
  const expectedChannelId = String(context?.channelId || '').trim();
  if (!currentWorldId || !currentChannelId
    || (expectedWorldId && expectedWorldId !== currentWorldId)
    || (expectedChannelId && expectedChannelId !== currentChannelId)) {
    notice.warning('当前页面没有有效频道上下文，无法发送');
    return null;
  }
  if (chat.isObserver || chat.observerMode || !user.info.id) {
    notice.warning('当前用户不可发送消息');
    return null;
  }
  if (chat.connectState !== 'connected') {
    notice.error('尚未连接，无法发送消息');
    return null;
  }

  if (element) {
    pendingElements.add(element);
    element.setAttribute('aria-disabled', 'true');
  }
  try {
    const allowed = isPrivateChatChannel(chat.curChannel)
      || await chat.hasChannelPermission(currentChannelId, 'func_channel_text_send', user.info.id);
    if (!allowed) {
      notice.warning('当前频道不允许发送消息');
      return null;
    }
    if (String(chat.currentWorldId || '').trim() !== currentWorldId
      || String(chat.curChannel?.id || '').trim() !== currentChannelId
      || chat.isObserver || chat.observerMode) {
      notice.warning('频道上下文已变化，消息未发送');
      return null;
    }

    const identityId = identityIdOverride !== undefined
      ? identityIdOverride
      : (chat.getActiveIdentityId(currentChannelId) || null);
    const identityVariantId = identityVariantIdOverride !== undefined
      ? identityVariantIdOverride
      : (identityId ? chat.getActiveIdentityVariantId(currentChannelId, identityId) : undefined);
    const whisperIds = Array.isArray(whisperTargetIds)
      ? whisperTargetIds.map((id) => String(id || '').trim()).filter(Boolean)
      : [];
    const sent = await chat.messageCreate(
      content,
      undefined,
      whisperIds[0],
      undefined,
      identityId,
      undefined,
      whisperIds,
      undefined,
      undefined,
      identityVariantId,
      icModeOverride || (chat.icMode === 'ooc' ? 'ooc' : 'ic'),
      currentChannelId,
    );
    if (!sent) throw new Error('message.create returned empty result');
    return sent as Record<string, any>;
  } catch (error) {
    notice.error(`发送失败：${error instanceof Error ? error.message : '未知错误'}`);
    return null;
  } finally {
    if (element) {
      pendingElements.delete(element);
      element.removeAttribute('aria-disabled');
    }
  }
};
