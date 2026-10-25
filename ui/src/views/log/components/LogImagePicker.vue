<script setup lang="ts">
// 统一图片选择：预览当前图片，从工程素材或样式资源中选择，或现场上传并直接使用。
// 选择列表内联展开（不用浮层），在右栏与插入弹窗中都不与外层焦点管理冲突。
import { computed, ref } from 'vue';
import { Check, Photo, Upload, X } from '@vicons/tabler';
import { LOG_PROJECT_IMAGE_ACCEPT, type LogAssetLibrary } from '../composables/useLogAssetLibrary';
import { sameImageRef, type LogImageRef } from '../logAssetRefs';

const props = withDefaults(defineProps<{
  value: LogImageRef | null;
  library: LogAssetLibrary;
  /** 必选图片（插图页）：不提供清除。 */
  required?: boolean;
  disabled?: boolean;
  /** 初始展开选择列表（插入流程中直接给出候选）。 */
  defaultOpen?: boolean;
  emptyText?: string;
}>(), {
  required: false,
  disabled: false,
  defaultOpen: false,
  emptyText: '未选择图片',
});
const emit = defineEmits<{ (e: 'update:value', value: LogImageRef | null): void }>();

const open = ref(props.defaultOpen);
const fileInput = ref<HTMLInputElement | null>(null);
const lib = props.library;
const editable = computed(() => !props.disabled && lib.canEdit.value);
const info = computed(() => (props.value ? lib.describe(props.value) : null));
const busy = computed(() => lib.uploading.value > 0);

const pick = (image: LogImageRef) => {
  emit('update:value', image);
  open.value = false;
};
const onFile = async (event: Event) => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  const image = await lib.upload(file);
  if (image) pick(image);
};
const usedCount = (image: LogImageRef) =>
  (image.source === 'project' ? lib.projectUsages.value : lib.styleUsages.value).get(image.id)?.length || 0;
</script>

