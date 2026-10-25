import { createDiscreteApi } from 'naive-ui';
import type { Pinia } from 'pinia';
import { useChatStore } from '@/stores/chat';
import { useUserStore } from '@/stores/user';
import { executeChatMessageAction, isChatMessageActionPending } from './chatMessageActionExecutor';
import { MESSAGE_ACTION_DATA_ATTR } from './tiptap-message-action';

const WORLD_CONTEXT_ATTR = 'data-rich-message-world-id';
const CHANNEL_CONTEXT_ATTR = 'data-rich-message-channel-id';

let disposeInstalledRuntime: (() => void) | null = null;

export const readRichMessageActionContext = (action: HTMLElement) => {
  const context = action.closest<HTMLElement>(`[${WORLD_CONTEXT_ATTR}], [${CHANNEL_CONTEXT_ATTR}]`);
  return {
    worldId: context?.getAttribute(WORLD_CONTEXT_ATTR)?.trim() || '',
    channelId: context?.getAttribute(CHANNEL_CONTEXT_ATTR)?.trim() || '',
  };
};

export const installRichTextMessageActionRuntime = ({ pinia }: { pinia: Pinia }) => {
  if (disposeInstalledRuntime || typeof document === 'undefined') {
    return disposeInstalledRuntime || (() => undefined);
  }

  const { message: notice } = createDiscreteApi(['message']);
  const chat = useChatStore(pinia);
  const user = useUserStore(pinia);

  const handleClick = async (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    const action = target?.closest<HTMLElement>(`[${MESSAGE_ACTION_DATA_ATTR}="true"]`);
    if (!action || action.closest('.tiptap-editor') || isChatMessageActionPending(action)) return;

    event.preventDefault();
    await executeChatMessageAction({
      chat,
      user,
      notice,
      content: action.getAttribute('data-message') || '',
      context: readRichMessageActionContext(action),
      element: action,
    });
  };

  document.addEventListener('click', handleClick);
  disposeInstalledRuntime = () => {
    document.removeEventListener('click', handleClick);
    disposeInstalledRuntime = null;
  };
  return disposeInstalledRuntime;
};
