export type ShortcutRuleScope = 'personal' | 'world'
export type ShortcutRuleType = 'send_alias' | 'replace' | 'message_action' | 'quick_suggest'
export type ShortcutClickAction = 'send' | 'insert'
/** quick_suggest 的候选来源：character_attrs 实时读取当前人物卡顶层属性名；custom 使用规则自带的候选 */
export type QuickSuggestSource = 'character_attrs' | 'custom'

export interface ShortcutRuleConfig {
  /** send_alias：命令消息发送成功后自动删除 */
  autoDelete?: boolean
  /** replace：除骰子/机器人命令外，也替换普通聊天正文 */
  replaceInChat?: boolean
  /** message_action：点击后立即发送或插入输入框 */
  clickAction?: ShortcutClickAction
  /** quick_suggest：候选来源 */
  source?: QuickSuggestSource
  /** quick_suggest + custom：候选列表 */
  items?: string[]
}

export interface ShortcutRule {
  id: string
  scope: ShortcutRuleScope
  worldId: string
  ownerId: string
  type: ShortcutRuleType
  trigger: string
  command: string
  config: ShortcutRuleConfig
  enabled: boolean
  sortOrder: number
  createdBy?: string
  updatedBy?: string
  updatedByName?: string
  createdAt?: string
  updatedAt?: string
}

export interface ShortcutRuleListResponse {
  personal: ShortcutRule[]
  world: ShortcutRule[]
  canManageWorld: boolean
}

export interface ShortcutRuleDraft {
  scope: ShortcutRuleScope
  type: ShortcutRuleType
  trigger: string
  command: string
  enabled: boolean
  config: ShortcutRuleConfig
}

export interface ShortcutRulePortable {
  type: ShortcutRuleType
  trigger: string
  command: string
  config: ShortcutRuleConfig
  enabled: boolean
}

export interface ShortcutRuleTransferFile {
  version: 1
  type: 'sealchat-shortcut-rules'
  personal: ShortcutRulePortable[]
  world: ShortcutRulePortable[]
}

export interface ShortcutRuleImportResult {
  importedPersonal: number
  importedWorld: number
  skippedPersonal: number
  skippedWorld: number
}

export const SHORTCUT_RULE_TYPE_LABELS: Record<ShortcutRuleType, string> = {
  send_alias: '发送映射',
  replace: '命令替换',
  message_action: '消息按钮',
  quick_suggest: '快速备选',
}

export const SHORTCUT_RULE_SCOPE_LABELS: Record<ShortcutRuleScope, string> = {
  personal: '个人',
  world: '世界',
}

export const SHORTCUT_TRIGGER_MAX_LENGTH = 64
export const SHORTCUT_COMMAND_MAX_LENGTH = 1000
export const QUICK_SUGGEST_ITEM_MAX_LENGTH = 64
export const QUICK_SUGGEST_ITEMS_MAX_COUNT = 200
