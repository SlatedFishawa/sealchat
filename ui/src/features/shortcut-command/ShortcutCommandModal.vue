<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { NIcon, NInput, NModal, useMessage } from 'naive-ui'
import {
  Bolt as BoltIcon,
  Check as DoneIcon,
  Pencil as MaintainIcon,
  Refresh as RefreshIcon,
  Search as SearchIcon,
  X as CloseIcon,
} from '@vicons/tabler'
import { useChatStore } from '@/stores/chat'
import ShortcutButtonPanel from './ShortcutButtonPanel.vue'
import ShortcutDicePanel from './ShortcutDicePanel.vue'
import ShortcutRuleEditor from './ShortcutRuleEditor.vue'
import {
  createShortcutRule,
  deleteShortcutRule,
  describeShortcutApiError,
  reorderShortcutRules,
  updateShortcutRule,
} from './api'
import {
  applyShortcutRuleOrder,
  applyShortcutRuleRemoval,
  applyShortcutRuleUpsert,
  ensureShortcutRules,
  getEffectiveShortcutRules,
  getShortcutRuleSnapshot,
} from './ruleCache'
import { mergeReorderedSubset } from './ruleMatching'
import type { ShortcutRule, ShortcutRuleDraft, ShortcutRuleScope, ShortcutRuleType } from './types'

type ShortcutTab = 'dice' | 'buttons'
type ScopeFilter = 'all' | ShortcutRuleScope

const props = defineProps<{
  show: boolean
  worldId: string
}>()

const emit = defineEmits<{
  (event: 'update:show', value: boolean): void
}>()

const chat = useChatStore()
const message = useMessage()

const TAB_TYPES: Record<ShortcutTab, ShortcutRuleType[]> = {
  dice: ['send_alias', 'replace'],
  buttons: ['message_action'],
}

const activeTab = ref<ShortcutTab>('dice')
const maintaining = ref(false)
const search = ref('')
const scopeFilter = ref<ScopeFilter>('all')
const busyIds = reactive(new Set<string>())
const editor = reactive({
  open: false,
  rule: null as ShortcutRule | null,
  type: 'send_alias' as ShortcutRuleType,
  saving: false,
  error: '',
})

const worldId = computed(() => String(props.worldId || '').trim())
const hasWorld = computed(() => !!worldId.value)
const snapshot = computed(() => getShortcutRuleSnapshot(worldId.value))
const effective = computed(() => getEffectiveShortcutRules(worldId.value))
const canManageWorld = computed(() => hasWorld.value && snapshot.value.canManageWorld)
const worldName = computed(() => (worldId.value ? String((chat.worldMap as any)?.[worldId.value]?.name || '') : ''))
const worldDisabledReason = computed(() => {
  if (!hasWorld.value) return '当前不在世界中'
  if (!canManageWorld.value) return '旁观身份不能维护世界规则'
  return ''
})
const initialLoading = computed(() => snapshot.value.loading && !snapshot.value.loaded)

const refresh = () => {
  void ensureShortcutRules(worldId.value, { force: true }).catch((error) => {
    message.error(`加载快捷命令失败：${describeShortcutApiError(error)}`)
  })
}

// 每次打开都回到查看模式
watch(() => props.show, (visible) => {
  if (!visible) return
  maintaining.value = false
  editor.open = false
  search.value = ''
  scopeFilter.value = 'all'
  refresh()
}, { immediate: true })
watch(worldId, () => {
  if (props.show) refresh()
})

const close = () => emit('update:show', false)

const toggleMaintaining = () => {
  maintaining.value = !maintaining.value
  if (!maintaining.value) editor.open = false
}

const tabRules = (rules: ShortcutRule[], tab: ShortcutTab) => rules.filter((rule) => TAB_TYPES[tab].includes(rule.type))
const tabCount = (tab: ShortcutTab) => tabRules(snapshot.value.personal, tab).length + tabRules(snapshot.value.world, tab).length

