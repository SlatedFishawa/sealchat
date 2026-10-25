<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { NIcon } from 'naive-ui'
import {
  Id as CardIcon,
  Plus as PlusIcon,
  Refresh as RefreshIcon,
  Tags as CustomIcon,
} from '@vicons/tabler'
import { useCharacterCardStore } from '@/stores/characterCard'
import QuickSuggestPlayground from './QuickSuggestPlayground.vue'
import ShortcutRuleMaintainBar from './ShortcutRuleMaintainBar.vue'
import { readCharacterAttrNames, resolveQuickSuggestCandidates, resolveQuickSuggestSource } from './quickSuggest'
import { useRuleDragSort } from './useRuleDragSort'
import {
  SHORTCUT_RULE_SCOPE_LABELS,
  type QuickSuggestSource,
  type ShortcutRule,
  type ShortcutRuleScope,
} from './types'

// 标签页三：快速备选（quick_suggest）。
// 每条规则是一组“前缀 → 候选”，以卡片展示候选来源与实时候选；底部常驻试输入，
// 与聊天输入框使用同一套补全逻辑。维护模式下按作用域分组，卡片可启停、编辑、删除、排序。

const props = defineProps<{
  personal: ShortcutRule[]
  world: ShortcutRule[]
  /** 当前生效的快速备选规则（不受搜索/筛选影响），供试输入使用 */
  effectiveRules: ShortcutRule[]
  overriddenIds: ReadonlySet<string>
  busyIds: ReadonlySet<string>
  maintaining: boolean
  hasWorld: boolean
  canManageWorld: boolean
  filtered: boolean
  channelId: string
}>()

const emit = defineEmits<{
  (event: 'create', source?: QuickSuggestSource): void
  (event: 'edit', rule: ShortcutRule): void
  (event: 'delete', rule: ShortcutRule): void
  (event: 'toggle', rule: ShortcutRule, enabled: boolean): void
  (event: 'reorder', scope: ShortcutRuleScope, ids: string[]): void
}>()

const CHIP_PREVIEW_LIMIT = 8

const cardStore = useCharacterCardStore()
const playgroundRef = ref<InstanceType<typeof QuickSuggestPlayground> | null>(null)
const cardRefreshing = ref(false)

const ofSuggest = (rules: ShortcutRule[]) => rules.filter((rule) => rule.type === 'quick_suggest')
const personalRules = computed(() => ofSuggest(props.personal))
const worldRules = computed(() => ofSuggest(props.world))
const allRules = computed(() => [...personalRules.value, ...worldRules.value])

// ---- 当前频道人物卡（只读 Store 中已同步的人物卡，必要时惰性读取一次） ----
const activeCard = computed(() => (props.channelId ? cardStore.activeCards[props.channelId] || null : null))
const cardDisabled = computed(() => !!props.channelId && cardStore.isBotCharacterDisabled(props.channelId))
const attrNames = computed(() => readCharacterAttrNames(activeCard.value?.attrs))
const cardUnavailableText = computed(() => {
  if (!props.channelId) return '当前不在频道中，无法读取人物卡'
  if (cardDisabled.value) return '当前频道未启用人物卡'
  if (cardRefreshing.value) return ''
  return activeCard.value ? '' : '当前没有正在使用的人物卡'
})
const cardStatus = computed(() => {
  if (cardRefreshing.value && !activeCard.value) return { tone: 'muted', text: '正在读取人物卡…' }
  if (cardUnavailableText.value) return { tone: 'muted', text: cardUnavailableText.value }
  const name = String(activeCard.value?.name || '').trim() || '未命名人物卡'
  return { tone: 'ready', text: `人物卡「${name}」· ${attrNames.value.length} 项属性` }
})

const refreshCard = async () => {
  if (!props.channelId || cardDisabled.value || cardRefreshing.value) return
  cardRefreshing.value = true
  try {
    await cardStore.getActiveCard(props.channelId)
  } catch {
    // 读取失败时保持现有状态，界面显示为不可用
  } finally {
    cardRefreshing.value = false
  }
}

const usesCardSource = computed(() => allRules.value.some((rule) => resolveQuickSuggestSource(rule) === 'character_attrs'))
onMounted(() => {
  if (usesCardSource.value && !activeCard.value) void refreshCard()
})
watch(() => props.channelId, () => {
  if (usesCardSource.value && !activeCard.value) void refreshCard()
})

