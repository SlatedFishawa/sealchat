<script setup lang="ts">
import { computed } from 'vue'
import { NIcon } from 'naive-ui'
import { Plus as PlusIcon, Trash as AutoDeleteIcon } from '@vicons/tabler'
import ShortcutMaintainList, { type ShortcutMaintainGroup } from './ShortcutMaintainList.vue'
import { SHORTCUT_RULE_SCOPE_LABELS, type ShortcutRule, type ShortcutRuleScope, type ShortcutRuleType } from './types'

// 标签页一：快捷掷骰命令（send_alias 发送映射 + replace 命令替换）。
// 查看模式：映射卡片 + 替换词典；维护模式：按作用域分组的可编辑列表。

const props = defineProps<{
  personal: ShortcutRule[]
  world: ShortcutRule[]
  overriddenIds: ReadonlySet<string>
  busyIds: ReadonlySet<string>
  maintaining: boolean
  hasWorld: boolean
  canManageWorld: boolean
  filtered: boolean
}>()

const emit = defineEmits<{
  (event: 'create', type: ShortcutRuleType): void
  (event: 'edit', rule: ShortcutRule): void
  (event: 'delete', rule: ShortcutRule): void
  (event: 'toggle', rule: ShortcutRule, enabled: boolean): void
  (event: 'reorder', scope: ShortcutRuleScope, ids: string[]): void
}>()

const ofType = (rules: ShortcutRule[], type: ShortcutRuleType) => rules.filter((rule) => rule.type === type)

const aliasRules = computed(() => [...ofType(props.personal, 'send_alias'), ...ofType(props.world, 'send_alias')])
const replaceRules = computed(() => [...ofType(props.personal, 'replace'), ...ofType(props.world, 'replace')])

const replaceExample = computed(() => {
  const rule = replaceRules.value.find((item) => item.enabled && !props.overriddenIds.has(item.id))
  return rule ? { from: rule.trigger, to: rule.command } : { from: '力气', to: '力量' }
})

const buildGroups = (type: ShortcutRuleType): ShortcutMaintainGroup[] => {
  const groups: ShortcutMaintainGroup[] = [{
    key: `personal:${type}`,
    scope: 'personal',
    rules: ofType(props.personal, type),
    editable: true,
    emptyText: props.filtered ? '没有匹配的个人规则' : '还没有个人规则',
  }]
  if (props.hasWorld) {
    groups.push({
      key: `world:${type}`,
      scope: 'world',
      rules: ofType(props.world, type),
      editable: props.canManageWorld,
      emptyText: props.filtered ? '没有匹配的世界规则' : '还没有世界规则，成员都可以添加',
    })
  }
  return groups
}

const aliasGroups = computed(() => buildGroups('send_alias'))
const replaceGroups = computed(() => buildGroups('replace'))

const ruleState = (rule: ShortcutRule) => {
  if (!rule.enabled) return '已停用'
  if (props.overriddenIds.has(rule.id)) return '被个人规则覆盖'
  return ''
}
</script>