const matchesSearch = (rule: ShortcutRule) => {
  const keyword = search.value.trim().toLowerCase()
  if (!keyword) return true
  return rule.trigger.toLowerCase().includes(keyword) || rule.command.toLowerCase().includes(keyword)
}
const filterRules = (rules: ShortcutRule[], scope: ShortcutRuleScope) => {
  if (scopeFilter.value !== 'all' && scopeFilter.value !== scope) return []
  return tabRules(rules, activeTab.value).filter(matchesSearch)
}
const visiblePersonal = computed(() => filterRules(snapshot.value.personal, 'personal'))
const visibleWorld = computed(() => filterRules(snapshot.value.world, 'world'))
const filtered = computed(() => !!search.value.trim() || scopeFilter.value !== 'all')
const scopeCounts = computed(() => ({
  personal: tabRules(snapshot.value.personal, activeTab.value).length,
  world: tabRules(snapshot.value.world, activeTab.value).length,
}))

const openEditor = (type: ShortcutRuleType, rule: ShortcutRule | null = null) => {
  maintaining.value = true
  editor.type = type
  editor.rule = rule
  editor.error = ''
  editor.saving = false
  editor.open = true
}
const closeEditor = () => {
  editor.open = false
}

const handleCreate = (type?: ShortcutRuleType) => {
  openEditor(type || (activeTab.value === 'buttons' ? 'message_action' : 'send_alias'))
}

const handleSave = async (draft: ShortcutRuleDraft) => {
  editor.saving = true
  editor.error = ''
  try {
    const current = editor.rule
    const saved = current
      ? await updateShortcutRule(current.id, {
        trigger: draft.trigger,
        command: draft.command,
        enabled: draft.enabled,
        config: draft.config,
        ...(draft.scope !== current.scope ? { scope: draft.scope, worldId: worldId.value } : {}),
      })
      : await createShortcutRule({
        scope: draft.scope,
        worldId: draft.scope === 'world' ? worldId.value : undefined,
        type: draft.type,
        trigger: draft.trigger,
        command: draft.command,
        enabled: draft.enabled,
        config: draft.config,
      })
    applyShortcutRuleUpsert(saved)
    editor.open = false
    message.success(current ? '已保存' : '已添加')
  } catch (error) {
    editor.error = describeShortcutApiError(error, '保存失败')
  } finally {
    editor.saving = false
  }
}

const withBusy = async (ruleId: string, task: () => Promise<void>) => {
  if (busyIds.has(ruleId)) return
  busyIds.add(ruleId)
  try {
    await task()
  } finally {
    busyIds.delete(ruleId)
  }
}

const handleToggle = (rule: ShortcutRule, enabled: boolean) => withBusy(rule.id, async () => {
  try {
    applyShortcutRuleUpsert(await updateShortcutRule(rule.id, { enabled }))
  } catch (error) {
    message.error(`更新失败：${describeShortcutApiError(error)}`)
  }
})

const handleDelete = (rule: ShortcutRule) => withBusy(rule.id, async () => {
  try {
    await deleteShortcutRule(rule.id)
    applyShortcutRuleRemoval(rule.id)
    message.success(`已删除「${rule.trigger}」`)
  } catch (error) {
    message.error(`删除失败：${describeShortcutApiError(error)}`)
  }
})

const handleReorder = async (scope: ShortcutRuleScope, subsetIds: string[]) => {
  const bucket = scope === 'personal' ? snapshot.value.personal : snapshot.value.world
  const merged = mergeReorderedSubset(bucket.map((rule) => rule.id), subsetIds)
  const byId = new Map(bucket.map((rule) => [rule.id, rule]))
  // 乐观更新，失败时整体刷新
  applyShortcutRuleOrder(scope, worldId.value, merged.map((id, index) => ({ ...byId.get(id)!, sortOrder: index })))
  try {
    applyShortcutRuleOrder(scope, worldId.value, await reorderShortcutRules(scope, scope === 'world' ? worldId.value : '', merged))
  } catch (error) {
    message.error(`排序失败：${describeShortcutApiError(error)}`)
    refresh()
  }
}