// ---- 卡片 ----
const ruleSource = (rule: ShortcutRule) => resolveQuickSuggestSource(rule)
const ruleCandidates = (rule: ShortcutRule) => resolveQuickSuggestCandidates(rule, { characterAttrs: activeCard.value?.attrs })
const chipPreview = (rule: ShortcutRule) => {
  const candidates = ruleCandidates(rule)
  return {
    chips: candidates.slice(0, CHIP_PREVIEW_LIMIT),
    more: Math.max(0, candidates.length - CHIP_PREVIEW_LIMIT),
  }
}
const sourceCaption = (rule: ShortcutRule) => (
  ruleSource(rule) === 'custom'
    ? `自定义 · ${ruleCandidates(rule).length} 项`
    : '当前人物卡属性 · 实时'
)
const ruleState = (rule: ShortcutRule) => {
  if (!rule.enabled) return '已停用'
  if (props.overriddenIds.has(rule.id)) return '被个人规则覆盖'
  return ''
}

const tryRule = (rule: ShortcutRule) => {
  if (ruleState(rule)) return
  playgroundRef.value?.tryPrefix(rule.trigger.trim())
}

// ---- 维护模式分组与排序 ----
const groups = computed(() => {
  const result = [{
    scope: 'personal' as ShortcutRuleScope,
    rules: personalRules.value,
    editable: true,
    emptyText: props.filtered ? '没有匹配的个人备选' : '个人备选只对自己生效，在所有世界可用',
  }]
  if (props.hasWorld) {
    result.push({
      scope: 'world',
      rules: worldRules.value,
      editable: props.canManageWorld,
      emptyText: props.filtered ? '没有匹配的世界备选' : '世界备选对所有成员生效，成员都可以添加',
    })
  }
  return result
})

const drag = useRuleDragSort((scope, ids) => emit('reorder', scope as ShortcutRuleScope, ids))
const idsOf = (rules: ShortcutRule[]) => rules.map((rule) => rule.id)
</script>

