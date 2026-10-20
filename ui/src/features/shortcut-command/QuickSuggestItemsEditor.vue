<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { QUICK_SUGGEST_ITEMS_MAX_COUNT, QUICK_SUGGEST_ITEM_MAX_LENGTH } from './types'

// 快速备选的自定义候选编辑：标签式输入。回车或逗号/顿号添加，粘贴多行一次添加多项，
// 点击标签可改回文字编辑，空输入时退格删除最后一项。

const props = defineProps<{
  modelValue: string[]
}>()

const emit = defineEmits<{
  (event: 'update:modelValue', value: string[]): void
}>()

const SEPARATOR_PATTERN = /[\r\n,，、]+/

// 本地副本：同一次操作中连续修改（提交输入后再移除标签）不依赖尚未回流的 props
const items = ref<string[]>(props.modelValue.slice())
watch(() => props.modelValue, (value) => {
  items.value = value.slice()
})
const update = (next: string[]) => {
  items.value = next
  emit('update:modelValue', next)
}

const pending = ref('')
const inputRef = ref<HTMLInputElement | null>(null)
const flashItem = ref('')
const notice = ref('')
let flashTimer: ReturnType<typeof setTimeout> | undefined

const full = computed(() => items.value.length >= QUICK_SUGGEST_ITEMS_MAX_COUNT)

const flash = (item: string, message = '') => {
  flashItem.value = item
  notice.value = message
  if (flashTimer) clearTimeout(flashTimer)
  flashTimer = setTimeout(() => {
    flashItem.value = ''
    notice.value = ''
  }, 1600)
}

/** 添加若干候选；返回未能添加的剩余文字（超长时保留在输入框里） */
const addItems = (raw: string) => {
  const next = items.value.slice()
  let duplicate = ''
  let rest = ''
  for (const part of raw.split(SEPARATOR_PATTERN)) {
    const item = part.trim()
    if (!item) continue
    if (item.length > QUICK_SUGGEST_ITEM_MAX_LENGTH) {
      rest = item
      notice.value = `每个候选最多 ${QUICK_SUGGEST_ITEM_MAX_LENGTH} 个字`
      continue
    }
    if (next.includes(item)) {
      duplicate = item
      continue
    }
    if (next.length >= QUICK_SUGGEST_ITEMS_MAX_COUNT) {
      notice.value = `最多 ${QUICK_SUGGEST_ITEMS_MAX_COUNT} 个候选`
      break
    }
    next.push(item)
  }
  if (next.length !== items.value.length) update(next)
  if (duplicate) flash(duplicate, `「${duplicate}」已在列表中`)
  return rest
}

const commitPending = () => {
  if (!pending.value.trim()) {
    pending.value = ''
    return
  }
  pending.value = addItems(pending.value)
}

const removeAt = (index: number) => {
  const next = items.value.slice()
  next.splice(index, 1)
  update(next)
}

const editAt = (index: number) => {
  const item = items.value[index]
  commitPending()
  removeAt(items.value.indexOf(item))
  pending.value = item
  void nextTick(() => inputRef.value?.focus())
}

const handleKeydown = (event: KeyboardEvent) => {
  if (event.isComposing) return
  if (event.key === 'Enter') {
    // 不触发外层编辑器的“回车保存”
    event.preventDefault()
    event.stopPropagation()
    commitPending()
    return
  }
  if (event.key === 'Backspace' && !pending.value && items.value.length) {
    event.preventDefault()
    editAt(items.value.length - 1)
  }
}

const handleInput = () => {
  if (SEPARATOR_PATTERN.test(pending.value)) commitPending()
}

const handlePaste = (event: ClipboardEvent) => {
  const text = event.clipboardData?.getData('text/plain') || ''
  if (!SEPARATOR_PATTERN.test(text)) return
  event.preventDefault()
  pending.value = addItems(`${pending.value}${text}`)
}

defineExpose({ commitPending })
</script>

