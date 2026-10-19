import type { ShortcutClickAction, ShortcutRule, ShortcutRuleType } from './types'

// 快捷命令的纯匹配逻辑：不依赖 Vue/DOM，供发送流程、输入提示、消息显示增强和测试共用。

export interface EffectiveShortcutRules {
  /** 已生效的规则，personal 在前、world 在后，各自按 sortOrder */
  active: ShortcutRule[]
  byId: Map<string, ShortcutRule>
  sendAlias: Map<string, ShortcutRule>
  replace: ShortcutRule[]
  messageAction: Map<string, ShortcutRule>
  /** 因同 type + trigger 的个人规则而被覆盖的世界规则 id */
  overriddenIds: Set<string>
}

export interface ShortcutTriggerRange {
  start: number
  end: number
  trigger: string
}

const ruleKey = (type: ShortcutRuleType, trigger: string) => `${type}\u0000${trigger}`

const sortRules = (rules: readonly ShortcutRule[]) => rules
  .slice()
  .sort((a, b) => (a.sortOrder - b.sortOrder) || a.id.localeCompare(b.id))

/**
 * 合并个人与世界规则：同 type + trigger 时 personal 优先于 world；
 * 停用的规则完全不参与（不会遮蔽世界规则）。同一作用域内重复时按排序取第一条。
 */
export const buildEffectiveShortcutRules = (
  personal: readonly ShortcutRule[],
  world: readonly ShortcutRule[],
): EffectiveShortcutRules => {
  const taken = new Map<string, ShortcutRule>()
  const overriddenIds = new Set<string>()
  const active: ShortcutRule[] = []
  for (const rule of [...sortRules(personal), ...sortRules(world)]) {
    const trigger = String(rule.trigger || '').trim()
    if (!rule.enabled || !trigger || !String(rule.command || '').trim()) continue
    const key = ruleKey(rule.type, trigger)
    const winner = taken.get(key)
    if (winner) {
      if (winner.scope === 'personal' && rule.scope === 'world') overriddenIds.add(rule.id)
      continue
    }
    taken.set(key, rule)
    active.push(rule)
  }
  const result: EffectiveShortcutRules = {
    active,
    byId: new Map(active.map((rule) => [rule.id, rule])),
    sendAlias: new Map(),
    replace: [],
    messageAction: new Map(),
    overriddenIds,
  }
  for (const rule of active) {
    const trigger = rule.trigger.trim()
    if (rule.type === 'send_alias') result.sendAlias.set(trigger, rule)
    else if (rule.type === 'replace') result.replace.push(rule)
    else result.messageAction.set(trigger, rule)
  }
  return result
}

export const EMPTY_EFFECTIVE_SHORTCUT_RULES: EffectiveShortcutRules = buildEffectiveShortcutRules([], [])

/** 查找文本中的触发词：左起最长、互不重叠。 */
export const findShortcutTriggerRanges = (text: string, triggers: Iterable<string>): ShortcutTriggerRange[] => {
  if (!text) return []
  const candidates: ShortcutTriggerRange[] = []
  for (const trigger of triggers) {
    if (!trigger || trigger.length > text.length) continue
    let from = 0
    while (from <= text.length - trigger.length) {
      const start = text.indexOf(trigger, from)
      if (start < 0) break
      candidates.push({ start, end: start + trigger.length, trigger })
      from = start + 1
    }
  }
  candidates.sort((a, b) => (a.start - b.start) || (b.end - a.end))
  const selected: ShortcutTriggerRange[] = []
  let cursor = 0
  for (const range of candidates) {
    if (range.start < cursor) continue
    selected.push(range)
    cursor = range.end
  }
  return selected
}

/** 单次扫描替换：替换结果不会再次参与匹配（不递归、不链式）。 */
export const replaceShortcutTriggersOnce = (text: string, mapping: ReadonlyMap<string, string>) => {
  const ranges = findShortcutTriggerRanges(text, mapping.keys())
  if (!ranges.length) return { text, replaced: false }
  let output = ''
  let last = 0
  for (const range of ranges) {
    output += text.slice(last, range.start) + (mapping.get(range.trigger) ?? range.trigger)
    last = range.end
  }
  return { text: output + text.slice(last), replaced: true }
}

