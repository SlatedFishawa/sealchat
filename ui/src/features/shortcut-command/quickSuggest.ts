import type { Editor } from '@tiptap/core'
import { spliceTextAtSelection } from '@/utils/composerTextInsert'
import type { QuickSuggestSource, ShortcutRule } from './types'

// 快速备选（quick_suggest）的纯逻辑：输入前缀识别、候选来源解析、筛选与替换范围。
// 只修改输入框内容，不参与任何发送流程。人物卡 Store 与输入框 DOM/编辑器操作留在调用层。

/** 前缀后的查询最长字符数；超过视为普通输入 */
export const QUICK_SUGGEST_QUERY_MAX_LENGTH = 32
/** 候选浮层最多展示的条数 */
export const QUICK_SUGGEST_RESULT_LIMIT = 50

/** 富文本中的原子节点（提及、图片等）在纯文本里的占位字符：每个节点恰好占一个位置 */
const RICH_ATOM_PLACEHOLDER = '￼'

export const resolveQuickSuggestSource = (rule: Pick<ShortcutRule, 'config'> | null | undefined): QuickSuggestSource =>
  rule?.config?.source === 'custom' ? 'custom' : 'character_attrs'

/** 自定义候选：去空白、去空项、去重，保持原顺序。 */
export const normalizeQuickSuggestItems = (raw: unknown): string[] => {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const items: string[] = []
  for (const value of raw) {
    if (typeof value !== 'string') continue
    const item = value.trim()
    if (!item || /[\r\n]/.test(item) || seen.has(item)) continue
    seen.add(item)
    items.push(item)
  }
  return items
}

/** 人物卡属性：第一版只取 attrs 的顶层属性名，不展开内部对象路径。 */
export const readCharacterAttrNames = (attrs: unknown): string[] => {
  if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) return []
  return Object.keys(attrs).filter((key) => !!key.trim() && !/[\r\n]/.test(key))
}

/** 规则当前的候选；character_attrs 每次从调用方传入的实时 attrs 读取。 */
export const resolveQuickSuggestCandidates = (
  rule: Pick<ShortcutRule, 'config'>,
  context: { characterAttrs?: unknown } = {},
): string[] => (
  resolveQuickSuggestSource(rule) === 'custom'
    ? normalizeQuickSuggestItems(rule.config?.items)
    : readCharacterAttrNames(context.characterAttrs)
)

export interface QuickSuggestMatch {
  rule: ShortcutRule
  /** 前缀在文本中的起点 */
  triggerStart: number
  /** 查询起点（前缀之后跳过用户输入的空白），选择候选时从这里替换 */
  queryStart: number
  /** 查询终点，即光标位置 */
  queryEnd: number
  query: string
}

const isPrefixBoundary = (text: string, index: number, lineStart: number) =>
  index === lineStart || /\s/.test(text[index - 1] || '')

const matchPrefixAt = (text: string, index: number, prefix: string, lineStart: number) => {
  if (!isPrefixBoundary(text, index, lineStart)) return null
  const rest = text.slice(index + prefix.length)
  const query = rest.trimStart()
  // 查询里出现空白说明用户已经输完候选、在继续写参数
  if (/\s/.test(query) || query.length > QUICK_SUGGEST_QUERY_MAX_LENGTH) return null
  return { queryStart: text.length - query.length, query }
}

/**
 * 在光标前的文本中查找生效的快速备选前缀（只看光标所在行）。
 * 前缀必须位于行首或空白之后；前缀与查询之间的空白保留用户原样，不强制追加。
 * 多个前缀同时成立时：离光标最近的起点优先，起点相同时更长的前缀优先，再按规则顺序。
 */
export const findQuickSuggestMatch = (
  textBeforeCursor: string,
  rules: readonly ShortcutRule[],
): QuickSuggestMatch | null => {
  const text = String(textBeforeCursor || '')
  if (!text || !rules.length) return null
  const lineStart = text.lastIndexOf('\n') + 1
  let best: QuickSuggestMatch | null = null
  for (const rule of rules) {
    const prefix = String(rule.trigger || '').trim()
    if (!prefix) continue
    let index = text.lastIndexOf(prefix)
    while (index >= lineStart) {
      const matched = matchPrefixAt(text, index, prefix, lineStart)
      if (matched) {
        const candidate: QuickSuggestMatch = { rule, triggerStart: index, queryEnd: text.length, ...matched }
        if (!best
          || candidate.triggerStart > best.triggerStart
          || (candidate.triggerStart === best.triggerStart && prefix.length > best.rule.trigger.trim().length)) {
          best = candidate
        }
        break
      }
      if (index === 0) break
      index = text.lastIndexOf(prefix, index - 1)
    }
  }
  return best
}

