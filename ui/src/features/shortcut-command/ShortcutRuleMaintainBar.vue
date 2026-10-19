<script setup lang="ts">
import { NIcon, NPopconfirm, NSwitch } from 'naive-ui'
import {
  ChevronDown as DownIcon,
  ChevronUp as UpIcon,
  GripVertical as GripIcon,
  Lock as LockIcon,
  Pencil as EditIcon,
  Trash as DeleteIcon,
} from '@vicons/tabler'
import type { ShortcutRule } from './types'

// 维护模式下每条规则的管理控件；查看模式不渲染。

defineProps<{
  rule: ShortcutRule
  editable: boolean
  canMoveUp: boolean
  canMoveDown: boolean
  busy?: boolean
}>()

const emit = defineEmits<{
  (event: 'toggle', enabled: boolean): void
  (event: 'edit'): void
  (event: 'delete'): void
  (event: 'move', delta: number): void
  (event: 'drag-start', nativeEvent: DragEvent): void
  (event: 'drag-end'): void
}>()
</script>

<template>
  <div v-if="editable" class="sc-maintain-bar" @click.stop>
    <span
      class="sc-maintain-bar__grip"
      draggable="true"
      title="拖动排序"
      aria-hidden="true"
      @dragstart="emit('drag-start', $event)"
      @dragend="emit('drag-end')"
    >
      <NIcon :component="GripIcon" size="16" />
    </span>
    <span class="sc-maintain-bar__moves">
      <button type="button" class="sc-icon-btn" :disabled="!canMoveUp || busy" aria-label="上移" @click="emit('move', -1)">
        <NIcon :component="UpIcon" size="14" />
      </button>
      <button type="button" class="sc-icon-btn" :disabled="!canMoveDown || busy" aria-label="下移" @click="emit('move', 1)">
        <NIcon :component="DownIcon" size="14" />
      </button>
    </span>
    <NSwitch
      size="small"
      :value="rule.enabled"
      :disabled="busy"
      :aria-label="rule.enabled ? '停用规则' : '启用规则'"
      @update:value="emit('toggle', $event)"
    />
    <button type="button" class="sc-icon-btn" :disabled="busy" aria-label="编辑规则" title="编辑" @click="emit('edit')">
      <NIcon :component="EditIcon" size="15" />
    </button>
    <NPopconfirm positive-text="删除" negative-text="取消" :positive-button-props="{ type: 'error', size: 'small' }" @positive-click="emit('delete')">
      <template #trigger>
        <button type="button" class="sc-icon-btn sc-icon-btn--danger" :disabled="busy" aria-label="删除规则" title="删除">
          <NIcon :component="DeleteIcon" size="15" />
        </button>
      </template>
      删除「{{ rule.trigger }}」？
    </NPopconfirm>
  </div>
  <span v-else class="sc-maintain-bar sc-maintain-bar--locked" title="旁观者不能维护世界规则">
    <NIcon :component="LockIcon" size="13" />只读
  </span>
</template>

<style scoped>
.sc-maintain-bar {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
}

.sc-maintain-bar__grip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 28px;
  color: var(--sc-text-secondary);
  cursor: grab;
  opacity: 0.7;
}

.sc-maintain-bar__grip:active {
  cursor: grabbing;
}

.sc-maintain-bar__moves {
  display: none;
}

.sc-maintain-bar--locked {
  gap: 4px;
  font-size: 11px;
  color: var(--sc-text-secondary);
}

/* 触屏设备没有可用的原生拖拽：改用上下移动按钮 */
@media (hover: none), (max-width: 640px) {
  .sc-maintain-bar__grip {
    display: none;
  }

  .sc-maintain-bar__moves {
    display: inline-flex;
    gap: 2px;
  }
}
</style>
