import { isBotCommandLikeContent } from '@/utils/botCommand'
import { getEffectiveShortcutRules } from './ruleCache'
import {
  matchSendAliases,
  resolveOutgoingShortcut,
  resolveShortcutComposerHints,
  type OutgoingShortcutResult,
  type ShortcutComposerHint,
} from './ruleMatching'

// 聊天输入框与快捷命令的接入点：chat.vue 只调用这里的函数，不直接处理规则细节。
// 命令形态判断复用发送流程已使用的 isBotCommandLikeContent（频道 botCommandPrefixes）。

const commandLikeChecker = (botCommandPrefixes?: unknown) =>
  (content: string) => isBotCommandLikeContent(content, botCommandPrefixes)

/** 发送前处理；未命中任何规则时返回 null，调用方保持原草稿与模式。 */
export const resolveShortcutOutgoingDraft = (
  worldId: string,
  draft: string,
  mode: 'plain' | 'rich',
  botCommandPrefixes?: unknown,
): OutgoingShortcutResult | null => {
  const result = resolveOutgoingShortcut({
    draft,
    mode,
    rules: getEffectiveShortcutRules(worldId),
    isCommandLike: commandLikeChecker(botCommandPrefixes),
  })
  return result.replaced ? result : null
}

export const resolveShortcutSendAliasesFor = (
  worldId: string,
  draft: string,
  mode: 'plain' | 'rich',
) => matchSendAliases(draft, mode, getEffectiveShortcutRules(worldId))

export const resolveShortcutComposerHintsFor = (
  worldId: string,
  text: string,
  botCommandPrefixes?: unknown,
): ShortcutComposerHint[] => resolveShortcutComposerHints({
  text,
  rules: getEffectiveShortcutRules(worldId),
  isCommandLike: commandLikeChecker(botCommandPrefixes),
})

/** 当前世界生效的快速备选规则（personal 覆盖同前缀的 world）；只用于输入补全，不进入发送流程。 */
export const resolveQuickSuggestRulesFor = (worldId: string) => getEffectiveShortcutRules(worldId).quickSuggest

// 给机器人留出读取命令消息的时间后再删除
export const SHORTCUT_AUTO_DELETE_DELAY_MS = 1500

/** send_alias 的“发送成功后自动删除命令消息”。删除失败只记录，不影响已完成的发送。 */
export const scheduleShortcutCommandAutoDelete = (
  removeMessage: (channelId: string, messageId: string) => Promise<unknown>,
  channelId: string,
  messageId: string,
  delayMs = SHORTCUT_AUTO_DELETE_DELAY_MS,
) => {
  const targetChannelId = String(channelId || '').trim()
  const targetMessageId = String(messageId || '').trim()
  if (!targetChannelId || !targetMessageId) return
  setTimeout(() => {
    removeMessage(targetChannelId, targetMessageId).catch((error) => {
      console.warn('[shortcut-command] 自动删除命令消息失败', error)
    })
  }, delayMs)
}