<template>
  <div class="log-img" :class="{ 'is-disabled': !editable }">
    <div class="log-img__current">
      <div class="log-img__preview" :class="{ 'is-missing': info?.missing }">
        <img v-if="value && lib.thumb(value)" :src="lib.thumb(value) || undefined" alt="" />
        <n-icon v-else :component="Photo" size="20" />
      </div>
      <div class="log-img__meta">
        <template v-if="value && info">
          <span class="log-img__name" :title="info.name">{{ info.name }}</span>
          <span class="log-img__sub">
            {{ info.sourceLabel }}<template v-if="info.missing"> · <em class="log-img__warn">已不可用</em></template>
          </span>
        </template>
        <template v-else>
          <span class="log-img__name is-empty">{{ emptyText }}</span>
          <span v-if="required" class="log-img__sub">插图页需要一张图片</span>
        </template>
      </div>
    </div>
    <div class="log-img__actions">
      <n-button size="tiny" :disabled="!editable" :loading="busy" @click="fileInput?.click()">
        <template #icon><n-icon :component="Upload" /></template>
        上传并使用
      </n-button>
      <n-button size="tiny" :disabled="!editable" :aria-expanded="open" @click="open = !open">
        {{ open ? '收起' : '从素材选择' }}
      </n-button>
      <n-button v-if="value && !required" size="tiny" quaternary :disabled="!editable" @click="emit('update:value', null)">
        <template #icon><n-icon :component="X" /></template>
        清除
      </n-button>
      <input ref="fileInput" type="file" class="log-img__file" :accept="LOG_PROJECT_IMAGE_ACCEPT" @change="onFile" />
    </div>

    <div v-if="open" class="log-img__picker">
      <div class="log-img__group">工程素材</div>
      <div v-if="lib.projectAssets.value.length" class="log-img__grid" role="listbox" aria-label="工程素材">
        <button
          v-for="a in lib.projectAssets.value"
          :key="a.id"
          type="button"
          role="option"
          class="log-img__cell"
          :class="{ 'is-on': sameImageRef(value, { source: 'project', id: a.id }) }"
          :aria-selected="sameImageRef(value, { source: 'project', id: a.id })"
          :title="a.name || '未命名图片'"
          :disabled="!editable"
          @click="pick({ source: 'project', id: a.id })"
        >
          <img v-if="lib.thumb({ source: 'project', id: a.id })" :src="lib.thumb({ source: 'project', id: a.id }) || undefined" alt="" />
          <n-icon v-else :component="Photo" size="18" />
          <span class="log-img__cell-name">{{ a.name || '未命名' }}</span>
          <i v-if="usedCount({ source: 'project', id: a.id })" class="log-img__badge">{{ usedCount({ source: 'project', id: a.id }) }}</i>
          <n-icon v-if="sameImageRef(value, { source: 'project', id: a.id })" class="log-img__check" :component="Check" size="14" />
        </button>
      </div>
      <p v-else class="log-img__hint">还没有工程素材，点击“上传并使用”添加。</p>

      <div class="log-img__group">样式资源<span>只读</span></div>
      <div v-if="lib.styleImages.value.length" class="log-img__grid" role="listbox" aria-label="样式资源">
        <button
          v-for="a in lib.styleImages.value"
          :key="a.id"
          type="button"
          role="option"
          class="log-img__cell"
          :class="{ 'is-on': sameImageRef(value, { source: 'style', id: a.id }) }"
          :aria-selected="sameImageRef(value, { source: 'style', id: a.id })"
          :title="`${a.path}（切换样式时会重新检查）`"
          :disabled="!editable"
          @click="pick({ source: 'style', id: a.id })"
        >
          <img v-if="lib.thumb({ source: 'style', id: a.id })" :src="lib.thumb({ source: 'style', id: a.id }) || undefined" alt="" />
          <n-icon v-else :component="Photo" size="18" />
          <span class="log-img__cell-name">{{ a.path.replace(/^assets\//, '') }}</span>
          <n-icon v-if="sameImageRef(value, { source: 'style', id: a.id })" class="log-img__check" :component="Check" size="14" />
        </button>
      </div>
      <p v-else class="log-img__hint">当前样式未提供图片资源。</p>
    </div>
  </div>
</template>

<style scoped>
.log-img {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  min-width: 0;
}

.log-img__current {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.log-img__preview {
  flex: 0 0 auto;
  width: 48px;
  height: 48px;
  border-radius: 6px;
  border: 1px solid var(--sc-border-strong, #e5e5e5);
  background: var(--sc-chip-bg, rgba(15, 23, 42, 0.05));
  display: grid;
  place-items: center;
  overflow: hidden;
  color: var(--sc-text-secondary, #666);
}

.log-img__preview.is-missing {
  border-color: #d03050;
}

.log-img__preview img,
.log-img__cell img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.log-img__meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 2px;
}

.log-img__name {
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.log-img__name.is-empty,
.log-img__sub,
.log-img__hint {
  font-size: 12px;
  color: var(--sc-text-secondary, #666);
}

.log-img__hint {
  margin: 2px 0 4px;
}

.log-img__warn {
  font-style: normal;
  color: #d03050;
}

.log-img__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.log-img__file {
  display: none;
}

.log-img__picker {
  border: 1px solid var(--sc-border-mute, #e5e5e5);
  border-radius: 8px;
  padding: 6px 8px 8px;
  max-height: 260px;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.log-img__group {
  font-size: 12px;
  font-weight: 600;
  color: var(--sc-text-secondary, #666);
  margin: 4px 0;
}

.log-img__group span {
  font-weight: 400;
  margin-left: 6px;
}

.log-img__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(64px, 1fr));
  gap: 6px;
  margin-bottom: 6px;
}

.log-img__cell {
  position: relative;
  aspect-ratio: 1;
  padding: 0;
  border: 1px solid var(--sc-border-strong, #e5e5e5);
  border-radius: 6px;
  background: var(--sc-chip-bg, rgba(15, 23, 42, 0.05));
  overflow: hidden;
  cursor: pointer;
  display: grid;
  place-items: center;
  color: var(--sc-text-secondary, #666);
  font: inherit;
}

.log-img__cell:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--primary-color, #2f6fde) 55%, var(--sc-border-strong, #e5e5e5));
}

.log-img__cell:focus-visible {
  outline: 2px solid var(--primary-color, #2f6fde);
  outline-offset: 1px;
}

.log-img__cell.is-on {
  border-color: var(--primary-color, #2f6fde);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--primary-color, #2f6fde) 25%, transparent);
}

.log-img__cell:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.log-img__cell-name {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 1px 4px;
  font-size: 10px;
  line-height: 1.4;
  color: #fff;
  background: rgba(0, 0, 0, 0.5);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.log-img__badge {
  position: absolute;
  top: 3px;
  left: 3px;
  min-width: 16px;
  padding: 0 4px;
  border-radius: 8px;
  font-size: 10px;
  font-style: normal;
  line-height: 16px;
  color: #fff;
  background: color-mix(in srgb, var(--primary-color, #2f6fde) 85%, #000);
}

.log-img__check {
  position: absolute;
  top: 3px;
  right: 3px;
  border-radius: 50%;
  color: #fff;
  background: var(--primary-color, #2f6fde);
}
</style>
