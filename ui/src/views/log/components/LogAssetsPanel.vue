<script setup lang="ts">
// 素材：当前 LOG 工程的图片素材管理（上传、查看引用、移除登记），并列出当前样式提供的只读图片。
// 这里是集中入口，不是唯一入口：背景、封面、插图的选择处都能直接上传。
import { computed, ref } from 'vue';
import { Photo, Upload } from '@vicons/tabler';
import { LOG_ELEMENT_LABELS } from '@/services/log/logRenderer';
import { describeImageUsage, LOG_PROJECT_IMAGE_ACCEPT, type LogAssetLibrary } from '../composables/useLogAssetLibrary';
import type { LogImageRef, LogImageUsage } from '../logAssetRefs';

const props = defineProps<{ library: LogAssetLibrary }>();
const emit = defineEmits<{
  (e: 'locate-element', elementId: string): void;
  (e: 'open-page'): void;
}>();

const lib = props.library;
const fileInput = ref<HTMLInputElement | null>(null);
const selected = ref<LogImageRef | null>(null);

const onFiles = async (event: Event) => {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files || []);
  input.value = '';
  let last: LogImageRef | null = null;
  // 逐个上传：沿用附件上传的大小/压缩规则，失败的文件单独提示。
  for (const file of files) last = (await lib.upload(file)) || last;
  if (last) selected.value = last;
};

const usagesOf = (image: LogImageRef): LogImageUsage[] =>
  (image.source === 'project' ? lib.projectUsages.value : lib.styleUsages.value).get(image.id) || [];
const selectedInfo = computed(() => (selected.value ? lib.describe(selected.value) : null));
const selectedUsages = computed(() => (selected.value ? usagesOf(selected.value) : []));
const isSelected = (image: LogImageRef) => selected.value?.source === image.source && selected.value.id === image.id;
const toggle = (image: LogImageRef) => {
  selected.value = isSelected(image) ? null : image;
};
const remove = () => {
  const image = selected.value;
  if (image?.source === 'project' && lib.remove(image.id)) selected.value = null;
};
const usageLabel = (u: LogImageUsage) => describeImageUsage(u, LOG_ELEMENT_LABELS);
const projectUnused = computed(() => lib.projectAssets.value.filter((a) => !lib.projectUsages.value.has(a.id)).length);
</script>

