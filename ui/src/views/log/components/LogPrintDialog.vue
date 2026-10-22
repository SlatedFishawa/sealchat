<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { FramePrintRange } from '@/services/log/pagination/logFrameHost';

const CHUNK_PAGES = 60;
const props = defineProps<{
  show: boolean;
  pageCount: number;
  busy: boolean;
  errorText?: string;
}>();
const emit = defineEmits<{
  (e: 'update:show', value: boolean): void;
  (e: 'print', range?: FramePrintRange): void;
}>();

const fromPage = ref<number | null>(1);
const toPage = ref<number | null>(1);
const chunks = computed<FramePrintRange[]>(() => {
  const total = Math.max(0, Math.floor(props.pageCount));
  const result: FramePrintRange[] = [];
  for (let from = 1; from <= total; from += CHUNK_PAGES) {
    result.push({ fromPage: from, toPage: Math.min(total, from + CHUNK_PAGES - 1) });
  }
  return result;
});
const customValid = computed(() => fromPage.value !== null
  && toPage.value !== null
  && Number.isInteger(fromPage.value)
  && Number.isInteger(toPage.value)
  && fromPage.value >= 1
  && toPage.value >= fromPage.value
  && toPage.value <= props.pageCount);

watch(() => [props.show, props.pageCount] as const, ([show, total]) => {
  if (!show) return;
  fromPage.value = 1;
  toPage.value = Math.min(Math.max(1, total), CHUNK_PAGES);
}, { immediate: true });

const close = () => {
  if (!props.busy) emit('update:show', false);
};
const printRange = (range: FramePrintRange) => emit('print', range);
const printCustom = () => {
  if (!customValid.value || fromPage.value === null || toPage.value === null) return;
  emit('print', { fromPage: fromPage.value, toPage: toPage.value });
};
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    title="分段打印 / 导出 PDF"
    style="width: min(560px, 94vw)"
    :closable="!busy"
    :mask-closable="!busy"
    :close-on-esc="!busy"
    @update:show="(value: boolean) => value ? undefined : close()"
  >
    <n-alert type="info" :show-icon="false" class="log-print__hint">
      当前章节共 {{ pageCount }} 页。长文档建议每次打印不超过 {{ CHUNK_PAGES }} 页；分段时只让所选页面进入浏览器打印树，可明显降低卡顿和内存峰值。系统打印窗口中选择“另存为 PDF”即可生成文件。
    </n-alert>

    <div class="log-print__section">
      <div class="log-print__label">推荐分段</div>
      <n-space size="small" wrap>
        <n-button
          v-for="range in chunks"
          :key="range.fromPage"
          size="small"
          :disabled="busy"
          @click="printRange(range)"
        >
          {{ range.fromPage }}–{{ range.toPage }} 页
        </n-button>
      </n-space>
    </div>

    <div class="log-print__section">
      <div class="log-print__label">自定义页码</div>
      <n-space align="center" size="small">
        <n-input-number v-model:value="fromPage" :min="1" :max="pageCount" :precision="0" :disabled="busy" />
        <span>至</span>
        <n-input-number v-model:value="toPage" :min="1" :max="pageCount" :precision="0" :disabled="busy" />
        <n-button type="primary" :loading="busy" :disabled="busy || !customValid" @click="printCustom">打印所选页</n-button>
      </n-space>
    </div>

    <n-alert v-if="errorText" type="error" :show-icon="false" class="log-print__error">{{ errorText }}</n-alert>

    <template #footer>
      <n-space justify="space-between" align="center">
        <n-text depth="3">如必须得到单个 PDF，仍可一次打印全部页面，但超长 LOG 可能明显变慢。</n-text>
        <n-space size="small">
          <n-button :disabled="busy" @click="close">关闭</n-button>
          <n-button :loading="busy" :disabled="busy" @click="emit('print')">仍打印全部</n-button>
        </n-space>
      </n-space>
    </template>
  </n-modal>
</template>

<style scoped>
.log-print__hint { margin-bottom: 18px; line-height: 1.65; }
.log-print__section + .log-print__section { margin-top: 18px; }
.log-print__label { margin-bottom: 8px; font-size: 13px; font-weight: 600; }
.log-print__error { margin-top: 18px; }
</style>