const panelListeners = {
  onEdit: (rule: ShortcutRule) => openEditor(rule.type, rule),
  onDelete: handleDelete,
  onToggle: handleToggle,
  onReorder: handleReorder,
}
</script>

<template>
  <NModal
    :show="show"
    :mask-closable="!editor.open"
    :close-on-esc="!editor.open"
    transform-origin="center"
    @update:show="emit('update:show', $event)"
  >
    <div
      class="sc-shortcut"
      :class="{ 'is-maintaining': maintaining }"
      role="dialog"
      aria-modal="true"
      aria-label="快捷命令"
    >
      <header class="sc-shortcut__header">
        <div class="sc-shortcut__brand">
          <span class="sc-shortcut__mark" aria-hidden="true"><NIcon :component="BoltIcon" size="18" /></span>
          <div class="sc-shortcut__heading">
            <h2>快捷命令</h2>
            <p>
              <template v-if="hasWorld">{{ worldName || '当前世界' }} · </template>
              个人 {{ snapshot.personal.length }}<template v-if="hasWorld"> · 世界 {{ snapshot.world.length }}</template>
            </p>
          </div>
        </div>
        <div class="sc-shortcut__header-actions">
          <button
            type="button"
            class="sc-btn sc-shortcut__mode-toggle"
            :class="maintaining ? 'sc-btn--primary' : 'sc-btn--ghost'"
            :aria-pressed="maintaining"
            @click="toggleMaintaining"
          >
            <NIcon :component="maintaining ? DoneIcon : MaintainIcon" size="15" />
            {{ maintaining ? '完成维护' : '维护快捷命令' }}
          </button>
          <button type="button" class="sc-icon-btn sc-icon-btn--lg" aria-label="关闭" @click="close">
            <NIcon :component="CloseIcon" size="18" />
          </button>
        </div>
      </header>

      <Transition name="sc-banner">
        <div v-if="maintaining" class="sc-shortcut__banner" role="status">
          <strong>维护模式</strong>
          <span>改动立即保存{{ hasWorld ? '；世界规则由世界成员共同维护，对所有人生效' : '' }}</span>
        </div>
      </Transition>

      <nav class="sc-shortcut__tabs" role="tablist" aria-label="快捷命令类型">
        <button
          type="button"
          role="tab"
          :aria-selected="activeTab === 'dice'"
          class="sc-tab"
          :class="{ 'is-active': activeTab === 'dice' }"
          @click="activeTab = 'dice'"
        >
          <span class="sc-tab__title">快捷掷骰命令<span class="sc-tab__count">{{ tabCount('dice') }}</span></span>
          <span class="sc-tab__caption">输入一个词，发出完整命令</span>
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="activeTab === 'buttons'"
          class="sc-tab"
          :class="{ 'is-active': activeTab === 'buttons' }"
          @click="activeTab = 'buttons'"
        >
          <span class="sc-tab__title">快捷消息按钮<span class="sc-tab__count">{{ tabCount('buttons') }}</span></span>
          <span class="sc-tab__caption">消息里的关键词一点即用</span>
        </button>
        <span class="sc-tabs__indicator" :class="`is-${activeTab}`" aria-hidden="true" />
      </nav>

      <div class="sc-shortcut__toolbar">
        <NInput v-model:value="search" size="small" clearable placeholder="搜索触发内容或命令" class="sc-shortcut__search">
          <template #prefix><NIcon :component="SearchIcon" size="14" /></template>
        </NInput>
        <div v-if="hasWorld" class="sc-filter" role="radiogroup" aria-label="来源筛选">
          <button type="button" role="radio" :aria-checked="scopeFilter === 'all'" :class="{ 'is-active': scopeFilter === 'all' }" @click="scopeFilter = 'all'">全部</button>
          <button type="button" role="radio" :aria-checked="scopeFilter === 'personal'" :class="{ 'is-active': scopeFilter === 'personal' }" @click="scopeFilter = 'personal'">
            <span class="sc-scope-dot sc-scope-dot--personal" />个人 {{ scopeCounts.personal }}
          </button>
          <button type="button" role="radio" :aria-checked="scopeFilter === 'world'" :class="{ 'is-active': scopeFilter === 'world' }" @click="scopeFilter = 'world'">
            <span class="sc-scope-dot sc-scope-dot--world" />世界 {{ scopeCounts.world }}
          </button>
        </div>
      </div>

      <main class="sc-shortcut__body">
        <div v-if="initialLoading" class="sc-skeleton" aria-busy="true" aria-label="加载中">
          <span v-for="index in 6" :key="index" class="sc-skeleton__card" />
        </div>
        <div v-else-if="snapshot.error && !snapshot.personal.length && !snapshot.world.length" class="sc-error-state">
          <p>快捷命令加载失败</p>
          <button type="button" class="sc-btn sc-btn--ghost" @click="refresh">
            <NIcon :component="RefreshIcon" size="14" />重试
          </button>
        </div>
        <Transition v-else name="sc-fade" mode="out-in">
          <ShortcutDicePanel
            v-if="activeTab === 'dice'"
            key="dice"
            :personal="visiblePersonal"
            :world="visibleWorld"
            :overridden-ids="effective.overriddenIds"
            :busy-ids="busyIds"
            :maintaining="maintaining"
            :has-world="hasWorld"
            :can-manage-world="canManageWorld"
            :filtered="filtered"
            @create="handleCreate"
            @edit="panelListeners.onEdit"
            @delete="panelListeners.onDelete"
            @toggle="panelListeners.onToggle"
            @reorder="panelListeners.onReorder"
          />
          <ShortcutButtonPanel
            v-else
            key="buttons"
            :personal="visiblePersonal"
            :world="visibleWorld"
            :overridden-ids="effective.overriddenIds"
            :busy-ids="busyIds"
            :maintaining="maintaining"
            :has-world="hasWorld"
            :can-manage-world="canManageWorld"
            :filtered="filtered"
            @create="handleCreate('message_action')"
            @edit="panelListeners.onEdit"
            @delete="panelListeners.onDelete"
            @toggle="panelListeners.onToggle"
            @reorder="panelListeners.onReorder"
          />
        </Transition>
      </main>

      <Transition name="sc-sheet">
        <div v-if="editor.open" class="sc-shortcut__sheet-layer" @click.self="closeEditor">
          <div class="sc-shortcut__sheet">
            <ShortcutRuleEditor
              :rule="editor.rule"
              :type="editor.type"
              :can-use-world="hasWorld && canManageWorld"
              :world-disabled-reason="worldDisabledReason"
              :saving="editor.saving"
              :error="editor.error"
              @save="handleSave"
              @cancel="closeEditor"
            />
          </div>
        </div>
      </Transition>
    </div>
  </NModal>