<template>
  <div class="sc-items" :class="{ 'is-full': full }" @click.self="inputRef?.focus()">
    <TransitionGroup tag="ul" name="sc-chip" class="sc-items__list" aria-label="候选列表">
      <li
        v-for="(item, index) in items"
        :key="item"
        class="sc-items__chip"
        :class="{ 'is-flash': flashItem === item }"
      >
        <button type="button" class="sc-items__chip-text" :title="`编辑「${item}」`" @click="editAt(index)">{{ item }}</button>
        <button type="button" class="sc-items__chip-remove" :aria-label="`移除「${item}」`" @click="removeAt(index)">×</button>
      </li>
      <li key="__input" class="sc-items__input-cell">
        <input
          ref="inputRef"
          v-model="pending"
          class="sc-items__input"
          type="text"
          :maxlength="QUICK_SUGGEST_ITEM_MAX_LENGTH * 4"
          :disabled="full"
          :placeholder="items.length ? '继续添加…' : '输入候选后回车，或粘贴多行'"
          aria-label="添加候选"
          @keydown="handleKeydown"
          @input="handleInput"
          @paste="handlePaste"
          @blur="commitPending"
        >
      </li>
    </TransitionGroup>
    <div class="sc-items__foot">
      <span class="sc-items__notice" role="status">{{ notice || '回车、逗号或顿号分隔；点击标签可修改' }}</span>
      <span class="sc-items__count">{{ items.length }} / {{ QUICK_SUGGEST_ITEMS_MAX_COUNT }}</span>
    </div>
  </div>
</template>

<style scoped>
.sc-items {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border: 1px solid var(--sc-border-strong);
  border-radius: 10px;
  background: var(--sc-bg-elevated);
  cursor: text;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.sc-items:focus-within {
  border-color: var(--sc-shortcut-accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--sc-shortcut-accent) 18%, transparent);
}

.sc-items__list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-height: 180px;
  margin: 0;
  /* 留出上下余量，避免行内文字基线把单行列表撑出滚动条 */
  padding: 2px 0;
  overflow-y: auto;
  list-style: none;
  scrollbar-width: thin;
}

.sc-items__chip {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  border-radius: 999px;
  background: color-mix(in srgb, var(--sc-shortcut-accent) 12%, transparent);
  color: var(--sc-text-primary);
  font-size: 12.5px;
  line-height: 24px;
  transition: background-color 0.2s ease, box-shadow 0.2s ease;
}

.sc-items__chip.is-flash {
  background: color-mix(in srgb, #f59e0b 26%, transparent);
  box-shadow: 0 0 0 1px #f59e0b;
}

.sc-items__chip button {
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.sc-items__chip-text {
  max-width: 14em;
  padding: 0 2px 0 10px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sc-items__chip-remove {
  width: 22px;
  height: 22px;
  margin-right: 2px;
  border-radius: 999px;
  color: var(--sc-text-secondary) !important;
  line-height: 1;
}

.sc-items__chip-remove:hover {
  background: color-mix(in srgb, #ef4444 14%, transparent);
  color: #ef4444 !important;
}

.sc-items__input-cell {
  display: inline-flex;
  flex: 1 1 8em;
  min-width: 8em;
}

.sc-items__input {
  width: 100%;
  height: 24px;
  padding: 0 4px;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--sc-text-primary);
  font: inherit;
  font-size: 13px;
}

.sc-items__foot {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 11px;
  color: var(--sc-text-secondary);
}

.sc-items__count {
  flex: 0 0 auto;
  font-variant-numeric: tabular-nums;
}

.sc-items.is-full .sc-items__count {
  color: #f59e0b;
}

.sc-chip-enter-active,
.sc-chip-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}

.sc-chip-enter-from,
.sc-chip-leave-to {
  opacity: 0;
  transform: scale(0.85);
}

@media (prefers-reduced-motion: reduce) {
  .sc-chip-enter-active,
  .sc-chip-leave-active {
    transition: none;
  }
}
</style>
