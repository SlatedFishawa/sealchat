import { findShortcutTriggerRanges, resolveMessageActionClick } from './ruleMatching'
import type { ShortcutRule } from './types'

// 消息显示时增强：把已渲染消息中的 message_action 触发词包装为按钮。
// 只改动当前 DOM，不改写消息正文；按钮只携带 rule id，点击时再按当前规则解析，
// 因此规则修改会自然生效，规则删除后重新渲染即恢复为普通文本。

export const SHORTCUT_MESSAGE_ACTION_CLASS = 'shortcut-message-action'
export const SHORTCUT_MESSAGE_ACTION_RULE_ATTR = 'data-shortcut-rule-id'

// 这些区域已有自己的交互/语义，不做增强（链接、按钮、代码、提及、富文本消息按钮、剧透等）
const EXCLUDED_ANCESTORS = [
  'a',
  'button',
  'code',
  'pre',
  'textarea',
  'input',
  'select',
  '[contenteditable="true"]',
  '.tiptap-message-action',
  `.${SHORTCUT_MESSAGE_ACTION_CLASS}`,
  '.mention-capsule',
  '.keyword-highlight',
  '.tiptap-spoiler',
  '.dice-chip',
  '.dice-roll-group',
  '.state-text-widget',
  '.message-quote',
  '.message-action-bar',
  '.whisper-label',
  '.no-shortcut-action',
].join(', ')

export const clearShortcutMessageActions = (root: HTMLElement) => {
  const nodes = root.querySelectorAll<HTMLElement>(`.${SHORTCUT_MESSAGE_ACTION_CLASS}[${SHORTCUT_MESSAGE_ACTION_RULE_ATTR}]`)
  const parents = new Set<Node>()
  nodes.forEach((node) => {
    const parent = node.parentNode
    if (!parent) return
    parent.replaceChild(document.createTextNode(node.textContent || ''), node)
    parents.add(parent)
  })
  parents.forEach((parent) => parent.normalize())
}

const collectTextNodes = (root: HTMLElement) => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  let current = walker.nextNode()
  while (current) {
    const parent = current.parentElement
    if (parent && current.textContent && current.textContent.trim() && !parent.closest(EXCLUDED_ANCESTORS)) {
      nodes.push(current as Text)
    }
    current = walker.nextNode()
  }
  return nodes
}

const describeRule = (rule: ShortcutRule) => (
  resolveMessageActionClick(rule) === 'insert'
    ? `插入到输入框：${rule.command}`
    : `点击发送：${rule.command}`
)

const createActionElement = (text: string, rule: ShortcutRule) => {
  const button = document.createElement('button')
  button.type = 'button'
  // no-keyword-highlight：避免术语高亮再次包裹按钮文字
  button.className = `${SHORTCUT_MESSAGE_ACTION_CLASS} ${SHORTCUT_MESSAGE_ACTION_CLASS}--${resolveMessageActionClick(rule)} no-keyword-highlight`
  button.setAttribute(SHORTCUT_MESSAGE_ACTION_RULE_ATTR, rule.id)
  button.title = describeRule(rule)
  button.textContent = text
  return button
}

/**
 * 重新应用增强：先清理旧按钮再按当前规则匹配。
 * 需在其它包裹文本的增强（如术语高亮）之前执行，以免触发词被拆到多个文本节点。
 */
export const refreshShortcutMessageActions = (
  root: HTMLElement | null,
  rules: ReadonlyMap<string, ShortcutRule>,
) => {
  if (!root) return
  clearShortcutMessageActions(root)
  if (!rules.size) return
  const triggers = Array.from(rules.keys())
  for (const node of collectTextNodes(root)) {
    const text = node.textContent || ''
    const ranges = findShortcutTriggerRanges(text, triggers)
    if (!ranges.length) continue
    const fragment = document.createDocumentFragment()
    let last = 0
    for (const range of ranges) {
      const rule = rules.get(range.trigger)
      if (!rule) continue
      if (range.start > last) fragment.appendChild(document.createTextNode(text.slice(last, range.start)))
      fragment.appendChild(createActionElement(text.slice(range.start, range.end), rule))
      last = range.end
    }
    if (last < text.length) fragment.appendChild(document.createTextNode(text.slice(last)))
    node.replaceWith(fragment)
  }
}