</template>

<style scoped>
.sc-shortcut {
  position: relative;
  display: flex;
  flex-direction: column;
  width: min(960px, calc(100vw - 32px));
  height: min(740px, calc(100dvh - 48px));
  border-radius: 20px;
  border: 1px solid var(--sc-border-strong);
  background: var(--sc-bg-elevated);
  color: var(--sc-text-primary);
  box-shadow: 0 30px 80px -30px rgba(15, 23, 42, 0.45), 0 0 0 0 transparent;
  transition: box-shadow 0.25s ease, border-color 0.25s ease;
}

.sc-shortcut.is-maintaining {
  border-color: var(--sc-shortcut-accent);
  box-shadow: 0 30px 80px -30px rgba(15, 23, 42, 0.45), 0 0 0 3px color-mix(in srgb, var(--sc-shortcut-accent) 22%, transparent);
}

.sc-shortcut__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 18px 20px 12px;
}

.sc-shortcut__brand {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.sc-shortcut__mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 38px;
  height: 38px;
  border-radius: 12px;
  color: #fff;
  background: linear-gradient(140deg, var(--sc-shortcut-accent), color-mix(in srgb, var(--sc-shortcut-accent) 55%, var(--sc-shortcut-personal)));
  box-shadow: 0 8px 18px -10px var(--sc-shortcut-accent);
}

.sc-shortcut__heading {
  min-width: 0;
}

.sc-shortcut__heading h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  letter-spacing: 0.01em;
}