export interface ComposerSuggestTrigger {
  /** 触发起点到光标的字符数 */
  distance: number
  triggerLength: number
}

/**
 * 多个候选来源（世界术语、快速备选）同时触发时的确定性选择：
 * 离光标最近者优先；起点相同时更长的触发优先；仍相同则数组中靠前者优先。
 */
export const pickComposerSuggestTrigger = <T extends ComposerSuggestTrigger>(candidates: ReadonlyArray<T | null | undefined>): T | null => {
  let best: T | null = null
  for (const candidate of candidates) {
    if (!candidate) continue
    if (!best
      || candidate.distance < best.distance
      || (candidate.distance === best.distance && candidate.triggerLength > best.triggerLength)) {
      best = candidate
    }
  }
  return best
}

/**
 * 候选筛选：成员判断复用调用方传入的文本匹配器（聊天中为拼音匹配 matchText），
 * 排序为完全相同 > 前缀 > 包含 > 仅拼音命中，同级保持候选原顺序。空查询返回全部候选。
 */
export const filterQuickSuggestCandidates = (
  items: readonly string[],
  query: string,
  matcher: (query: string, text: string) => boolean,
  limit = QUICK_SUGGEST_RESULT_LIMIT,
): string[] => {
  const keyword = String(query || '').trim()
  if (!keyword) return items.slice(0, limit)
  const lower = keyword.toLowerCase()
  const rank = (item: string) => {
    const value = item.toLowerCase()
    if (value === lower) return 0
    if (value.startsWith(lower)) return 1
    if (value.includes(lower)) return 2
    return 3
  }
  return items
    .filter((item) => matcher(keyword, item))
    .map((item, index) => ({ item, index, rank: rank(item) }))
    .sort((a, b) => (a.rank - b.rank) || (a.index - b.index))
    .slice(0, limit)
    .map((entry) => entry.item)
}

/** 纯文本输入：只替换查询部分，返回新文本与插入内容末尾的光标。 */
export const applyQuickSuggestToText = (
  text: string,
  match: Pick<QuickSuggestMatch, 'queryStart' | 'queryEnd'>,
  value: string,
) => spliceTextAtSelection(text, { start: match.queryStart, end: match.queryEnd }, value)

type RichEditorLike = Pick<Editor, 'state' | 'chain'>

export interface RichTextBeforeCursor {
  text: string
  /** 光标所在文本块内容的起始文档位置；text 下标 + blockStart 即文档位置 */
  blockStart: number
}

/** 富文本：读取光标所在文本块中光标之前的文字；有选区时返回 null。 */
export const readRichTextBeforeCursor = (editor: RichEditorLike | null | undefined): RichTextBeforeCursor | null => {
  const selection = editor?.state?.selection
  if (!selection || !selection.empty) return null
  const { $from } = selection
  if (!$from.parent.isTextblock) return null
  const text = $from.parent.textBetween(0, $from.parentOffset, undefined, (node) => (
    node.type.name === 'hardBreak' ? '\n' : RICH_ATOM_PLACEHOLDER
  ))
  return { text, blockStart: $from.start() }
}

/** 富文本：用编辑器事务把查询替换为候选纯文本，并把光标折叠到插入内容末尾。 */
export const applyQuickSuggestToRichEditor = (
  editor: RichEditorLike,
  context: Pick<RichTextBeforeCursor, 'blockStart'>,
  match: Pick<QuickSuggestMatch, 'queryStart' | 'queryEnd'>,
  value: string,
) => {
  const from = context.blockStart + match.queryStart
  const to = context.blockStart + match.queryEnd
  editor.chain()
    .focus()
    .command(({ tr }) => {
      tr.insertText(value, from, to)
      return true
    })
    .setTextSelection(from + value.length)
    .run()
}
