<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { useMessage } from 'naive-ui';
import { createLogStandardExport, describeLogError } from '@/services/log/logApi';
import { useChatStore } from '@/stores/chat';
import { useUtilsStore } from '@/stores/utils';
import type { LogDraftController } from '../composables/useLogDraft';

const props = defineProps<{ show: boolean; projectId: string; draftCtl: LogDraftController }>();
const emit = defineEmits<{ (e: 'update:show', value: boolean): void }>();
const chat = useChatStore();
const utils = useUtilsStore();
const toast = useMessage();
const busy = ref(false);
const errorText = ref('');
const cloudUploadUrl = ref('');
const form = reactive({
  format: 'txt' as 'txt' | 'docx' | 'html' | 'json',
  displayName: '',
  includeImages: false,
  removeDiceCommands: true,
  mergeMessages: true,
  withoutTimestamp: false,
  withoutOocParentheses: false,
  autoCorrectPunctuation: true,
  textBbcodeColorize: false,
  autoUpload: false,
});
const formats = [
  { label: '纯文本 (.txt)', value: 'txt' },
  { label: 'Word 文档 (.docx)', value: 'docx' },
  { label: 'HTML 网页包 (.zip)', value: 'html' },
  { label: '海豹染色器 JSON (.json)', value: 'json' },
];
const logUploadConfig = computed(() => utils.config?.logUpload);
const cloudUploadEnabled = computed(() => {
  const config = logUploadConfig.value;
  if (!config || config.enabled === false) return false;
  return [config.endpoint, ...(config.endpoints || [])].some((item) => !!String(item || '').trim());
});
const cloudUploadHint = computed(() => logUploadConfig.value?.note || '上传到云端后可继续使用海豹染色器生成 BBCode / DOCX 等结果。');
let generation = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
const stop = () => {
  generation += 1;
  if (timer) clearTimeout(timer);
  timer = null;
  busy.value = false;
};
watch(() => [props.show, props.projectId], stop);
onBeforeUnmount(stop);
watch([() => form.format, cloudUploadEnabled], ([format, uploadEnabled]) => {
  cloudUploadUrl.value = '';
  form.autoUpload = format === 'json' && uploadEnabled;
});

const updateShow = (value: boolean) => {
  if (!value && busy.value) return;
  emit('update:show', value);
};

