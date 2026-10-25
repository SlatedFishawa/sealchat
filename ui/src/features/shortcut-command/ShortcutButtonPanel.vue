<script setup lang="ts">
import { computed } from 'vue'
import { NIcon } from 'naive-ui'
import { Plus as PlusIcon } from '@vicons/tabler'
import ShortcutMaintainList, { type ShortcutMaintainGroup } from './ShortcutMaintainList.vue'
import { resolveMessageActionClick } from './ruleMatching'
import { SHORTCUT_RULE_SCOPE_LABELS, type ShortcutRule, type ShortcutRuleScope } from './types'

// 标签页二：快捷消息按钮（message_action）。
// 查看模式按点击行为分成“立即发送 / 插入输入框”两条泳道，每条规则以真实按钮样式展示。

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
  (event: 'create'): void
  (event: 'edit', rule: ShortcutRule): void
  (event: 'delete', rule: ShortcutRule): void
  (event: 'toggle', rule: ShortcutRule, enabled: boolean): void
  (event: 'reorder', scope: ShortcutRuleScope, ids: string[]): void
}>()

const actionRules = (rules: ShortcutRule[]) => rules.filter((rule) => rule.type === 'message_action')
const allRules = computed(() => [...actionRules(props.personal), ...actionRules(props.world)])

const lanes = computed(() => [
  {
    key: 'send',
    title: '点击即发送',
    desc: '以当前角色、差分和场内/场外状态立即发出',
    rules: allRules.value.filter((rule) => resolveMessageActionClick(rule) === 'send'),
  },
  {
    key: 'insert',
    title: '点击插入输入框',
    desc: '放到输入框光标处，补充参数后再发送',
    rules: allRules.value.filter((rule) => resolveMessageActionClick(rule) === 'insert'),
  },
])

const groups = computed<ShortcutMaintainGroup[]>(() => {
  const result: ShortcutMaintainGroup[] = [{
    key: 'personal',
    scope: 'personal',
    rules: actionRules(props.personal),
    editable: true,
    emptyText: props.filtered ? '没有匹配的个人按钮' : '个人按钮只在你看到的消息里出现',
  }]
  if (props.hasWorld) {
    result.push({
      key: 'world',
      scope: 'world',
      rules: actionRules(props.world),
      editable: props.canManageWorld,
      emptyText: props.filtered ? '没有匹配的世界按钮' : '世界按钮对所有成员生效，成员都可以添加',
    })
  }
  return result
})

const ruleState = (rule: ShortcutRule) => {
  if (!rule.enabled) return '已停用'
  if (props.overriddenIds.has(rule.id)) return '被个人规则覆盖'
  return ''
}
</script>

