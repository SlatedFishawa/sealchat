<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, watch } from 'vue'
import { NIcon } from 'naive-ui'
import { CornerDownLeft as EnterIcon, Keyboard as KeyboardIcon } from '@vicons/tabler'
import KeywordSuggestPanel from '@/components/chat/KeywordSuggestPanel.vue'
import { matchText } from '@/utils/pinyinMatch'
import { useComposerSuggest, type ComposerSuggestOption } from '@/views/chat/composables/useComposerSuggest'
import {
  applyQuickSuggestToText,
  filterQuickSuggestCandidates,
  findQuickSuggestMatch,
  resolveQuickSuggestCandidates,
  resolveQuickSuggestSource,
  type QuickSuggestMatch,
} from './quickSuggest'
import type { ShortcutRule } from './types'

// 快速备选“试输入”：与聊天输入框使用同一套前缀识别、候选筛选、候选浮层和键盘导航，
// 只在这里的草稿中补全，不会发送任何内容。

const props = defineProps<{
  /** 当前生效的快速备选规则（personal 已覆盖同前缀 world） */
  rules: ShortcutRule[]
  /** 当前频道正在使用的人物卡属性；没有人物卡时为 null */
  attrs: Record<string, unknown> | null
  cardName: string
  /** 人物卡不可用时的说明 */
  cardUnavailableText: string
}>()

const draft = ref('')
const inputRef = ref<HTMLInputElement | null>(null)
const match = shallowRef<QuickSuggestMatch | null>(null)
const enterHint = ref(false)
let dismissedKey = ''
let enterHintTimer: ReturnType<typeof setTimeout> | undefined

const usesCard = computed(() => !!match.value && resolveQuickSuggestSource(match.value.rule) === 'character_attrs')

const suggest = useComposerSuggest({
  quick: {
    options: computed<ComposerSuggestOption[]>(() => {
      if (!match.value) return []
      const candidates = resolveQuickSuggestCandidates(match.value.rule, { characterAttrs: props.attrs })
      return filterQuickSuggestCandidates(candidates, match.value.query, matchText).map((label) => ({ id: label, label }))
    }),
    emptyText: computed(() => {
      if (!match.value || match.value.query) return ''
      if (!usesCard.value) return '没有可用候选'
      return props.cardUnavailableText || (props.attrs ? '当前人物卡没有属性' : '')
    }),
    title: computed(() => {
      if (!match.value) return ''
      const prefix = match.value.rule.trigger.trim()
      if (!usesCard.value) return `${prefix} · 快速备选`
      return `${prefix} · ${props.cardName ? `人物卡「${props.cardName}」` : '人物卡属性'}`
    }),
    apply: (option) => apply(option.label),
    dismiss: () => {
      if (match.value) dismissedKey = keyOf(match.value, draft.value.slice(0, match.value.queryEnd))
      match.value = null
    },
  },
})

const keyOf = (value: QuickSuggestMatch, beforeCursor: string) =>
  `${value.rule.id}:${value.triggerStart}:${beforeCursor.slice(value.triggerStart)}`

const evaluate = () => {
  const input = inputRef.value
  const start = input?.selectionStart ?? draft.value.length
  const end = input?.selectionEnd ?? start
  const beforeCursor = draft.value.slice(0, start)
  const next = start === end ? findQuickSuggestMatch(beforeCursor, props.rules) : null
  if (!next || keyOf(next, beforeCursor) === dismissedKey) {
    match.value = null
    suggest.close()
    return
  }
  dismissedKey = ''
  const previous = match.value
  const sameQuery = !!previous && previous.rule.id === next.rule.id
    && previous.triggerStart === next.triggerStart && previous.query === next.query
  match.value = next
  suggest.open('quick', sameQuery ? suggest.activeIndex.value : 'first')
}

const apply = (value: string) => {
  const current = match.value
  if (!current) return
  const result = applyQuickSuggestToText(draft.value, current, value)
  dismissedKey = keyOf(current, result.text.slice(0, result.cursor))
  match.value = null
  draft.value = result.text
  void nextTick(() => {
    inputRef.value?.focus()
    inputRef.value?.setSelectionRange(result.cursor, result.cursor)
  })
}

const handleKeydown = (event: KeyboardEvent) => {
  if (suggest.handleKeydown(event)) return
  if (event.key === 'Enter' && !event.isComposing) {
    // 试输入不会发送
    event.preventDefault()
    enterHint.value = true
    if (enterHintTimer) clearTimeout(enterHintTimer)
    enterHintTimer = setTimeout(() => {
      enterHint.value = false
    }, 1800)
  }
}