// 纯文本草稿中不可改写的片段：内联图片等 [[...]] 标记与 <at .../> 提及标记
const PLAIN_PROTECTED_PATTERN = /\[\[[^\]]*\]\]|<at\s[^>]*?\/?>/gi

const replaceInPlainDraft = (draft: string, mapping: ReadonlyMap<string, string>) => {
  let replaced = false
  let output = ''
  let last = 0
  const apply = (segment: string) => {
    const result = replaceShortcutTriggersOnce(segment, mapping)
    replaced = replaced || result.replaced
    return result.text
  }
  PLAIN_PROTECTED_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = PLAIN_PROTECTED_PATTERN.exec(draft)) !== null) {
    output += apply(draft.slice(last, match.index)) + match[0]
    last = match.index + match[0].length
  }
  output += apply(draft.slice(last))
  return { text: output, replaced }
}

const isTipTapDoc = (value: string) => {
  const trimmed = value.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    const parsed = JSON.parse(trimmed)
    return parsed && typeof parsed === 'object' && parsed.type === 'doc' ? parsed : null
  } catch {
    return null
  }
}

const BLOCK_NODE_TYPES = new Set(['paragraph', 'heading', 'blockquote', 'listItem', 'codeBlock'])

/** TipTap JSON → 纯文本（段落换行），只用于判断整条输入是否等于触发词。 */
export const tiptapDocToPlainText = (doc: any): string => {
  const parts: string[] = []
  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return
    if (node.type === 'text') {
      parts.push(String(node.text || ''))
      return
    }
    if (node.type === 'hardBreak') {
      parts.push('\n')
      return
    }
    if (node.type !== 'doc' && !BLOCK_NODE_TYPES.has(node.type) && !Array.isArray(node.content)) {
      // 原子节点（提及、图片、消息按钮等）不是普通文字，使整条输入不再精确等于触发词
      parts.push('￼')
      return
    }
    ;(node.content || []).forEach(walk)
    if (BLOCK_NODE_TYPES.has(node.type)) parts.push('\n')
  }
  walk(doc)
  return parts.join('')
}

const replaceInTipTapDoc = (doc: any, mapping: ReadonlyMap<string, string>) => {
  let replaced = false
  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return
    if (node.type === 'text' && typeof node.text === 'string') {
      const result = replaceShortcutTriggersOnce(node.text, mapping)
      if (result.replaced) {
        node.text = result.text
        replaced = true
      }
      return
    }
    if (Array.isArray(node.content)) node.content.forEach(walk)
  }
  walk(doc)
  return replaced
}

export interface OutgoingShortcutResult {
  draft: string
  mode: 'plain' | 'rich'
  replaced: boolean
}

/** 查找消息正文中命中的发送映射；同一规则每条消息最多触发一次。 */
export const matchSendAliases = (
  draft: string,
  mode: 'plain' | 'rich',
  rules: EffectiveShortcutRules,
): ShortcutRule[] => {
  if (!rules.sendAlias.size) return []
  let text = draft
  if (mode === 'rich') {
    const doc = isTipTapDoc(draft)
    if (!doc) return []
    text = tiptapDocToPlainText(doc)
  } else {
    text = draft.replace(PLAIN_PROTECTED_PATTERN, '￼')
  }
  const seen = new Set<string>()
  const matched: ShortcutRule[] = []
  for (const range of findShortcutTriggerRanges(text, rules.sendAlias.keys())) {
    const rule = rules.sendAlias.get(range.trigger)
    if (!rule || seen.has(rule.id)) continue
    seen.add(rule.id)
    matched.push(rule)
  }
  return matched
}

/**
 * 发送前的快捷命令处理（发送 pipeline 的单一扩展点）：
 * replace：默认仅在 bot 命令形态中替换；单条规则可配置为同时作用普通聊天。
 */