.sc-shortcut__heading p {
  margin: 2px 0 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--sc-text-secondary);
}

.sc-shortcut__header-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
}

.sc-shortcut__banner {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
  margin: 0 20px 8px;
  padding: 7px 12px;
  border-radius: 10px;
  font-size: 12px;
  color: var(--sc-text-primary);
  background:
    repeating-linear-gradient(-45deg, color-mix(in srgb, var(--sc-shortcut-accent) 12%, transparent) 0 8px, color-mix(in srgb, var(--sc-shortcut-accent) 6%, transparent) 8px 16px);
  border: 1px solid color-mix(in srgb, var(--sc-shortcut-accent) 35%, transparent);
}

.sc-shortcut__banner strong {
  color: var(--sc-shortcut-accent);
}

.sc-shortcut__tabs {
  position: relative;
  display: grid;
  grid-template-columns: 1fr 1fr;
  margin: 0 20px;
  border-bottom: 1px solid var(--sc-border-mute);
}

.sc-tab {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 8px 4px 12px;
  border: 0;
  background: transparent;
  color: var(--sc-text-secondary);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: color 0.15s ease;
}

.sc-tab.is-active {
  color: var(--sc-text-primary);
}

.sc-tab__title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 14.5px;
  font-weight: 650;
}

.sc-tab__count {
  min-width: 18px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--sc-chip-bg);
  font-size: 11px;
  font-weight: 500;
  line-height: 18px;
  text-align: center;
}

.sc-tab.is-active .sc-tab__count {
  background: color-mix(in srgb, var(--sc-shortcut-accent) 16%, transparent);
  color: var(--sc-shortcut-accent);
}

.sc-tab__caption {
  font-size: 11.5px;
  opacity: 0.8;
}

.sc-tabs__indicator {
  position: absolute;
  bottom: -1px;
  left: 0;
  width: 50%;
  height: 2px;
  border-radius: 2px;
  background: var(--sc-shortcut-accent);
  transition: transform 0.25s cubic-bezier(0.2, 0.8, 0.2, 1);
}

.sc-tabs__indicator.is-buttons {
  transform: translateX(100%);
}

.sc-shortcut__toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 20px 4px;
}

.sc-shortcut__search {
  flex: 1 1 240px;
  max-width: 320px;
}

.sc-filter {
  display: inline-flex;
  padding: 2px;
  border-radius: 999px;
  background: var(--sc-chip-bg);
}

.sc-filter button {
  display: inline-flex;
  align-items: center;
  padding: 3px 11px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--sc-text-secondary);
  font: inherit;
  font-size: 12px;
  white-space: nowrap;
  cursor: pointer;
}

.sc-filter button.is-active {
  background: var(--sc-bg-elevated);
  color: var(--sc-text-primary);
  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.12);
}

.sc-shortcut__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 14px 20px 24px;
  scrollbar-width: thin;
}

.sc-skeleton {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(196px, 1fr));
  gap: 10px;
}

.sc-skeleton__card {
  height: 92px;
  border-radius: 14px;
  background: linear-gradient(90deg, var(--sc-chip-bg) 25%, color-mix(in srgb, var(--sc-chip-bg) 40%, transparent) 50%, var(--sc-chip-bg) 75%);
  background-size: 200% 100%;
  animation: sc-shimmer 1.4s ease-in-out infinite;
}

@keyframes sc-shimmer {
  from { background-position: 200% 0; }
  to { background-position: -200% 0; }
}

.sc-error-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 48px 0;
  color: var(--sc-text-secondary);
}

.sc-shortcut__sheet-layer {
  position: absolute;
  inset: 0;
  z-index: 3;
  display: flex;
  justify-content: flex-end;
  border-radius: inherit;
  background: color-mix(in srgb, var(--sc-bg-elevated) 35%, rgba(15, 23, 42, 0.32));
}

.sc-shortcut__sheet {
  width: min(420px, 100%);
  height: 100%;
  border-left: 1px solid var(--sc-border-strong);
  border-radius: 0 20px 20px 0;
  background: var(--sc-shortcut-surface);
  box-shadow: -18px 0 40px -24px rgba(15, 23, 42, 0.5);
}