<template>
  <div class="sc-suggest-panel">
    <aside class="sc-suggest-intro">
      <p class="sc-suggest-intro__text">
        在输入框输入前缀即弹出候选，<strong>选中只补全文字，不会发送</strong>。前缀可以是任意文字；
        同一前缀个人备选优先于世界备选。
      </p>
      <div class="sc-suggest-card-status" :class="`is-${cardStatus.tone}`">
        <NIcon :component="CardIcon" size="15" />
        <span class="sc-suggest-card-status__text">{{ cardStatus.text }}</span>
        <button
          v-if="channelId && !cardDisabled"
          type="button"
          class="sc-icon-btn"
          :class="{ 'is-spinning': cardRefreshing }"
          :disabled="cardRefreshing"
          aria-label="重新读取人物卡"
          title="重新读取人物卡"
          @click="refreshCard"
        >
          <NIcon :component="RefreshIcon" size="14" />
        </button>
      </div>
    </aside>

    <template v-if="maintaining">
      <section v-for="group in groups" :key="group.scope" class="sc-suggest-group">
        <header class="sc-section__head">
          <div class="sc-suggest-group__title">
            <span class="sc-scope-badge" :class="`sc-scope-badge--${group.scope}`">{{ SHORTCUT_RULE_SCOPE_LABELS[group.scope] }}</span>
            <span class="sc-suggest-group__count">{{ group.rules.length }} 组</span>
            <span v-if="!group.editable" class="sc-suggest-group__note">旁观身份只能查看世界备选</span>
          </div>
          <button v-if="group.scope === 'personal'" type="button" class="sc-btn sc-btn--soft" @click="emit('create')">
            <NIcon :component="PlusIcon" size="14" />新建备选
          </button>
        </header>
        <TransitionGroup v-if="group.rules.length" tag="ul" name="sc-card" class="sc-suggest-grid">
          <li
            v-for="(rule, index) in group.rules"
            :key="rule.id"
            class="sc-suggest-card is-maintaining"
            :class="{
              'is-disabled': !rule.enabled,
              'is-dragging': drag.dragging.value?.id === rule.id,
              'is-drop-target': drag.overId.value === rule.id && drag.dragging.value?.id !== rule.id,
            }"
            @dragover="drag.onDragOver(group.scope, rule.id, $event)"
            @drop="drag.onDrop(group.scope, idsOf(group.rules), rule.id, $event)"
          >
            <div class="sc-suggest-card__head">
              <kbd class="sc-suggest-card__prefix" :title="rule.trigger">{{ rule.trigger }}</kbd>
              <span class="sc-suggest-card__source" :class="`is-${ruleSource(rule)}`">
                <NIcon :component="ruleSource(rule) === 'custom' ? CustomIcon : CardIcon" size="13" />{{ sourceCaption(rule) }}
              </span>
            </div>
            <ul class="sc-suggest-card__chips">
              <li v-for="chip in chipPreview(rule).chips" :key="chip">{{ chip }}</li>
              <li v-if="chipPreview(rule).more" class="is-more">+{{ chipPreview(rule).more }}</li>
              <li v-if="!chipPreview(rule).chips.length" class="is-ghost">使用时读取当前人物卡</li>
            </ul>
            <div class="sc-suggest-card__foot">
              <span class="sc-suggest-card__meta">
                <span v-if="ruleState(rule)" class="sc-tag sc-tag--muted">{{ ruleState(rule) }}</span>
                <span v-if="group.scope === 'world' && rule.updatedByName" class="sc-suggest-card__author">{{ rule.updatedByName }} 更新</span>
              </span>
              <ShortcutRuleMaintainBar
                :rule="rule"
                :editable="group.editable"
                :can-move-up="index > 0"
                :can-move-down="index < group.rules.length - 1"
                :busy="busyIds.has(rule.id)"
                @toggle="emit('toggle', rule, $event)"
                @edit="emit('edit', rule)"
                @delete="emit('delete', rule)"
                @move="drag.move(group.scope, idsOf(group.rules), rule.id, $event)"
                @drag-start="drag.onDragStart(group.scope, rule.id, $event)"
                @drag-end="drag.onDragEnd()"
              />
            </div>
          </li>
        </TransitionGroup>
        <p v-else class="sc-suggest-group__empty">{{ group.emptyText }}</p>
      </section>
    </template>

    <TransitionGroup v-else-if="allRules.length" tag="ul" name="sc-card" class="sc-suggest-grid">
      <li
        v-for="rule in allRules"
        :key="rule.id"
        class="sc-suggest-card"
        :class="{ 'is-inactive': !!ruleState(rule) }"
      >
        <button
          type="button"
          class="sc-suggest-card__hit"
          :disabled="!!ruleState(rule)"
          :aria-label="`试输入 ${rule.trigger}`"
          @click="tryRule(rule)"
        />
        <div class="sc-suggest-card__head">
          <kbd class="sc-suggest-card__prefix" :title="rule.trigger">{{ rule.trigger }}</kbd>
          <span class="sc-scope-badge" :class="`sc-scope-badge--${rule.scope}`">{{ SHORTCUT_RULE_SCOPE_LABELS[rule.scope] }}</span>
        </div>
        <span class="sc-suggest-card__source" :class="`is-${ruleSource(rule)}`">
          <NIcon :component="ruleSource(rule) === 'custom' ? CustomIcon : CardIcon" size="13" />{{ sourceCaption(rule) }}
        </span>
        <ul class="sc-suggest-card__chips">
          <li v-for="chip in chipPreview(rule).chips" :key="chip">{{ chip }}</li>
          <li v-if="chipPreview(rule).more" class="is-more">+{{ chipPreview(rule).more }}</li>
          <li v-if="!chipPreview(rule).chips.length" class="is-ghost">使用时读取当前人物卡</li>
        </ul>
        <div class="sc-suggest-card__foot">
          <span v-if="ruleState(rule)" class="sc-tag sc-tag--muted">{{ ruleState(rule) }}</span>
          <span v-else class="sc-suggest-card__try">点按试输入 →</span>
        </div>
      </li>
    </TransitionGroup>

    <div v-else-if="filtered" class="sc-empty-inline">
      <span class="sc-empty-inline__glyph" aria-hidden="true">⌕</span>
      <span>没有匹配的快速备选</span>
    </div>

    <div v-else class="sc-suggest-empty">
      <div class="sc-suggest-empty__demo" aria-hidden="true">
        <ul class="sc-suggest-empty__menu">
          <li class="is-active">测试1</li>
          <li>测试2</li>
        </ul>
        <span class="sc-suggest-empty__input">。test <i /></span>
      </div>
      <div class="sc-suggest-empty__body">
        <h3 class="sc-section__title">还没有快速备选</h3>
        <p class="sc-section__desc">把常用参数做成候选：输入 <code>.ra</code> 列出人物卡属性，或输入 <code>。test</code> 选择自己准备的选项。</p>
        <div class="sc-suggest-empty__actions">
          <button type="button" class="sc-btn sc-btn--soft" @click="emit('create', 'character_attrs')">
            <NIcon :component="CardIcon" size="14" />用人物卡属性
          </button>
          <button type="button" class="sc-btn sc-btn--ghost" @click="emit('create', 'custom')">
            <NIcon :component="CustomIcon" size="14" />自定义候选
          </button>
        </div>
      </div>
    </div>

    <div class="sc-suggest-dock">
      <QuickSuggestPlayground
        ref="playgroundRef"
        :rules="effectiveRules"
        :attrs="activeCard?.attrs || null"
        :card-name="String(activeCard?.name || '').trim()"
        :card-unavailable-text="cardUnavailableText"
      />
    </div>
  </div>
