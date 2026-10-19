<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import { NInput, NSwitch } from 'naive-ui'
import {
  SHORTCUT_COMMAND_MAX_LENGTH,
  SHORTCUT_RULE_TYPE_LABELS,
  SHORTCUT_TRIGGER_MAX_LENGTH,
  type ShortcutRule,
  type ShortcutRuleDraft,
  type ShortcutRuleType,
} from './types'

const props = defineProps<{
  /** 正在编辑的规则；为空表示新建 */
  rule: ShortcutRule | null
  type: ShortcutRuleType
  canUseWorld: boolean
  worldDisabledReason: string
  saving: boolean
  error: string
}>()

const emit = defineEmits<{
  (event: 'save', draft: ShortcutRuleDraft): void
  (event: 'cancel'): void
}>()

const draft = reactive<ShortcutRuleDraft>({
  scope: 'personal',
  type: props.type,
  trigger: '',
  command: '',
  enabled: true,
  config: {},
})
const triggerInputRef = ref<InstanceType<typeof NInput> | null>(null)

const resetDraft = () => {
  const source = props.rule
  draft.type = source?.type || props.type
  // 新建默认个人规则：世界规则影响全体成员，需要显式选择
  draft.scope = source?.scope || 'personal'
  draft.trigger = source?.trigger || ''
  draft.command = source?.command || ''
  draft.enabled = source ? source.enabled : true
  draft.config = {
    autoDelete: source?.config?.autoDelete === true,
    replaceInChat: source?.config?.replaceInChat === true,
    clickAction: source?.config?.clickAction === 'insert' ? 'insert' : 'send',
  }
}
resetDraft()
watch(() => [props.rule, props.type] as const, resetDraft)

onMounted(() => {
  nextTick(() => triggerInputRef.value?.focus())
})

const isEditing = computed(() => !!props.rule)
const title = computed(() => `${isEditing.value ? '编辑' : '新建'}${SHORTCUT_RULE_TYPE_LABELS[draft.type]}`)

const copy = computed(() => {
  switch (draft.type) {
    case 'send_alias':
      return {
        trigger: '消息中的触发词',
        triggerHint: '消息中出现它时，原消息照常发送，并额外执行映射命令',
        triggerPlaceholder: '例如：力量检定',
        command: '额外发送',
        commandPlaceholder: '例如：.ra 力量',
      }
    case 'replace':
      return {
        trigger: '要替换的词',
        triggerHint: '默认只在骰子命令里替换；可按规则开启普通聊天替换',
        triggerPlaceholder: '例如：力气',
        command: '替换为',
        commandPlaceholder: '例如：力量',
      }
    default:
      return {
        trigger: '消息中的关键词',
        triggerHint: '任何人的消息里出现它时，在你这里显示为可点击按钮',
        triggerPlaceholder: '例如：力量检定',
        command: '按钮执行的命令',
        commandPlaceholder: '例如：.ra 力量',
      }
  }
})

const previewTrigger = computed(() => draft.trigger.trim() || copy.value.triggerPlaceholder.replace(/^例如：/, ''))
const previewCommand = computed(() => draft.command.trim() || copy.value.commandPlaceholder.replace(/^例如：/, ''))

const canSave = computed(() => (
  !props.saving
  && !!draft.trigger.trim()
  && !!draft.command.trim()
  && !/[\r\n]/.test(draft.trigger)
))

const submit = () => {
  if (!canSave.value) return
  emit('save', {
    ...draft,
    trigger: draft.trigger.trim(),
    command: draft.command.trim(),
    config: draft.type === 'send_alias'
      ? { autoDelete: draft.config.autoDelete === true }
      : draft.type === 'replace'
        ? { replaceInChat: draft.config.replaceInChat === true }
      : draft.type === 'message_action'
        ? { clickAction: draft.config.clickAction === 'insert' ? 'insert' : 'send' }
        : {},
  })
}

const handleKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape') {
    event.stopPropagation()
    emit('cancel')
    return
  }
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && (event.target as HTMLElement)?.tagName === 'INPUT') {
    event.preventDefault()
    submit()
  }
}
</script>

