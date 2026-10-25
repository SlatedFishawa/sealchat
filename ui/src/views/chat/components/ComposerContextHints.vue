<script setup lang="ts">
export interface ComposerEmojiHintView {
  id: string
  src: string
  label: string
}

export interface ComposerVariantHintView {
  id: string
  src: string
  label: string
  title: string
}

export interface ComposerShortcutHintView {
  id: string
  /** alias-ready：发送后额外触发映射；alias-complete：点击补全触发词；replace：发送时替换（仅提示） */
  kind: 'alias-ready' | 'alias-complete' | 'replace'
  trigger: string
  command: string
  scope: 'personal' | 'world'
}

const describeShortcutHint = (item: ComposerShortcutHintView) => {
  const source = item.scope === 'personal' ? '个人' : '世界'
  if (item.kind === 'alias-ready') return `${source}快捷命令：保留原消息并额外发送「${item.command}」，点击立即发送`
  if (item.kind === 'alias-complete') return `${source}快捷命令：点击补全「${item.trigger}」，发送后额外触发「${item.command}」`
  return `${source}命令替换：发送时「${item.trigger}」将替换为「${item.command}」`
}

withDefaults(defineProps<{
  emojiItems?: ComposerEmojiHintView[]
  variantItems?: ComposerVariantHintView[]
  shortcutItems?: ComposerShortcutHintView[]
  activeVariantId?: string
  showReset?: boolean
  position?: 'left' | 'center' | 'right'
  sizePercent?: number
}>(), {
  emojiItems: () => [],
  variantItems: () => [],
  shortcutItems: () => [],
  activeVariantId: '',
  showReset: false,
  position: 'center',
  sizePercent: 115,
})

const buildSizeStyle = (percent: number): Record<string, string> => {
  const ratio = Math.min(1.5, Math.max(0.85, Number(percent) / 100 || 1.15))
  return {
    '--composer-hints-panel-height': `${40 * ratio}px`,
    '--composer-hints-item-size': `${32 * ratio}px`,
    '--composer-hints-emoji-size': `${28 * ratio}px`,
    '--composer-hints-variant-size': `${26 * ratio}px`,
    '--composer-hints-label-size': `${12 * ratio}px`,
  }
}

const emit = defineEmits<{
  (event: 'select-emoji', id: string): void
  (event: 'select-variant', id: string): void
  (event: 'reset-variant'): void
  (event: 'select-shortcut', id: string): void
}>()
</script>

