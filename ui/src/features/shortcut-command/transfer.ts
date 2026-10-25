import type { ShortcutRule, ShortcutRulePortable, ShortcutRuleTransferFile } from './types'

export const SHORTCUT_RULE_TRANSFER_TYPE = 'sealchat-shortcut-rules' as const
export const SHORTCUT_RULE_TRANSFER_VERSION = 1 as const

const portableRule = (rule: ShortcutRule): ShortcutRulePortable => ({
  type: rule.type,
  trigger: rule.trigger,
  command: rule.command,
  config: { ...(rule.config || {}) },
  enabled: rule.enabled,
})

export const buildShortcutRuleTransferFile = (personal: ShortcutRule[], world: ShortcutRule[]): ShortcutRuleTransferFile => ({
  version: SHORTCUT_RULE_TRANSFER_VERSION,
  type: SHORTCUT_RULE_TRANSFER_TYPE,
  personal: personal.map(portableRule),
  world: world.map(portableRule),
})

export const parseShortcutRuleTransferFile = (raw: string): ShortcutRuleTransferFile => {
  const value = JSON.parse(raw)
  if (value?.version !== SHORTCUT_RULE_TRANSFER_VERSION || value?.type !== SHORTCUT_RULE_TRANSFER_TYPE) {
    throw new Error('不是受支持的 SealChat 快捷命令文件')
  }
  if (!Array.isArray(value.personal) || !Array.isArray(value.world)) {
    throw new Error('快捷命令文件结构不完整')
  }
  return value as ShortcutRuleTransferFile
}