<template>
  <div class="sc-dice-panel">
    <!-- 发送映射 -->
    <section class="sc-section">
      <header class="sc-section__head">
        <div>
          <h3 class="sc-section__title">发送映射</h3>
          <p class="sc-section__desc">消息中出现触发词时，保留原消息，并以当前角色额外发送右侧命令</p>
        </div>
        <button v-if="maintaining" type="button" class="sc-btn sc-btn--soft" @click="emit('create', 'send_alias')">
          <NIcon :component="PlusIcon" size="14" />新建映射
        </button>
      </header>

      <ShortcutMaintainList
        v-if="maintaining"
        :groups="aliasGroups"
        :overridden-ids="overriddenIds"
        :busy-ids="busyIds"
        @edit="emit('edit', $event)"
        @delete="emit('delete', $event)"
        @toggle="(rule, enabled) => emit('toggle', rule, enabled)"
        @reorder="(scope, ids) => emit('reorder', scope, ids)"
      />
      <TransitionGroup v-else-if="aliasRules.length" tag="ul" name="sc-card" class="sc-alias-grid">
        <li
          v-for="rule in aliasRules"
          :key="rule.id"
          class="sc-alias-card"
          :class="{ 'is-inactive': !!ruleState(rule) }"
        >
          <div class="sc-alias-card__top">
            <span class="sc-alias-card__trigger" :title="rule.trigger">{{ rule.trigger }}</span>
            <span class="sc-scope-badge" :class="`sc-scope-badge--${rule.scope}`">{{ SHORTCUT_RULE_SCOPE_LABELS[rule.scope] }}</span>
          </div>
          <div class="sc-alias-card__wire" aria-hidden="true" />
          <div class="sc-alias-card__bottom">
            <code class="sc-alias-card__command" :title="rule.command">{{ rule.command }}</code>
            <span v-if="rule.config?.autoDelete" class="sc-alias-card__flag" title="发送成功后自动删除命令消息">
              <NIcon :component="AutoDeleteIcon" size="12" />发后删除
            </span>
            <span v-if="ruleState(rule)" class="sc-alias-card__state">{{ ruleState(rule) }}</span>
          </div>
        </li>
      </TransitionGroup>
      <div v-else class="sc-empty-inline">
        <span class="sc-empty-inline__glyph" aria-hidden="true">⌨</span>
        <span>{{ filtered ? '没有匹配的发送映射' : '把常用检定绑定成一个词，例如“力量检定 → .ra 力量”' }}</span>
        <button v-if="!filtered" type="button" class="sc-link-btn" @click="emit('create', 'send_alias')">添加第一条</button>
      </div>
    </section>

    <!-- 命令替换 -->
    <section class="sc-section">
      <header class="sc-section__head">
        <div>
          <h3 class="sc-section__title">命令替换</h3>
          <p class="sc-section__desc">
            默认只在骰子命令里替换；单条规则可开启普通聊天替换：
            <span class="sc-replace-example">
              <code>.ra {{ replaceExample.from }}</code><span aria-hidden="true">→</span><code>.ra {{ replaceExample.to }}</code>
            </span>
          </p>
        </div>
        <button v-if="maintaining" type="button" class="sc-btn sc-btn--soft" @click="emit('create', 'replace')">
          <NIcon :component="PlusIcon" size="14" />新建替换
        </button>
      </header>

      <ShortcutMaintainList
        v-if="maintaining"
        :groups="replaceGroups"
        :overridden-ids="overriddenIds"
        :busy-ids="busyIds"
        @edit="emit('edit', $event)"
        @delete="emit('delete', $event)"
        @toggle="(rule, enabled) => emit('toggle', rule, enabled)"
        @reorder="(scope, ids) => emit('reorder', scope, ids)"
      />
      <TransitionGroup v-else-if="replaceRules.length" tag="ul" name="sc-card" class="sc-replace-cloud">
        <li
          v-for="rule in replaceRules"
          :key="rule.id"
          class="sc-replace-pill"
          :class="[`sc-replace-pill--${rule.scope}`, { 'is-inactive': !!ruleState(rule) }]"
          :title="ruleState(rule) || `${SHORTCUT_RULE_SCOPE_LABELS[rule.scope]}规则`"
        >
          <span class="sc-replace-pill__from">{{ rule.trigger }}</span>
          <span class="sc-replace-pill__arrow" aria-hidden="true">⇢</span>
          <span class="sc-replace-pill__to">{{ rule.command }}</span>
        </li>
      </TransitionGroup>
      <div v-else class="sc-empty-inline">
        <span class="sc-empty-inline__glyph" aria-hidden="true">⇄</span>
        <span>{{ filtered ? '没有匹配的命令替换' : '统一技能别名，例如把“力气”替换为“力量”' }}</span>
        <button v-if="!filtered" type="button" class="sc-link-btn" @click="emit('create', 'replace')">添加第一条</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.sc-dice-panel {
  display: flex;
  flex-direction: column;
  gap: 26px;
}