.sc-banner-enter-active,
.sc-banner-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.sc-banner-enter-from,
.sc-banner-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

.sc-fade-enter-active,
.sc-fade-leave-active {
  transition: opacity 0.16s ease;
}

.sc-fade-enter-from,
.sc-fade-leave-to {
  opacity: 0;
}

.sc-sheet-enter-active,
.sc-sheet-leave-active {
  transition: opacity 0.22s ease;
}

.sc-sheet-enter-active .sc-shortcut__sheet,
.sc-sheet-leave-active .sc-shortcut__sheet {
  transition: transform 0.26s cubic-bezier(0.2, 0.8, 0.2, 1);
}

.sc-sheet-enter-from,
.sc-sheet-leave-to {
  opacity: 0;
}

.sc-sheet-enter-from .sc-shortcut__sheet,
.sc-sheet-leave-to .sc-shortcut__sheet {
  transform: translateX(32px);
}

@media (max-width: 640px) {
  .sc-shortcut {
    width: 100vw;
    height: 100dvh;
    border-radius: 0;
    border-width: 0;
  }

  .sc-shortcut.is-maintaining {
    box-shadow: inset 0 3px 0 var(--sc-shortcut-accent);
  }

  .sc-shortcut__header {
    padding: calc(12px + env(safe-area-inset-top)) 14px 10px;
  }

  .sc-shortcut__heading p {
    display: none;
  }

  .sc-shortcut__mode-toggle {
    padding-inline: 10px;
  }

  .sc-shortcut__banner {
    margin: 0 14px 8px;
  }

  .sc-shortcut__tabs {
    margin: 0 14px;
  }

  .sc-tab__caption {
    display: none;
  }

  .sc-shortcut__toolbar {
    flex-wrap: wrap;
    padding: 10px 14px 4px;
  }

  .sc-shortcut__search {
    flex-basis: 100%;
    max-width: none;
  }

  .sc-shortcut__body {
    padding: 12px 14px calc(24px + env(safe-area-inset-bottom));
  }

  .sc-shortcut__sheet-layer {
    align-items: flex-end;
  }

  .sc-shortcut__sheet {
    width: 100%;
    height: min(88dvh, 100%);
    border-left: 0;
    border-top: 1px solid var(--sc-border-strong);
    border-radius: 18px 18px 0 0;
  }

  .sc-sheet-enter-from .sc-shortcut__sheet,
  .sc-sheet-leave-to .sc-shortcut__sheet {
    transform: translateY(40px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .sc-shortcut,
  .sc-tabs__indicator,
  .sc-banner-enter-active,
  .sc-banner-leave-active,
  .sc-fade-enter-active,
  .sc-fade-leave-active,
  .sc-sheet-enter-active,
  .sc-sheet-leave-active,
  .sc-sheet-enter-active .sc-shortcut__sheet,
  .sc-sheet-leave-active .sc-shortcut__sheet {
    transition: none;
  }

  .sc-skeleton__card {
    animation: none;
  }
}
</style>

<style>
/* 快捷命令界面的共享令牌与基础控件（子组件共用，统一以 .sc-shortcut 为作用域）。 */
.sc-shortcut {
  --sc-shortcut-accent: var(--primary-color, #3388de);
  --sc-shortcut-personal: #8b5cf6;
  --sc-shortcut-world: #0ea5a4;
  --sc-shortcut-surface: color-mix(in srgb, var(--sc-bg-layer) 40%, var(--sc-bg-elevated));
  font-family: var(--sc-font-family);
}

:root[data-display-palette='night'] .sc-shortcut {
  --sc-shortcut-personal: #a78bfa;
  --sc-shortcut-world: #2dd4bf;
  --sc-shortcut-surface: color-mix(in srgb, var(--sc-bg-layer) 55%, var(--sc-bg-elevated));
}

.sc-shortcut .sc-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 32px;
  padding: 0 14px;
  border: 1px solid transparent;
  border-radius: 10px;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  transition: background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease, opacity 0.15s ease;
}

.sc-shortcut .sc-btn:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.sc-shortcut .sc-btn--primary {
  background: var(--sc-shortcut-accent);
  color: #fff;
}

.sc-shortcut .sc-btn--primary:not(:disabled):hover {
  background: color-mix(in srgb, var(--sc-shortcut-accent) 86%, #000);
}

.sc-shortcut .sc-btn--ghost {
  border-color: var(--sc-border-strong);
  background: transparent;
  color: var(--sc-text-primary);
}

.sc-shortcut .sc-btn--ghost:hover {
  border-color: color-mix(in srgb, var(--sc-shortcut-accent) 50%, var(--sc-border-strong));
  color: var(--sc-shortcut-accent);
}

.sc-shortcut .sc-btn--soft {
  height: 28px;
  padding: 0 10px;
  background: color-mix(in srgb, var(--sc-shortcut-accent) 12%, transparent);
  color: var(--sc-shortcut-accent);
  font-size: 12.5px;
}

.sc-shortcut .sc-btn--soft:hover {
  background: color-mix(in srgb, var(--sc-shortcut-accent) 20%, transparent);
}

.sc-shortcut .sc-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--sc-text-secondary);
  cursor: pointer;
}

.sc-shortcut .sc-icon-btn--lg {
  width: 34px;
  height: 34px;
}

.sc-shortcut .sc-icon-btn:not(:disabled):hover {
  background: var(--sc-chip-bg);
  color: var(--sc-text-primary);
}

.sc-shortcut .sc-icon-btn--danger:not(:disabled):hover {
  background: color-mix(in srgb, #ef4444 12%, transparent);
  color: #ef4444;
}

.sc-shortcut .sc-icon-btn:disabled {
  cursor: not-allowed;
  opacity: 0.35;
}

.sc-shortcut .sc-link-btn {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--sc-shortcut-accent);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

.sc-shortcut .sc-link-btn:hover {
  text-decoration: underline;
}

.sc-shortcut .sc-scope-dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  margin-right: 6px;
  border-radius: 999px;
  vertical-align: 1px;
}

.sc-shortcut .sc-scope-dot--personal { background: var(--sc-shortcut-personal); }
.sc-shortcut .sc-scope-dot--world { background: var(--sc-shortcut-world); }

.sc-shortcut .sc-scope-badge {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  gap: 4px;
  padding: 1px 7px 1px 6px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  line-height: 16px;
}

.sc-shortcut .sc-scope-badge::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: currentColor;
}