<template>
  <div class="sc-rule-editor" role="dialog" :aria-label="title" @keydown="handleKeydown">
    <header class="sc-rule-editor__head">
      <div>
        <p class="sc-rule-editor__eyebrow">{{ isEditing ? '修改后立即保存' : '新规则' }}</p>
        <h3 class="sc-rule-editor__title">{{ title }}</h3>
      </div>
      <button type="button" class="sc-rule-editor__close" aria-label="取消编辑" @click="emit('cancel')">×</button>
    </header>

    <div class="sc-rule-editor__body">
      <div class="sc-rule-editor__field">
        <span class="sc-rule-editor__label">归属</span>
        <div class="sc-rule-editor__segmented" role="radiogroup" aria-label="规则归属">
          <button
            type="button"
            role="radio"
            :aria-checked="draft.scope === 'personal'"
            :class="{ 'is-active': draft.scope === 'personal' }"
            @click="draft.scope = 'personal'"
          >
            <span class="sc-scope-dot sc-scope-dot--personal" />个人
            <small>仅自己可见</small>
          </button>
          <button
            type="button"
            role="radio"
            :aria-checked="draft.scope === 'world'"
            :class="{ 'is-active': draft.scope === 'world' }"
            :disabled="!canUseWorld"
            :title="canUseWorld ? '' : worldDisabledReason"
            @click="draft.scope = 'world'"
          >
            <span class="sc-scope-dot sc-scope-dot--world" />世界
            <small>{{ canUseWorld ? '世界成员共同维护' : worldDisabledReason }}</small>
          </button>
        </div>
      </div>

      <label class="sc-rule-editor__field">
        <span class="sc-rule-editor__label">{{ copy.trigger }}</span>
        <NInput
          ref="triggerInputRef"
          v-model:value="draft.trigger"
          :maxlength="SHORTCUT_TRIGGER_MAX_LENGTH"
          :placeholder="copy.triggerPlaceholder"
          clearable
        />
        <span class="sc-rule-editor__hint">{{ copy.triggerHint }}</span>
      </label>

      <label class="sc-rule-editor__field">
        <span class="sc-rule-editor__label">{{ copy.command }}</span>
        <NInput
          v-model:value="draft.command"
          class="sc-rule-editor__command"
          :maxlength="SHORTCUT_COMMAND_MAX_LENGTH"
          :placeholder="copy.commandPlaceholder"
          clearable
        />
      </label>

      <div v-if="draft.type === 'message_action'" class="sc-rule-editor__field">
        <span class="sc-rule-editor__label">点击按钮时</span>
        <div class="sc-rule-editor__segmented" role="radiogroup" aria-label="点击行为">
          <button
            type="button"
            role="radio"
            :aria-checked="draft.config.clickAction !== 'insert'"
            :class="{ 'is-active': draft.config.clickAction !== 'insert' }"
            @click="draft.config.clickAction = 'send'"
          >
            立即发送<small>以当前角色发出命令</small>
          </button>
          <button
            type="button"
            role="radio"
            :aria-checked="draft.config.clickAction === 'insert'"
            :class="{ 'is-active': draft.config.clickAction === 'insert' }"
            @click="draft.config.clickAction = 'insert'"
          >
            插入输入框<small>放到光标处，可再修改</small>
          </button>
        </div>
      </div>

      <div v-if="draft.type === 'send_alias'" class="sc-rule-editor__toggle">
        <div>
          <strong>发送成功后自动删除命令消息</strong>
          <span>只留下骰子机器人的回复，频道更清爽</span>
        </div>
        <NSwitch v-model:value="draft.config.autoDelete" />
      </div>

      <div v-if="draft.type === 'replace'" class="sc-rule-editor__toggle">
        <div>
          <strong>同时替换普通聊天</strong>
          <span>关闭时只处理骰子/机器人命令，避免改写日常发言</span>
        </div>
        <NSwitch v-model:value="draft.config.replaceInChat" />
      </div>

      <div class="sc-rule-editor__toggle">
        <div>
          <strong>启用</strong>
          <span>停用后保留规则，但不再生效</span>
        </div>
        <NSwitch v-model:value="draft.enabled" />
      </div>

      <section class="sc-rule-editor__preview" aria-label="效果预览">
        <span class="sc-rule-editor__label">效果预览</span>
        <div v-if="draft.type === 'send_alias'" class="sc-preview-flow">
          <span class="sc-preview-flow__bubble">{{ previewTrigger }}</span>
          <span class="sc-preview-flow__arrow">原消息保留，并触发</span>
          <code class="sc-preview-flow__command">{{ previewCommand }}</code>
        </div>
        <div v-else-if="draft.type === 'replace'" class="sc-preview-flow">
          <code class="sc-preview-flow__command">.ra <del>{{ previewTrigger }}</del></code>
          <span class="sc-preview-flow__arrow">发送时</span>
          <code class="sc-preview-flow__command">.ra <ins>{{ previewCommand }}</ins></code>
        </div>
        <div v-else class="sc-preview-message">
          我准备做一次<button
            type="button"
            tabindex="-1"
            class="shortcut-message-action"
            :class="`shortcut-message-action--${draft.config.clickAction === 'insert' ? 'insert' : 'send'}`"
          >{{ previewTrigger }}</button>，大家看着点。
          <span class="sc-preview-message__caption">
            点击后{{ draft.config.clickAction === 'insert' ? '插入' : '发送' }}
            <code>{{ previewCommand }}</code>
          </span>
        </div>
      </section>

      <p v-if="error" class="sc-rule-editor__error" role="alert">{{ error }}</p>
    </div>

    <footer class="sc-rule-editor__foot">
      <button type="button" class="sc-btn sc-btn--ghost" @click="emit('cancel')">取消</button>
      <button type="button" class="sc-btn sc-btn--primary" :disabled="!canSave" @click="submit">
        {{ saving ? '保存中…' : '保存' }}
      </button>
    </footer>
  </div>
