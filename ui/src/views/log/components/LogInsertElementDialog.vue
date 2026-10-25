<script setup lang="ts">
// 插入 LOG 元素：不涉及图片的元素一步插入；封面/插图页在同一弹窗内选择或上传图片后插入。
import { computed, ref, watch, type Component } from 'vue';
import {
  ArrowLeft,
  Blockquote,
  Book2,
  Bookmark,
  Components,
  Heading,
  ListNumbers,
  Movie,
  Photo,
  SeparatorHorizontal,
} from '@vicons/tabler';
import { LOG_ELEMENT_LABELS } from '@/services/log/logRenderer';
import type { LogElementType } from '@/types/log';
import type { LogAssetLibrary } from '../composables/useLogAssetLibrary';
import { elementNeedsImage, IMAGE_ELEMENT_TYPES, type LogImageRef } from '../logAssetRefs';
import LogImagePicker from './LogImagePicker.vue';

export interface LogInsertOption {
  type: LogElementType;
  disabled: boolean;
  reason: string;
}

const props = defineProps<{
  show: boolean;
  options: LogInsertOption[];
  canEdit: boolean;
  library: LogAssetLibrary;
}>();
const emit = defineEmits<{
  (e: 'update:show', value: boolean): void;
  (e: 'insert', type: LogElementType, image: LogImageRef | null): void;
}>();

const icons: Record<LogElementType, Component> = {
  cover: Book2,
  imagePlate: Photo,
  pageBreak: SeparatorHorizontal,
  transition: Movie,
  quote: Blockquote,
  prologue: Bookmark,
  epilogue: Bookmark,
  heading: Heading,
  toc: ListNumbers,
  custom: Components,
};

/** 正在为其选择图片的元素类型；null 表示类型网格。 */
const step = ref<LogElementType | null>(null);
const image = ref<LogImageRef | null>(null);
watch(() => props.show, (open) => {
  if (open) {
    step.value = null;
    image.value = null;
  }
});

const choose = (type: LogElementType) => {
  if (!IMAGE_ELEMENT_TYPES.has(type)) {
    emit('insert', type, null);
    return;
  }
  step.value = type;
  image.value = null;
};
const required = computed(() => !!step.value && elementNeedsImage(step.value));
const confirm = () => {
  if (!step.value || (required.value && !image.value)) return;
  emit('insert', step.value, image.value);
};
const confirmText = computed(() => (step.value === 'cover' && !image.value ? '插入（无图片）' : '插入'));
const cardHint = (type: LogElementType) => (type === 'imagePlate' ? '选择或上传图片' : type === 'cover' ? '可选配图' : '');
</script>

<template>
  <n-modal :show="show" preset="card" title="插入 LOG 元素" style="width: min(560px, 94vw)" @update:show="(v: boolean) => emit('update:show', v)">
    <div class="log-insert">
      <template v-if="!step">
        <p class="log-insert__hint">元素只属于 LOG 排版，不会写入聊天。</p>
        <div class="log-insert__grid">
          <button
            v-for="opt in options"
            :key="opt.type"
            type="button"
            class="log-insert__card"
            :disabled="opt.disabled || !canEdit"
            :title="opt.reason"
            @click="choose(opt.type)"
          >
            <n-icon :component="icons[opt.type]" size="22" />
            <span class="log-insert__label">{{ LOG_ELEMENT_LABELS[opt.type] }}</span>
            <span v-if="opt.disabled && opt.reason" class="log-insert__reason">{{ opt.reason }}</span>
            <span v-else-if="cardHint(opt.type)" class="log-insert__reason">{{ cardHint(opt.type) }}</span>
          </button>
        </div>
      </template>
      <template v-else>
        <div class="log-insert__step-head">
          <n-button size="small" quaternary @click="step = null">
            <template #icon><n-icon :component="ArrowLeft" /></template>
            返回
          </n-button>
          <strong>{{ LOG_ELEMENT_LABELS[step] }}</strong>
          <span class="log-insert__hint is-inline">{{ required ? '需要一张图片' : '图片可选' }}</span>
        </div>
        <LogImagePicker
          v-model:value="image"
          :library="library"
          :required="required"
          :disabled="!canEdit"
          default-open
          :empty-text="required ? '请选择或上传图片' : '不使用图片'"
        />
        <div class="log-insert__footer">
          <n-button size="small" @click="emit('update:show', false)">取消</n-button>
          <n-button size="small" type="primary" :disabled="!canEdit || (required && !image)" @click="confirm">{{ confirmText }}</n-button>
        </div>
      </template>
    </div>
  </n-modal>
</template>

<style scoped>
.log-insert {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.log-insert__hint {
  font-size: 12px;
  color: var(--sc-text-secondary, #475569);
  margin: 0;
}

.log-insert__hint.is-inline {
  margin-left: auto;
}

.log-insert__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(112px, 1fr));
  gap: 8px;
}

.log-insert__card {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 84px;
  padding: 10px 8px;
  border: 1px solid var(--sc-border-strong, rgba(15, 23, 42, 0.12));
  border-radius: 10px;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  transition: border-color 0.12s ease, background-color 0.12s ease, color 0.12s ease;
}

.log-insert__card:hover:not(:disabled) {
  border-color: var(--primary-color, #2f6fde);
  color: var(--primary-color, #2f6fde);
  background: color-mix(in srgb, var(--primary-color, #2f6fde) 7%, transparent);
}

.log-insert__card:focus-visible {
  outline: 2px solid var(--primary-color, #2f6fde);
  outline-offset: -2px;
}

.log-insert__card:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.log-insert__label {
  font-weight: 600;
}

.log-insert__reason {
  font-size: 11px;
  line-height: 1.3;
  color: var(--sc-text-secondary, #475569);
  text-align: center;
}

.log-insert__step-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.log-insert__footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