<template>
  <div class="sc-button-panel">
    <aside class="sc-button-intro">
      <div class="sc-button-intro__sample" aria-hidden="true">
        <span class="sc-button-intro__avatar" />
        <p>
          那我来一次<button type="button" tabindex="-1" class="shortcut-message-action shortcut-message-action--send">力量检定</button>，
          不行就<button type="button" tabindex="-1" class="shortcut-message-action shortcut-message-action--insert">侦查</button>一下。
        </p>
      </div>
      <p class="sc-button-intro__text">
        消息中出现关键词时显示为按钮。只在显示时增强，消息原文、导出与 LOG 都不会改变；规则修改或删除后，历史消息随之更新。
      </p>
    </aside>

    <template v-if="maintaining">
      <header class="sc-section__head">
        <div>
          <h3 class="sc-section__title">全部消息按钮</h3>
          <p class="sc-section__desc">个人按钮仅自己可见；世界按钮对全体成员生效</p>
        </div>
        <button type="button" class="sc-btn sc-btn--soft" @click="emit('create')">
          <NIcon :component="PlusIcon" size="14" />新建按钮
        </button>
      </header>
      <ShortcutMaintainList
        :groups="groups"
        :overridden-ids="overriddenIds"
        :busy-ids="busyIds"
        @edit="emit('edit', $event)"
        @delete="emit('delete', $event)"
        @toggle="(rule, enabled) => emit('toggle', rule, enabled)"
        @reorder="(scope, ids) => emit('reorder', scope, ids)"
      />
    </template>

    <div v-else-if="allRules.length" class="sc-lanes">
      <section v-for="lane in lanes" :key="lane.key" class="sc-lane" :class="`sc-lane--${lane.key}`">
        <header class="sc-lane__head">
          <h3 class="sc-section__title">{{ lane.title }}<span class="sc-lane__count">{{ lane.rules.length }}</span></h3>
          <p class="sc-section__desc">{{ lane.desc }}</p>
        </header>
        <TransitionGroup v-if="lane.rules.length" tag="ul" name="sc-card" class="sc-lane__list">
          <li v-for="rule in lane.rules" :key="rule.id" class="sc-specimen" :class="{ 'is-inactive': !!ruleState(rule) }">
            <span
              class="sc-specimen__button shortcut-message-action"
              :class="`shortcut-message-action--${lane.key}`"
              aria-hidden="true"
            >{{ rule.trigger }}</span>
            <code class="sc-specimen__command" :title="rule.command">{{ rule.command }}</code>
            <span class="sc-specimen__meta">
              <span v-if="ruleState(rule)" class="sc-tag sc-tag--muted">{{ ruleState(rule) }}</span>
              <span class="sc-scope-badge" :class="`sc-scope-badge--${rule.scope}`">{{ SHORTCUT_RULE_SCOPE_LABELS[rule.scope] }}</span>
            </span>
          </li>
        </TransitionGroup>
        <p v-else class="sc-lane__empty">暂无</p>
      </section>
    </div>

    <div v-else class="sc-empty-inline">
      <span class="sc-empty-inline__glyph" aria-hidden="true">◎</span>
      <span>{{ filtered ? '没有匹配的消息按钮' : '让聊天里的“力量检定”变成一点就掷的按钮' }}</span>
      <button v-if="!filtered" type="button" class="sc-link-btn" @click="emit('create')">添加第一个</button>
    </div>
  </div>
</template>

<style scoped>
.sc-button-panel {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.sc-button-intro {
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr);
  gap: 16px;
  align-items: center;
  padding: 14px 16px;
  border-radius: 14px;
  background:
    radial-gradient(120% 140% at 0% 0%, color-mix(in srgb, var(--sc-shortcut-accent) 12%, transparent), transparent 60%),
    var(--sc-chip-bg);
}

.sc-button-intro__sample {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}

.sc-button-intro__avatar {
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  border-radius: 999px;
  background: linear-gradient(135deg, color-mix(in srgb, var(--sc-shortcut-accent) 70%, #fff), color-mix(in srgb, var(--sc-shortcut-world) 60%, #000));
}

.sc-button-intro__sample p {
  margin: 0;
  padding: 7px 12px;
  border-radius: 4px 14px 14px 14px;
  background: var(--sc-shortcut-surface);
  font-size: 13.5px;
  line-height: 1.75;
}

.sc-button-intro__sample button {
  pointer-events: none;
}

.sc-button-intro__text {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--sc-text-secondary);
}

.sc-lanes {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.sc-lane {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  padding: 12px;
  border-radius: 14px;
  border: 1px solid var(--sc-border-mute);
}

.sc-lane--send {
  border-top: 3px solid var(--sc-shortcut-accent);
}

.sc-lane--insert {
  border-top: 3px dotted var(--sc-shortcut-accent);
}

.sc-lane__count {
  margin-left: 6px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--sc-chip-bg);
  font-size: 11px;
  font-weight: 500;
  color: var(--sc-text-secondary);
}

.sc-lane__list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.sc-lane__empty {
  margin: 0;
  font-size: 12.5px;
  color: var(--sc-text-secondary);
  opacity: 0.7;
}

.sc-specimen {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 10px;
  background: var(--sc-shortcut-surface);
  box-shadow: inset 0 0 0 1px var(--sc-border-mute);
}

.sc-specimen.is-inactive {
  opacity: 0.5;
}

.sc-specimen__button {
  max-width: 11em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13.5px;
  cursor: default;
}

.sc-specimen__command {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--sc-code-font);
  font-size: 12px;
  color: var(--sc-text-secondary);
}

.sc-specimen__meta {
  display: inline-flex;
  align-items: center;
  gap: 6px;
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

@media (max-width: 720px) {
  .sc-button-intro,
  .sc-lanes {
    grid-template-columns: 1fr;
  }
}

@media (prefers-reduced-motion: reduce) {
  .sc-card-enter-active,
  .sc-card-leave-active {
    transition: none;
  }
}
</style>