.sc-shortcut .sc-scope-badge--personal {
  color: var(--sc-shortcut-personal);
  background: color-mix(in srgb, var(--sc-shortcut-personal) 12%, transparent);
}

.sc-shortcut .sc-scope-badge--world {
  color: var(--sc-shortcut-world);
  background: color-mix(in srgb, var(--sc-shortcut-world) 12%, transparent);
}

.sc-shortcut .sc-tag {
  display: inline-flex;
  align-items: center;
  padding: 1px 7px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--sc-shortcut-accent) 10%, transparent);
  color: var(--sc-shortcut-accent);
  font-size: 11px;
  line-height: 16px;
  white-space: nowrap;
}

.sc-shortcut .sc-tag--muted {
  background: var(--sc-chip-bg);
  color: var(--sc-text-secondary);
}

.sc-shortcut .sc-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.sc-shortcut .sc-section__head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
}

.sc-shortcut .sc-section__title {
  margin: 0;
  font-size: 14px;
  font-weight: 650;
}

.sc-shortcut .sc-section__desc {
  margin: 3px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--sc-text-secondary);
}

.sc-shortcut .sc-empty-inline {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 10px;
  padding: 16px;
  border: 1px dashed var(--sc-border-strong);
  border-radius: 14px;
  font-size: 13px;
  color: var(--sc-text-secondary);
}

.sc-shortcut .sc-empty-inline__glyph {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 9px;
  background: var(--sc-chip-bg);
  color: var(--sc-shortcut-accent);
  font-size: 15px;
}
</style>