const start = async () => {
  if (busy.value) return;
  busy.value = true;
  errorText.value = '';
  cloudUploadUrl.value = '';
  const run = ++generation;
  const projectId = props.projectId;
  const autoUpload = form.format === 'json' && form.autoUpload && cloudUploadEnabled.value;
  const active = () => run === generation && props.show && projectId === props.projectId;
  // Capture output options before the asynchronous draft flush.
  const options = {
    format: form.format,
    displayName: form.displayName,
    includeImages: form.includeImages,
    includeDiceCommands: !form.removeDiceCommands,
    mergeMessages: form.mergeMessages,
    withoutTimestamp: form.withoutTimestamp,
    withoutOocParentheses: form.withoutOocParentheses,
    autoCorrectPunctuation: form.autoCorrectPunctuation,
    textBbcodeColorize: form.format === 'txt' && form.textBbcodeColorize,
  };
  const fail = (error: unknown) => {
    if (!active()) return;
    errorText.value = describeLogError(error, '导出失败');
    busy.value = false;
  };
  try {
    const task = await props.draftCtl.runVersioned(async (expectedDraftVersion) => {
      if (!active()) throw new Error('导出已取消');
      const value = await createLogStandardExport(projectId, { ...options, expectedDraftVersion });
      return { value, draftVersion: null };
    });
    if (!active()) return;
    const poll = async () => {
      try {
        const state = await chat.getExportTaskStatus(task.task_id);
        if (!active()) return;
        if (state.status === 'failed') throw new Error(state.message || '导出失败');
        if (state.status === 'done') {
          const result = await chat.downloadExportResult(task.task_id, state.file_name);
          if (!active()) return;
          const url = URL.createObjectURL(result.blob);
          const link = document.createElement('a');
          link.href = url;
          link.download = result.fileName;
          document.body.appendChild(link);
          link.click();
          link.remove();
          URL.revokeObjectURL(url);
          if (autoUpload) {
            try {
              const upload = await chat.uploadExportTask(task.task_id);
              if (!active()) return;
              if (upload?.url) {
                cloudUploadUrl.value = upload.url;
                toast.success('海豹染色器上传完成');
              } else {
                toast.warning('海豹染色器上传完成，但未返回结果链接');
              }
            } catch (error: any) {
              const message = error?.response?.data?.error || error?.message || '未知错误';
              toast.warning(`海豹染色器上传失败：${message}`);
            }
          }
          busy.value = false;
          toast.success('导出完成');
          return;
        }
        timer = setTimeout(() => { timer = null; void poll(); }, 1200);
      } catch (error) {
        fail(error);
      }
    };
    void poll();
  } catch (error) {
    fail(error);
  }
};
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    title="传统格式导出"
    style="width: min(520px, 94vw)"
    :content-style="{ maxHeight: '75vh', overflowY: 'auto' }"
    :closable="!busy"
    :mask-closable="!busy"
    :close-on-esc="!busy"
    @update:show="updateShow"
  >
    <p class="log-export-hint">将按照当前 LOG 的章节与来源片段编排顺序导出消息。LOG 排版元素和页面样式不会进入传统格式文件。</p>
    <n-form label-placement="top" :disabled="busy">
      <n-form-item label="格式">
        <n-select v-model:value="form.format" :options="formats" />
      </n-form-item>
      <n-form-item label="导出文件名称（可选）">
        <n-input v-model:value="form.displayName" placeholder="默认使用 LOG 标题" :maxlength="120" />
      </n-form-item>
      <n-form-item label="格式选项">
        <n-space vertical>
          <n-checkbox v-if="form.format === 'txt'" v-model:checked="form.textBbcodeColorize">使用 BBCode 角色染色</n-checkbox>
          <template v-if="form.format === 'json' && cloudUploadEnabled">
            <n-checkbox v-model:checked="form.autoUpload">导出完成后上传到海豹染色器</n-checkbox>
            <n-text depth="3">{{ cloudUploadHint }}</n-text>
          </template>
          <n-checkbox v-model:checked="form.includeImages">包含图片</n-checkbox>
          <n-checkbox v-model:checked="form.removeDiceCommands">移除掷骰指令</n-checkbox>
          <n-checkbox v-model:checked="form.mergeMessages">合并连续消息（仅同一来源片段内）</n-checkbox>
          <n-checkbox v-model:checked="form.withoutTimestamp">不带时间戳</n-checkbox>
          <n-checkbox v-model:checked="form.withoutOocParentheses">场外不加括号</n-checkbox>
          <n-checkbox v-model:checked="form.autoCorrectPunctuation">自动纠正标点</n-checkbox>
        </n-space>
      </n-form-item>
    </n-form>
    <n-alert v-if="errorText" type="error">{{ errorText }}</n-alert>
    <n-alert v-if="cloudUploadUrl" type="success" title="海豹染色器上传完成">
      <n-a :href="cloudUploadUrl" target="_blank" rel="noopener noreferrer">打开云端染色结果</n-a>
    </n-alert>
    <p v-if="busy" role="status">正在生成…</p>
    <template #footer>
      <n-space justify="end">
        <n-button :disabled="busy" @click="updateShow(false)">关闭</n-button>
        <n-button type="primary" :loading="busy" :disabled="busy" @click="start">导出</n-button>
      </n-space>
    </template>
  </n-modal>
</template>

<style scoped>
.log-export-hint { margin: 0 0 20px; color: var(--n-text-color-3); line-height: 1.7; }
</style>