const handleKeyup = (event: KeyboardEvent) => {
  if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) evaluate()
}

watch(() => props.rules, () => {
  if (match.value) evaluate()
})

const placeholder = computed(() => {
  const prefix = props.rules[0]?.trigger.trim()
  return prefix ? `输入 ${prefix} 试试，选中候选只会补全文字` : '添加快速备选后可以在这里试输入'
})

/** 从规则卡片发起试输入：填入前缀并展示全部候选。 */
const tryPrefix = (prefix: string) => {
  draft.value = prefix
  dismissedKey = ''
  void nextTick(() => {
    const input = inputRef.value
    if (!input) return
    input.focus()
    input.setSelectionRange(prefix.length, prefix.length)
    evaluate()
  })
}

defineExpose({ tryPrefix })
</script>

<template>
  <div class="sc-try" :class="{ 'is-active': suggest.visible.value }">
    <div class="sc-try__label">
      <NIcon :component="KeyboardIcon" size="14" />
      <span>试输入</span>
      <small>与聊天输入框相同的补全效果</small>
    </div>
    <div class="sc-try__field">
      <KeywordSuggestPanel
        :visible="suggest.visible.value"
        :options="suggest.options.value"
        :active-index="suggest.activeIndex.value"
        :loading="suggest.loading.value"
        :empty-text="suggest.emptyText.value"
        :title="suggest.title.value"
        @select="suggest.select"
        @hover="suggest.hover"
      />
      <input
        ref="inputRef"
        v-model="draft"
        class="sc-try__input"
        type="text"
        :placeholder="placeholder"
        aria-label="试输入快速备选"
        autocomplete="off"
        @input="evaluate"
        @click="evaluate"
        @keydown="handleKeydown"
        @keyup="handleKeyup"
        @blur="suggest.close()"
      >
      <Transition name="sc-try-hint">
        <span v-if="enterHint" class="sc-try__hint" role="status">
          <NIcon :component="EnterIcon" size="12" />这里只试补全，不会发送
        </span>
      </Transition>
    </div>
  </div>
</template>

<style scoped>
.sc-try {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px 12px;
  border: 1px solid var(--sc-border-mute);
  border-radius: 14px;
  background: color-mix(in srgb, var(--sc-bg-elevated) 88%, transparent);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  box-shadow: 0 -10px 24px -18px rgba(15, 23, 42, 0.5);
  transition: border-color 0.2s ease;
}

.sc-try.is-active {
  border-color: color-mix(in srgb, var(--sc-shortcut-accent) 45%, var(--sc-border-mute));
}

.sc-try__label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--sc-shortcut-accent);
}

.sc-try__label small {
  font-weight: 400;
  color: var(--sc-text-secondary);
}

.sc-try__field {
  position: relative;
}

/* 聊天中的候选浮层依赖输入区背景，放进弹窗时给它实底 */
.sc-try__field :deep(.keyword-suggest__content) {
  background: var(--sc-bg-elevated);
  border-color: var(--sc-border-strong);
}

.sc-try__input {
  box-sizing: border-box;
  width: 100%;
  height: 38px;
  padding: 0 12px;
  border: 1px solid var(--sc-border-strong);
  border-radius: 10px;
  outline: none;
  background: var(--sc-bg-elevated);
  color: var(--sc-text-primary);
  font-family: var(--sc-code-font);
  font-size: 14px;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.sc-try__input:focus {
  border-color: var(--sc-shortcut-accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--sc-shortcut-accent) 18%, transparent);
}

.sc-try__input::placeholder {
  font-family: var(--sc-font-family);
  color: var(--sc-text-secondary);
  opacity: 0.75;
}

.sc-try__hint {
  position: absolute;
  top: 50%;
  right: 10px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--sc-chip-bg);
  color: var(--sc-text-secondary);
  font-size: 11px;
  transform: translateY(-50%);
  pointer-events: none;
}

.sc-try-hint-enter-active,
.sc-try-hint-leave-active {
  transition: opacity 0.2s ease;
}

.sc-try-hint-enter-from,
.sc-try-hint-leave-to {
  opacity: 0;
}

@media (max-width: 640px) {
  .sc-try__label small {
    display: none;
  }

  .sc-try__input {
    font-size: 16px;
  }
}
</style>
