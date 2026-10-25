<script setup lang="ts">
import ShortcutRuleMaintainBar from './ShortcutRuleMaintainBar.vue'
import { useRuleDragSort } from './useRuleDragSort'
import { SHORTCUT_RULE_SCOPE_LABELS, type ShortcutRule, type ShortcutRuleScope } from './types'

// 维护模式列表：按作用域分组，组内可拖拽/上下移动排序，每行带启停、编辑、删除。

export interface ShortcutMaintainGroup {
  key: string
  scope: ShortcutRuleScope
  rules: ShortcutRule[]
  editable: boolean
  emptyText: string
}

defineProps<{
  groups: ShortcutMaintainGroup[]
  overriddenIds: ReadonlySet<string>
  busyIds: ReadonlySet<string>
}>()

const emit = defineEmits<{
  (event: 'edit', rule: ShortcutRule): void
  (event: 'delete', rule: ShortcutRule): void
  (event: 'toggle', rule: ShortcutRule, enabled: boolean): void
  (event: 'reorder', scope: ShortcutRuleScope, ids: string[]): void
}>()

// 一个列表实例内每个作用域只有一组，拖拽分组键直接使用作用域
const drag = useRuleDragSort((scope, ids) => emit('reorder', scope as ShortcutRuleScope, ids))

const idsOf = (group: ShortcutMaintainGroup) => group.rules.map((rule) => rule.id)

const configBadge = (rule: ShortcutRule) => {
  if (rule.type === 'send_alias' && rule.config?.autoDelete) return '发后删除'
  if (rule.type === 'replace' && rule.config?.replaceInChat) return '含普通聊天'
  if (rule.type === 'message_action') return rule.config?.clickAction === 'insert' ? '插入输入框' : '立即发送'
  return ''
}
</script>

<template>
  <div class="sc-maintain-list">
    <section v-for="group in groups" :key="group.key" class="sc-maintain-group">
      <header class="sc-maintain-group__head">
        <span class="sc-scope-badge" :class="`sc-scope-badge--${group.scope}`">{{ SHORTCUT_RULE_SCOPE_LABELS[group.scope] }}</span>
        <span class="sc-maintain-group__count">{{ group.rules.length }} 条</span>
        <span v-if="!group.editable" class="sc-maintain-group__note">旁观身份只能查看世界规则</span>
      </header>
      <TransitionGroup tag="ul" name="sc-row" class="sc-maintain-group__rows">
        <li
          v-for="(rule, index) in group.rules"
          :key="rule.id"
          class="sc-maintain-row"
          :class="{
            'is-disabled': !rule.enabled,
            'is-dragging': drag.dragging.value?.id === rule.id,
            'is-drop-target': drag.overId.value === rule.id && drag.dragging.value?.id !== rule.id,
          }"
          @dragover="drag.onDragOver(group.scope, rule.id, $event)"
          @drop="drag.onDrop(group.scope, idsOf(group), rule.id, $event)"
        >
          <div class="sc-maintain-row__main">
            <span class="sc-maintain-row__trigger">{{ rule.trigger }}</span>
            <span class="sc-maintain-row__arrow" aria-hidden="true">→</span>
            <code class="sc-maintain-row__command">{{ rule.command }}</code>
          </div>
          <div class="sc-maintain-row__meta">
            <span v-if="configBadge(rule)" class="sc-tag">{{ configBadge(rule) }}</span>
            <span v-if="!rule.enabled" class="sc-tag sc-tag--muted">已停用</span>
            <span v-if="overriddenIds.has(rule.id)" class="sc-tag sc-tag--muted" title="你有同触发内容的个人规则，个人规则优先">被个人规则覆盖</span>
            <span v-if="group.scope === 'world' && rule.updatedByName" class="sc-maintain-row__author">{{ rule.updatedByName }} 更新</span>
          </div>
          <ShortcutRuleMaintainBar
            :rule="rule"
            :editable="group.editable"
            :can-move-up="index > 0"
            :can-move-down="index < group.rules.length - 1"
            :busy="busyIds.has(rule.id)"
            @toggle="emit('toggle', rule, $event)"
            @edit="emit('edit', rule)"
            @delete="emit('delete', rule)"
            @move="drag.move(group.scope, idsOf(group), rule.id, $event)"
            @drag-start="drag.onDragStart(group.scope, rule.id, $event)"
            @drag-end="drag.onDragEnd()"
          />
        </li>
      </TransitionGroup>
      <p v-if="!group.rules.length" class="sc-maintain-group__empty">{{ group.emptyText }}</p>
    </section>
  </div>
</template>

<style scoped>
.sc-maintain-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.sc-maintain-group__head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.sc-maintain-group__count,
.sc-maintain-group__note {
  font-size: 12px;
  color: var(--sc-text-secondary);
}

.sc-maintain-group__rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.sc-maintain-group__empty {
  margin: 0;
  padding: 10px 12px;
  border: 1px dashed var(--sc-border-strong);
  border-radius: 10px;
  font-size: 12.5px;
  color: var(--sc-text-secondary);
}

.sc-maintain-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 10px;
  padding: 8px 8px 8px 12px;
  border: 1px dashed color-mix(in srgb, var(--sc-shortcut-accent) 38%, var(--sc-border-strong));
  border-radius: 10px;
  background: var(--sc-shortcut-surface);
  transition: border-color 0.15s ease, opacity 0.15s ease, transform 0.15s ease;
}

.sc-maintain-row:hover {
  border-style: solid;
}

.sc-maintain-row.is-disabled .sc-maintain-row__main {
  opacity: 0.5;
}

.sc-maintain-row.is-dragging {
  opacity: 0.4;
}

.sc-maintain-row.is-drop-target {
  border-style: solid;
  border-color: var(--sc-shortcut-accent);
  box-shadow: 0 -2px 0 var(--sc-shortcut-accent);
}

.sc-maintain-row__main {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.sc-maintain-row__trigger {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}

.sc-maintain-row__arrow {
  flex: 0 0 auto;
  color: var(--sc-shortcut-accent);
}

.sc-maintain-row__command {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--sc-code-font);
  font-size: 12.5px;
  color: var(--sc-text-secondary);
}

.sc-maintain-row__meta {
  display: flex;
  align-items: center;
  gap: 6px;
  justify-content: flex-end;
}

.sc-maintain-row__author {
  font-size: 11px;
  color: var(--sc-text-secondary);
  white-space: nowrap;
}

.sc-row-move,
.sc-row-enter-active,
.sc-row-leave-active {
  transition: transform 0.2s ease, opacity 0.2s ease;
}

.sc-row-enter-from,
.sc-row-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

@media (max-width: 640px) {
  .sc-maintain-row {
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-areas:
      'main bar'
      'meta meta';
    row-gap: 4px;
  }

  .sc-maintain-row__main { grid-area: main; }
  .sc-maintain-row__meta { grid-area: meta; justify-content: flex-start; }
  .sc-maintain-row > :last-child { grid-area: bar; }
}

@media (prefers-reduced-motion: reduce) {
  .sc-row-move,
  .sc-row-enter-active,
  .sc-row-leave-active {
    transition: none;
  }
}
</style>