<template>
  <div
    v-if="emojiItems.length || variantItems.length || shortcutItems.length"
    class="composer-context-hints"
    :class="`composer-context-hints--${position}`"
    :style="buildSizeStyle(sizePercent)"
    role="toolbar"
    aria-label="输入快捷提示"
    @mousedown.prevent
  >
    <div v-if="shortcutItems.length" class="composer-context-hints__group">
      <button
        v-for="item in shortcutItems"
        :key="`${item.kind}:${item.id}`"
        type="button"
        class="composer-context-hints__item composer-context-hints__item--shortcut"
        :class="`is-${item.kind}`"
        :title="describeShortcutHint(item)"
        :aria-label="describeShortcutHint(item)"
        :aria-disabled="item.kind === 'replace' ? 'true' : undefined"
        @mousedown.prevent="item.kind !== 'replace' && emit('select-shortcut', item.id)"
      >
        <span v-if="item.kind !== 'alias-ready'" class="composer-context-hints__shortcut-from">{{ item.trigger }}</span>
        <span class="composer-context-hints__shortcut-arrow" aria-hidden="true">{{ item.kind === 'alias-ready' ? '↵' : '→' }}</span>
        <span class="composer-context-hints__shortcut-to">{{ item.command }}</span>
      </button>
    </div>
    <div v-if="emojiItems.length" class="composer-context-hints__group">
      <button
        v-for="item in emojiItems"
        :key="item.id"
        type="button"
        class="composer-context-hints__item composer-context-hints__item--emoji"
        :title="item.label"
        :aria-label="`插入表情 ${item.label}`"
        @mousedown.prevent="emit('select-emoji', item.id)"
      >
        <img :src="item.src" :alt="item.label" loading="lazy" draggable="false" />
      </button>
    </div>
    <div v-if="variantItems.length" class="composer-context-hints__group">
      <button
        v-for="item in variantItems"
        :key="item.id"
        type="button"
        class="composer-context-hints__item composer-context-hints__item--variant"
        :class="{ 'is-active': item.id === activeVariantId }"
        :title="item.title"
        :aria-label="`切换差分 ${item.label}`"
        :aria-pressed="item.id === activeVariantId"
        @mousedown.prevent="emit('select-variant', item.id)"
      >
        <img v-if="item.src" :src="item.src" :alt="item.label" loading="lazy" draggable="false" />
        <span class="composer-context-hints__label">{{ item.label }}</span>
      </button>
      <button
        v-if="showReset"
        type="button"
        class="composer-context-hints__item composer-context-hints__item--reset"
        title="恢复为当前频道角色的默认头像"
        aria-label="恢复默认差分"
        @mousedown.prevent="emit('reset-variant')"
      >
        <span class="composer-context-hints__label">↺ 默认</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.composer-context-hints {
  position: absolute;
  bottom: calc(100% + 4px);
  z-index: 7;
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: calc(100% - 1.3rem);
  height: var(--composer-hints-panel-height, 40px);
  padding: 3px 4px;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
  overscroll-behavior-x: contain;
  border: 1px solid var(--sc-border-mute, rgba(148, 163, 184, 0.22));
  border-radius: 10px;
  color: var(--sc-text-primary, #1f2937);
  background: color-mix(in srgb, var(--sc-bg-elevated, #ffffff) 88%, transparent);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.08);
}

.composer-context-hints--left {
  left: 0.65rem;
  right: auto;
}

.composer-context-hints--center {
  left: 50%;
  right: auto;
  transform: translateX(-50%);
}

.composer-context-hints--right {
  left: auto;
  right: 0.65rem;
}

/* 快速角色栏骑跨在输入容器上边缘，开启时上移让出空间 */
.composer-context-hints--raised {
  bottom: calc(100% + 24px);
}

.composer-context-hints::-webkit-scrollbar {
  display: none;
}

.composer-context-hints__group {
  display: flex;
  align-items: center;
  gap: 3px;
  flex: 0 0 auto;
}

.composer-context-hints__group + .composer-context-hints__group {
  padding-left: 6px;
  border-left: 1px solid var(--sc-border-mute, rgba(148, 163, 184, 0.25));
}

.composer-context-hints__item {
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  flex: 0 0 auto;
  height: var(--composer-hints-item-size, 32px);
  padding: 1px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  transition: background-color 0.15s ease, border-color 0.15s ease;
}

.composer-context-hints__item:hover,
.composer-context-hints__item:focus-visible,
.composer-context-hints__item.is-active {
  border-color: color-mix(in srgb, var(--sc-primary-color, #3b82f6) 45%, transparent);
  background: color-mix(in srgb, var(--sc-primary-color, #3b82f6) 10%, transparent);
  outline: none;
}

.composer-context-hints__item--emoji {
  width: var(--composer-hints-item-size, 32px);
}

.composer-context-hints__item--emoji img {
  width: var(--composer-hints-emoji-size, 28px);
  height: var(--composer-hints-emoji-size, 28px);
  object-fit: contain;
  border-radius: 4px;
}

.composer-context-hints__item--variant,
.composer-context-hints__item--reset {
  padding: 1px 6px 1px 2px;
}

.composer-context-hints__item--reset {
  padding-left: 6px;
}

.composer-context-hints__item--variant img {
  width: var(--composer-hints-variant-size, 26px);
  height: var(--composer-hints-variant-size, 26px);
  object-fit: cover;
  border-radius: 9999px;
}

.composer-context-hints__label {
  max-width: 6em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--composer-hints-label-size, 12px);
  line-height: 1;
}

/* 快捷命令提示：触发词 → 实际命令 */
.composer-context-hints__item--shortcut {
  max-width: 18em;
  padding: 1px 8px;
  gap: 5px;
  border-color: var(--sc-border-mute, rgba(148, 163, 184, 0.25));
  font-size: var(--composer-hints-label-size, 12px);
  line-height: 1;
}

.composer-context-hints__shortcut-from {
  max-width: 7em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.composer-context-hints__shortcut-arrow {
  opacity: 0.55;
}

.composer-context-hints__shortcut-to {
  max-width: 10em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--sc-code-font, ui-monospace, monospace);
  font-size: 0.95em;
}

.composer-context-hints__item--shortcut.is-alias-ready {
  border-color: color-mix(in srgb, var(--primary-color, #3b82f6) 55%, transparent);
  background: color-mix(in srgb, var(--primary-color, #3b82f6) 14%, transparent);
}

.composer-context-hints__item--shortcut.is-alias-ready .composer-context-hints__shortcut-arrow {
  opacity: 0.9;
  color: var(--primary-color, #3b82f6);
}

.composer-context-hints__item--shortcut.is-replace {
  cursor: default;
  border-style: dashed;
  opacity: 0.85;
}

.composer-context-hints__item--shortcut.is-replace:hover {
  border-color: var(--sc-border-mute, rgba(148, 163, 184, 0.25));
  background: transparent;
}

@media (max-width: 768px) {
  .composer-context-hints {
    max-width: calc(100% - 1rem);
    height: var(--composer-hints-panel-height, 40px);
  }

  .composer-context-hints--left {
    left: 0.5rem;
  }

  .composer-context-hints--right {
    right: 0.5rem;
  }
}
</style>