</template>

<style scoped>
.sc-rule-editor {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  background: var(--sc-shortcut-surface);
  color: var(--sc-text-primary);
}

.sc-rule-editor__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 18px 20px 10px;
}

.sc-rule-editor__eyebrow {
  margin: 0 0 2px;
  font-size: 11px;
  letter-spacing: 0.08em;
  color: var(--sc-shortcut-accent);
}

.sc-rule-editor__title {
  margin: 0;
  font-size: 17px;
  font-weight: 650;
}

.sc-rule-editor__close {
  width: 30px;
  height: 30px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--sc-text-secondary);
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
}

.sc-rule-editor__close:hover {
  background: var(--sc-chip-bg);
}

.sc-rule-editor__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 20px 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.sc-rule-editor__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.sc-rule-editor__label {
  font-size: 12px;
  font-weight: 600;
  color: var(--sc-text-secondary);
}

.sc-rule-editor__hint {
  font-size: 12px;
  color: var(--sc-text-secondary);
  opacity: 0.8;
}

.sc-rule-editor__command :deep(input) {
  font-family: var(--sc-code-font);
}

.sc-rule-editor__segmented {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.sc-rule-editor__segmented button {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 9px 12px;
  border: 1px solid var(--sc-border-strong);
  border-radius: 10px;
  background: transparent;
  color: var(--sc-text-primary);
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s ease, background-color 0.15s ease;
}

.sc-rule-editor__segmented button small {
  font-size: 11px;
  font-weight: 400;
  color: var(--sc-text-secondary);
}

.sc-rule-editor__segmented button.is-active {
  border-color: var(--sc-shortcut-accent);
  background: color-mix(in srgb, var(--sc-shortcut-accent) 10%, transparent);
}

.sc-rule-editor__segmented button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.sc-rule-editor__toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--sc-chip-bg);
}

.sc-rule-editor__toggle div {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.sc-rule-editor__toggle strong {
  font-size: 13px;
  font-weight: 600;
}

.sc-rule-editor__toggle span {
  font-size: 12px;
  color: var(--sc-text-secondary);
}

.sc-rule-editor__preview {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px dashed var(--sc-border-strong);
  border-radius: 12px;
}

.sc-preview-flow {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.sc-preview-flow__bubble {
  padding: 4px 10px;
  border-radius: 12px 12px 12px 4px;
  background: var(--sc-chip-bg);
}

.sc-preview-flow__arrow {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--sc-text-secondary);
}

.sc-preview-flow__arrow::after {
  content: '→';
  font-size: 14px;
  color: var(--sc-shortcut-accent);
}

.sc-preview-flow__command {
  padding: 3px 8px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--sc-shortcut-accent) 10%, transparent);
  font-family: var(--sc-code-font);
  font-size: 12.5px;
}

.sc-preview-flow__command del {
  opacity: 0.6;
}

.sc-preview-flow__command ins {
  text-decoration: none;
  color: var(--sc-shortcut-accent);
  font-weight: 600;
}

.sc-preview-message {
  font-size: 13.5px;
  line-height: 1.7;
}

.sc-preview-message__caption {
  display: block;
  margin-top: 4px;
  font-size: 12px;
  color: var(--sc-text-secondary);
}

.sc-preview-message__caption code {
  font-family: var(--sc-code-font);
}

.sc-rule-editor__error {
  margin: 0;
  padding: 8px 12px;
  border-radius: 8px;
  background: color-mix(in srgb, #ef4444 12%, transparent);
  color: color-mix(in srgb, #ef4444 80%, var(--sc-text-primary));
  font-size: 12.5px;
}

.sc-rule-editor__foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 20px calc(12px + env(safe-area-inset-bottom));
  border-top: 1px solid var(--sc-border-mute);
}

.sc-scope-dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  margin-right: 6px;
  border-radius: 999px;
  vertical-align: 1px;
}
</style>