<template>
  <div class="log-assets">
    <section>
      <div class="log-assets__head">
        <div class="log-assets__title">工程素材（{{ lib.projectAssets.value.length }}）</div>
        <n-button size="small" type="primary" secondary :disabled="!lib.canEdit.value" :loading="lib.uploading.value > 0" @click="fileInput?.click()">
          <template #icon><n-icon :component="Upload" /></template>
          上传图片
        </n-button>
        <input ref="fileInput" type="file" multiple class="log-assets__file" :accept="LOG_PROJECT_IMAGE_ACCEPT" @change="onFiles" />
      </div>
      <p class="log-assets__hint">
        上传的图片属于本 LOG，可用于页面背景、封面与插图；切换样式不会影响它们。<template v-if="projectUnused">其中 {{ projectUnused }} 张未使用。</template>
      </p>
      <div v-if="lib.projectAssets.value.length" class="log-assets__grid">
        <button
          v-for="a in lib.projectAssets.value"
          :key="a.id"
          type="button"
          class="log-assets__card"
          :class="{ 'is-on': isSelected({ source: 'project', id: a.id }) }"
          :aria-pressed="isSelected({ source: 'project', id: a.id })"
          :title="a.name || '未命名图片'"
          @click="toggle({ source: 'project', id: a.id })"
        >
          <span class="log-assets__thumb">
            <img v-if="lib.thumb({ source: 'project', id: a.id })" :src="lib.thumb({ source: 'project', id: a.id }) || undefined" alt="" />
            <n-icon v-else :component="Photo" size="22" />
          </span>
          <span class="log-assets__name">{{ a.name || '未命名' }}</span>
          <span class="log-assets__state" :class="{ 'is-used': usagesOf({ source: 'project', id: a.id }).length }">
            {{ usagesOf({ source: 'project', id: a.id }).length ? `使用中 ×${usagesOf({ source: 'project', id: a.id }).length}` : '未使用' }}
          </span>
        </button>
      </div>
      <n-empty v-else size="small" description="还没有工程素材" />
    </section>

    <section v-if="selected && selectedInfo" class="log-assets__detail" aria-live="polite">
      <div class="log-assets__detail-head">
        <strong :title="selectedInfo.name">{{ selectedInfo.name }}</strong>
        <n-tag size="tiny" :type="selected.source === 'project' ? 'info' : 'default'" :bordered="false">{{ selectedInfo.sourceLabel }}</n-tag>
      </div>
      <p v-if="!selectedUsages.length" class="log-assets__hint">当前没有被引用。</p>
      <ul v-else class="log-assets__usages">
        <li v-for="(u, i) in selectedUsages" :key="`${u.kind}-${u.elementId || i}`">
          <span>{{ usageLabel(u) }}</span>
          <n-button v-if="u.kind === 'element' && u.elementId" size="tiny" quaternary @click="emit('locate-element', u.elementId)">编辑</n-button>
          <n-button v-else size="tiny" quaternary @click="emit('open-page')">编辑</n-button>
        </li>
      </ul>
      <template v-if="selected.source === 'project'">
        <p v-if="selectedUsages.length" class="log-assets__hint">正在使用的素材不能移除；请先在上述位置替换或清除图片。</p>
        <n-popconfirm v-else @positive-click="remove">
          <template #trigger>
            <n-button size="small" type="error" quaternary :disabled="!lib.canEdit.value">从本 LOG 移除</n-button>
          </template>
          只移除本 LOG 的素材登记，不删除已上传的文件。确定移除？
        </n-popconfirm>
      </template>
      <p v-else class="log-assets__hint">样式资源随样式包提供，只读；切换样式时会按兼容规则重新检查。</p>
    </section>

    <section>
      <div class="log-assets__title">当前样式资源（{{ lib.styleImages.value.length }}）<span class="log-assets__ro">只读</span></div>
      <div v-if="lib.styleImages.value.length" class="log-assets__grid">
        <button
          v-for="a in lib.styleImages.value"
          :key="a.id"
          type="button"
          class="log-assets__card is-style"
          :class="{ 'is-on': isSelected({ source: 'style', id: a.id }) }"
          :aria-pressed="isSelected({ source: 'style', id: a.id })"
          :title="a.path"
          @click="toggle({ source: 'style', id: a.id })"
        >
          <span class="log-assets__thumb">
            <img v-if="lib.thumb({ source: 'style', id: a.id })" :src="lib.thumb({ source: 'style', id: a.id }) || undefined" alt="" />
            <n-icon v-else :component="Photo" size="22" />
          </span>
          <span class="log-assets__name">{{ a.path.replace(/^assets\//, '') }}</span>
          <span class="log-assets__state" :class="{ 'is-used': usagesOf({ source: 'style', id: a.id }).length }">
            {{ usagesOf({ source: 'style', id: a.id }).length ? `使用中 ×${usagesOf({ source: 'style', id: a.id }).length}` : '未使用' }}
          </span>
        </button>
      </div>
      <p v-else class="log-assets__hint">当前样式没有提供图片资源。</p>
    </section>
  </div>
</template>

<style scoped>
.log-assets {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 8px 0 16px;
}

.log-assets > section + section {
  padding-top: 14px;
  border-top: 1px solid var(--sc-border-mute, #e5e5e5);
}

.log-assets__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.log-assets__title {
  font-weight: 600;
  font-size: 12px;
  letter-spacing: 0.02em;
  color: var(--sc-text-secondary, #666);
}

.log-assets > section > .log-assets__title {
  margin-bottom: 8px;
}

.log-assets__ro {
  font-weight: 400;
  margin-left: 6px;
}

.log-assets__hint {
  font-size: 12px;
  color: var(--sc-text-secondary, #666);
  margin: 6px 0;
}

.log-assets__file {
  display: none;
}

.log-assets__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(92px, 1fr));
  gap: 8px;
}

.log-assets__card {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  padding: 4px;
  border: 1px solid var(--sc-border-strong, #e5e5e5);
  border-radius: 8px;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.12s ease, box-shadow 0.12s ease;
}

.log-assets__card:hover {
  border-color: color-mix(in srgb, var(--primary-color, #2f6fde) 45%, var(--sc-border-strong, #e5e5e5));
}

.log-assets__card:focus-visible {
  outline: 2px solid var(--primary-color, #2f6fde);
  outline-offset: 1px;
}

.log-assets__card.is-on {
  border-color: var(--primary-color, #2f6fde);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary-color, #2f6fde) 12%, transparent);
}

.log-assets__thumb {
  aspect-ratio: 4 / 3;
  border-radius: 5px;
  overflow: hidden;
  display: grid;
  place-items: center;
  background: var(--sc-chip-bg, rgba(15, 23, 42, 0.05));
  color: var(--sc-text-secondary, #666);
}

.log-assets__card.is-style .log-assets__thumb {
  background-image: repeating-linear-gradient(45deg, transparent 0 6px, color-mix(in srgb, var(--sc-text-secondary, #666) 8%, transparent) 6px 12px);
}

.log-assets__thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.log-assets__name {
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.log-assets__state {
  font-size: 11px;
  color: var(--sc-text-secondary, #666);
}

.log-assets__state.is-used {
  color: var(--primary-color, #2f6fde);
}

.log-assets__detail {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.log-assets__detail-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.log-assets__detail-head strong {
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.log-assets__usages {
  list-style: none;
  margin: 0;
  padding: 0;
  font-size: 13px;
}

.log-assets__usages li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 2px 0;
}
</style>