</template>

<style scoped>
.sc-suggest-panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 100%;
  /* 卡片与吸底试输入的层级只在面板内部比较，不盖过弹窗的编辑抽屉 */
  isolation: isolate;
}

.sc-suggest-intro {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px 16px;
  padding: 12px 14px;
  border-radius: 14px;
  background:
    radial-gradient(120% 160% at 100% 0%, color-mix(in srgb, var(--sc-shortcut-world) 12%, transparent), transparent 55%),
    var(--sc-chip-bg);
}

.sc-suggest-intro__text {
  flex: 1 1 320px;
  margin: 0;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--sc-text-secondary);
}

.sc-suggest-intro__text strong {
  color: var(--sc-text-primary);
  font-weight: 600;
}

.sc-suggest-card-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: 100%;
  padding: 3px 4px 3px 10px;
  border-radius: 999px;
  background: var(--sc-bg-elevated);
  box-shadow: inset 0 0 0 1px var(--sc-border-mute);
  font-size: 12px;
}

.sc-suggest-card-status.is-ready {
  color: var(--sc-shortcut-world);
}

.sc-suggest-card-status.is-muted {
  color: var(--sc-text-secondary);
}

.sc-suggest-card-status__text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sc-suggest-card-status .sc-icon-btn {
  width: 24px;
  height: 24px;
}

.sc-suggest-card-status .is-spinning :deep(svg) {
  animation: sc-spin 0.9s linear infinite;
}

@keyframes sc-spin {
  to { transform: rotate(360deg); }
}

.sc-suggest-group {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.sc-suggest-group__title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.sc-suggest-group__count,
.sc-suggest-group__note {
  font-size: 12px;
  color: var(--sc-text-secondary);
}

.sc-suggest-group__empty {
  margin: 0;
  padding: 12px 14px;
  border: 1px dashed var(--sc-border-strong);
  border-radius: 12px;
  font-size: 12.5px;
  color: var(--sc-text-secondary);
}

.sc-suggest-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(232px, 1fr));
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.sc-suggest-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding: 12px;
  border-radius: 14px;
  background: var(--sc-shortcut-surface);
  box-shadow: inset 0 0 0 1px var(--sc-border-mute);
  transition: box-shadow 0.18s ease, transform 0.18s ease, opacity 0.18s ease;
}

.sc-suggest-card:not(.is-maintaining):not(.is-inactive):hover {
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--sc-shortcut-accent) 55%, var(--sc-border-mute)), 0 10px 22px -18px var(--sc-shortcut-accent);
  transform: translateY(-1px);
}

.sc-suggest-card.is-inactive {
  opacity: 0.55;
}

.sc-suggest-card.is-maintaining {
  box-shadow: none;
  border: 1px dashed color-mix(in srgb, var(--sc-shortcut-accent) 38%, var(--sc-border-strong));
}

.sc-suggest-card.is-maintaining:hover {
  border-style: solid;
}

.sc-suggest-card.is-disabled > :not(.sc-suggest-card__foot) {
  opacity: 0.5;
}

.sc-suggest-card.is-dragging {
  opacity: 0.4;
}

.sc-suggest-card.is-drop-target {
  border-style: solid;
  border-color: var(--sc-shortcut-accent);
  box-shadow: -3px 0 0 var(--sc-shortcut-accent);
}

/* 查看模式整张卡片可点，用透明按钮覆盖以保留键盘可达性 */
.sc-suggest-card__hit {
  position: absolute;
  inset: 0;
  z-index: 1;
  padding: 0;
  border: 0;
  border-radius: inherit;
  background: transparent;
  cursor: pointer;
}

.sc-suggest-card__hit:disabled {
  cursor: default;
}

.sc-suggest-card__hit:focus-visible {
  outline: 2px solid var(--sc-shortcut-accent);
  outline-offset: 2px;
}

.sc-suggest-card__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 6px 8px;
  min-width: 0;
}