.sc-alias-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(196px, 1fr));
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.sc-alias-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding: 12px 14px 12px;
  border: 1px solid var(--sc-border-mute);
  border-radius: 14px;
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--sc-shortcut-accent) 5%, transparent), transparent 70%),
    var(--sc-shortcut-surface);
  box-shadow: 0 1px 0 var(--sc-border-mute), 0 6px 18px -14px rgba(15, 23, 42, 0.35);
  transition: transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease;
}

.sc-alias-card:hover {
  transform: translateY(-1px);
  border-color: color-mix(in srgb, var(--sc-shortcut-accent) 35%, var(--sc-border-mute));
}

.sc-alias-card.is-inactive {
  opacity: 0.5;
}

.sc-alias-card__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}

.sc-alias-card__trigger {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 15.5px;
  font-weight: 650;
  letter-spacing: 0.01em;
}

/* 触发词 → 命令 的连线 */
.sc-alias-card__wire {
  position: relative;
  height: 1px;
  margin: 0 10px 0 2px;
  background: linear-gradient(90deg, var(--sc-border-strong), var(--sc-shortcut-accent));
}

.sc-alias-card__wire::after {
  content: '';
  position: absolute;
  right: -6px;
  top: -3.5px;
  border: 4px solid transparent;
  border-left: 6px solid var(--sc-shortcut-accent);
}

.sc-alias-card__bottom {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}

.sc-alias-card__command {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 3px 8px;
  border-radius: 7px;
  background: color-mix(in srgb, var(--sc-shortcut-accent) 10%, transparent);
  color: var(--sc-text-primary);
  font-family: var(--sc-code-font);
  font-size: 12.5px;
}

.sc-alias-card__flag {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--sc-text-secondary);
}

.sc-alias-card__state {
  flex: 0 0 auto;
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px dashed var(--sc-border-strong);
  font-size: 10.5px;
  color: var(--sc-text-secondary);
}

.sc-replace-example {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}

.sc-replace-example code {
  font-family: var(--sc-code-font);
  font-size: 11.5px;
}

.sc-replace-example span {
  color: var(--sc-shortcut-accent);
}

.sc-replace-cloud {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.sc-replace-pill {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  border-radius: 999px;
  border: 1px solid var(--sc-border-strong);
  background: var(--sc-shortcut-surface);
  font-size: 13px;
  overflow: hidden;
}

.sc-replace-pill > span {
  padding: 4px 10px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sc-replace-pill__from {
  color: var(--sc-text-secondary);
  text-decoration: line-through;
  text-decoration-color: color-mix(in srgb, var(--sc-text-secondary) 45%, transparent);
}

.sc-replace-pill__arrow {
  padding: 0 !important;
  color: var(--sc-shortcut-accent);
}

.sc-replace-pill__to {
  font-weight: 600;
  background: color-mix(in srgb, var(--sc-shortcut-accent) 10%, transparent);
}

.sc-replace-pill--world {
  border-style: solid;
}

.sc-replace-pill--personal {
  border-color: color-mix(in srgb, var(--sc-shortcut-personal) 55%, var(--sc-border-strong));
}

.sc-replace-pill.is-inactive {
  opacity: 0.45;
}

.sc-card-enter-active,
.sc-card-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.sc-card-enter-from,
.sc-card-leave-to {
  opacity: 0;
  transform: scale(0.97);
}

@media (max-width: 640px) {
  .sc-alias-grid {
    grid-template-columns: 1fr;
  }
}

@media (prefers-reduced-motion: reduce) {
  .sc-alias-card,
  .sc-card-enter-active,
  .sc-card-leave-active {
    transition: none;
  }
}
</style>
