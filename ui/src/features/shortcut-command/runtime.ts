import { watch } from 'vue'
import { createDiscreteApi } from 'naive-ui'
import type { Pinia } from 'pinia'
import { chatEvent, useChatStore } from '@/stores/chat'
import { useUserStore } from '@/stores/user'
import { executeChatMessageAction, isChatMessageActionPending } from '@/utils/chatMessageActionExecutor'
import { COMPOSER_INSERT_TEXT_EVENT } from '@/utils/composerTextInsert'
import { readRichMessageActionContext } from '@/utils/richTextMessageAction'
import { SHORTCUT_MESSAGE_ACTION_CLASS, SHORTCUT_MESSAGE_ACTION_RULE_ATTR } from './messageActionEnhancer'
import { ensureShortcutRules, getEffectiveShortcutRules, resetShortcutRuleCache } from './ruleCache'
import { resolveMessageActionClick } from './ruleMatching'
import './shortcut-command.css'

// 快捷命令运行时：负责快捷消息按钮的点击（委托在 document 上，与富文本消息按钮一致）
// 以及按当前世界/用户刷新规则缓存。

let disposeInstalledRuntime: (() => void) | null = null

const unwrapStaleAction = (element: HTMLElement) => {
  const parent = element.parentNode
  if (!parent) return
  parent.replaceChild(document.createTextNode(element.textContent || ''), element)
  parent.normalize()
}

export const installShortcutCommandRuntime = ({ pinia }: { pinia: Pinia }) => {
  if (disposeInstalledRuntime || typeof document === 'undefined') {
    return disposeInstalledRuntime || (() => undefined)
  }

  const { message: notice } = createDiscreteApi(['message'])
  const chat = useChatStore(pinia)
  const user = useUserStore(pinia)

  const canLoadRules = () => !!user.info?.id

  const refreshCurrentWorld = (options: { force?: boolean } = {}) => {
    if (!canLoadRules()) return
    void ensureShortcutRules(String(chat.currentWorldId || ''), options).catch(() => undefined)
  }

  const stopUserWatch = watch(() => String(user.info?.id || ''), (next, previous) => {
    if (previous !== undefined && next !== previous) resetShortcutRuleCache()
  }, { immediate: true })
  const stopWorldWatch = watch(
    () => [String(chat.currentWorldId || ''), String(user.info?.id || ''), chat.isObserver] as const,
    () => refreshCurrentWorld(),
    { immediate: true },
  )

  const handleVisibilityChange = () => {
    if (document.visibilityState === 'visible') refreshCurrentWorld()
  }

  const handleWorldRulesUpdated = () => refreshCurrentWorld({ force: true })

  const handleClick = async (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target : null
    const action = target?.closest<HTMLElement>(`.${SHORTCUT_MESSAGE_ACTION_CLASS}[${SHORTCUT_MESSAGE_ACTION_RULE_ATTR}]`)
    if (!action || action.closest('.tiptap-editor') || isChatMessageActionPending(action)) return

    event.preventDefault()
    event.stopPropagation()
    const ruleId = action.getAttribute(SHORTCUT_MESSAGE_ACTION_RULE_ATTR) || ''
    const rule = getEffectiveShortcutRules(String(chat.currentWorldId || '')).byId.get(ruleId)
    if (!rule || rule.type !== 'message_action') {
      // 规则已删除/停用或不属于当前世界：恢复为普通文本
      unwrapStaleAction(action)
      notice.warning('该快捷按钮对应的规则已失效')
      return
    }

    if (resolveMessageActionClick(rule) === 'insert') {
      chatEvent.emit(COMPOSER_INSERT_TEXT_EVENT as any, {
        content: rule.command,
        channelId: readRichMessageActionContext(action).channelId || undefined,
      } as any)
      return
    }

    await executeChatMessageAction({
      chat,
      user,
      notice,
      content: rule.command,
      context: readRichMessageActionContext(action),
      element: action,
    })
  }

  document.addEventListener('click', handleClick)
  document.addEventListener('visibilitychange', handleVisibilityChange)
  chatEvent.on('world-shortcut-rules-updated' as any, handleWorldRulesUpdated as any)
  disposeInstalledRuntime = () => {
    document.removeEventListener('click', handleClick)
    document.removeEventListener('visibilitychange', handleVisibilityChange)
    chatEvent.off('world-shortcut-rules-updated' as any, handleWorldRulesUpdated as any)
    stopUserWatch()
    stopWorldWatch()
    disposeInstalledRuntime = null
  }
  return disposeInstalledRuntime
}