export const resolveOutgoingShortcut = (options: {
  draft: string
  mode: 'plain' | 'rich'
  rules: EffectiveShortcutRules
  isCommandLike: (content: string) => boolean
}): OutgoingShortcutResult => {
  const { draft, mode, rules } = options
  const unchanged: OutgoingShortcutResult = { draft, mode, replaced: false }
  if (!rules.replace.length) return unchanged
  let commandLikeSource = draft
  if (mode === 'rich') {
    const doc = isTipTapDoc(draft)
    if (!doc) return unchanged
    commandLikeSource = tiptapDocToPlainText(doc)
  }
  const isCommandLike = options.isCommandLike(commandLikeSource)
  const applicableRules = isCommandLike
    ? rules.replace
    : rules.replace.filter((rule) => rule.config?.replaceInChat === true)
  if (!applicableRules.length) return unchanged
  const mapping = new Map(applicableRules.map((rule) => [rule.trigger.trim(), rule.command.trim()]))
  if (mode === 'rich') {
    const doc = isTipTapDoc(draft)
    if (!doc) return unchanged
    if (!replaceInTipTapDoc(doc, mapping)) return unchanged
    return { ...unchanged, draft: JSON.stringify(doc), replaced: true }
  }
  const result = replaceInPlainDraft(draft, mapping)
  return result.replaced ? { ...unchanged, draft: result.text, replaced: true } : unchanged
}

export const resolveMessageActionClick = (rule: ShortcutRule | null | undefined): ShortcutClickAction =>
  rule?.config?.clickAction === 'insert' ? 'insert' : 'send'

export type ShortcutComposerHintKind = 'alias-ready' | 'alias-complete' | 'replace'

export interface ShortcutComposerHint {
  id: string
  kind: ShortcutComposerHintKind
  rule: ShortcutRule
}

export const SHORTCUT_COMPOSER_HINT_LIMIT = 4

/**
 * 输入框上方的快捷命令提示：
 * - 整条输入等于 send_alias 触发词 → alias-ready（原消息发送后额外触发映射命令）；
 * - 整条输入是触发词前缀 → alias-complete（点击补全触发词）；
 * - 输入中出现当前作用域允许的 replace 触发词 → replace（发送时将被替换）。
 */
export const resolveShortcutComposerHints = (options: {
  text: string
  rules: EffectiveShortcutRules
  isCommandLike: (content: string) => boolean
  limit?: number
}): ShortcutComposerHint[] => {
  const limit = options.limit ?? SHORTCUT_COMPOSER_HINT_LIMIT
  const text = String(options.text || '').trim()
  if (!text || limit <= 0) return []
  const hints: ShortcutComposerHint[] = []
  if (!text.includes('\n')) {
    const ready = options.rules.sendAlias.get(text)
    if (ready) hints.push({ id: ready.id, kind: 'alias-ready', rule: ready })
    for (const [trigger, rule] of options.rules.sendAlias) {
      if (hints.length >= limit) break
      if (trigger !== text && trigger.startsWith(text)) hints.push({ id: rule.id, kind: 'alias-complete', rule })
    }
  }
  const hintReplaceRules = options.isCommandLike(text)
    ? options.rules.replace
    : options.rules.replace.filter((rule) => rule.config?.replaceInChat === true)
  if (hints.length < limit && hintReplaceRules.length) {
    const present = new Set(findShortcutTriggerRanges(text, hintReplaceRules.map((rule) => rule.trigger.trim()))
      .map((range) => range.trigger))
    for (const rule of hintReplaceRules) {
      if (hints.length >= limit) break
      if (present.has(rule.trigger.trim())) hints.push({ id: rule.id, kind: 'replace', rule })
    }
  }
  return hints.slice(0, limit)
}

/**
 * 把只包含部分规则的新顺序合并回完整作用域顺序：
 * 子集规则依次填回它们原先占用的位置，其余规则位置不变。
 */
export const mergeReorderedSubset = (fullIds: readonly string[], reorderedSubset: readonly string[]): string[] => {
  const subset = new Set(reorderedSubset)
  const queue = reorderedSubset.filter((id) => fullIds.includes(id))
  let index = 0
  return fullIds.map((id) => (subset.has(id) ? queue[index++] ?? id : id))
}