.sc-suggest-card__prefix {
  display: inline-block;
  max-width: 100%;
  padding: 3px 10px 4px;
  overflow: hidden;
  border-radius: 8px;
  border: 1px solid var(--sc-border-strong);
  border-bottom-width: 3px;
  background: var(--sc-bg-elevated);
  color: var(--sc-text-primary);
  font-family: var(--sc-code-font);
  font-size: 15px;
  font-weight: 650;
  line-height: 1.3;
  text-overflow: ellipsis;
  white-space: pre;
}

.sc-suggest-card__source {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--sc-text-secondary);
}

.sc-suggest-card__source.is-character_attrs {
  color: var(--sc-shortcut-world);
}

.sc-suggest-card__source.is-custom {
  color: var(--sc-shortcut-personal);
}

.sc-suggest-card__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  min-height: 22px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.sc-suggest-card__chips li {
  max-width: 9em;
  padding: 0 8px;
  overflow: hidden;
  border-radius: 6px;
  background: var(--sc-chip-bg);
  font-size: 12px;
  line-height: 22px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sc-suggest-card__chips li.is-more {
  background: transparent;
  color: var(--sc-text-secondary);
}

.sc-suggest-card__chips li.is-ghost {
  max-width: none;
  border: 1px dashed var(--sc-border-strong);
  background: transparent;
  color: var(--sc-text-secondary);
}

.sc-suggest-card__foot {
  position: relative;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 28px;
  margin-top: auto;
}

.sc-suggest-card:not(.is-maintaining) .sc-suggest-card__foot {
  z-index: 0;
  min-height: 0;
}

.sc-suggest-card__meta {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.sc-suggest-card__author {
  font-size: 11px;
  color: var(--sc-text-secondary);
}

.sc-suggest-card__try {
  font-size: 11.5px;
  color: var(--sc-shortcut-accent);
  opacity: 0;
  transition: opacity 0.15s ease;
}

.sc-suggest-card:hover .sc-suggest-card__try,
.sc-suggest-card:focus-within .sc-suggest-card__try {
  opacity: 1;
}

.sc-suggest-empty {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 20px;
  padding: 20px;
  border: 1px dashed var(--sc-border-strong);
  border-radius: 16px;
}

.sc-suggest-empty__demo {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 150px;
}

.sc-suggest-empty__menu {
  margin: 0;
  padding: 4px;
  border-radius: 8px;
  background: var(--sc-bg-elevated);
  box-shadow: 0 8px 18px -12px rgba(15, 23, 42, 0.5), inset 0 0 0 1px var(--sc-border-mute);
  list-style: none;
  font-size: 12.5px;
}

.sc-suggest-empty__menu li {
  padding: 2px 8px;
  border-radius: 5px;
}

.sc-suggest-empty__menu li.is-active {
  background: color-mix(in srgb, var(--sc-shortcut-accent) 14%, transparent);
  color: var(--sc-shortcut-accent);
}

.sc-suggest-empty__input {
  display: flex;
  align-items: center;
  padding: 6px 10px;
  border-radius: 8px;
  background: var(--sc-chip-bg);
  font-family: var(--sc-code-font);
  font-size: 13px;
  white-space: pre;
}

.sc-suggest-empty__input i {
  width: 1.5px;
  height: 1.1em;
  background: var(--sc-shortcut-accent);
}

.sc-suggest-empty__body code {
  font-family: var(--sc-code-font);
  color: var(--sc-text-primary);
}

.sc-suggest-empty__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

.sc-suggest-dock {
  position: sticky;
  bottom: 0;
  z-index: 4;
  margin-top: auto;
  padding-top: 8px;
}

.sc-card-enter-active,
.sc-card-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.sc-card-enter-from,
.sc-card-leave-to {
  opacity: 0;
  transform: translateY(3px);
}

@media (max-width: 640px) {
  .sc-suggest-grid {
    grid-template-columns: 1fr;
  }

  .sc-suggest-empty {
    grid-template-columns: 1fr;
    justify-items: center;
    text-align: center;
  }

  .sc-suggest-empty__actions {
    justify-content: center;
  }

  /* 触屏没有悬停：常显试输入提示 */
  .sc-suggest-card__try {
    opacity: 1;
  }
}

@media (hover: none) {
  .sc-suggest-card__try {
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .sc-suggest-card,
  .sc-card-enter-active,
  .sc-card-leave-active {
    transition: none;
  }

  .sc-suggest-card-status .is-spinning :deep(svg) {
    animation: none;
  }
}
</style>
