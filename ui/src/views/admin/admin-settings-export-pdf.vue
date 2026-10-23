<script setup lang="ts">
import { useUtilsStore } from '@/stores/utils'
import { useDialog, useMessage } from 'naive-ui'
import { computed, onMounted, ref } from 'vue'

type ExportPDFConfig = {
  enabled: boolean
  renderer: string
  browserPath: string
  mergerPath: string
  workerConcurrency: number
  timeoutSeconds: number
  noSandbox: boolean
}
type ProbeAttempt = { path: string; source: string; error: string }
type ToolStatus = {
  available: boolean
  kind: string
  version: string
  path: string
  source: string
  error: string
  smokeTested: boolean
  attempts?: ProbeAttempt[]
}
type RuntimeStatus = {
  enabled: boolean
  renderer: string
  probed: boolean
  probing: boolean
  checkedAt: number
  browser: ToolStatus
  merger: ToolStatus
}
type ExportPDFResponse = {
  config: ExportPDFConfig
  status: RuntimeStatus
  limits?: { maxWorkerConcurrency: number; minTimeoutSeconds: number; maxTimeoutSeconds: number }
}

const utils = useUtilsStore()
const message = useMessage()
const dialog = useDialog()

const defaultConfig = (): ExportPDFConfig => ({
  enabled: true,
  renderer: 'chromium-cli',
  browserPath: '',
  mergerPath: '',
  workerConcurrency: 1,
  timeoutSeconds: 120,
  noSandbox: false,
})

const model = ref<ExportPDFConfig>(defaultConfig())
const status = ref<RuntimeStatus | null>(null)
const limits = ref({ maxWorkerConcurrency: 4, minTimeoutSeconds: 15, maxTimeoutSeconds: 1800 })
const loading = ref(false)
const saving = ref(false)
const probing = ref(false)
const originalSnapshot = ref('')

const snapshotOf = (value: ExportPDFConfig) => JSON.stringify(value)
const isModified = computed(() => snapshotOf(model.value) !== originalSnapshot.value)

const apply = (data: ExportPDFResponse) => {
  model.value = { ...defaultConfig(), ...(data.config || {}) }
  originalSnapshot.value = snapshotOf(model.value)
  status.value = data.status || null
  if (data.limits) limits.value = data.limits
}

const errorOf = (error: any, fallback: string) => error?.response?.data?.message || error?.message || fallback

const load = async () => {
  loading.value = true
  try {
    apply((await utils.adminExportPDFGet()).data as ExportPDFResponse)
  } catch (error: any) {
    message.error(errorOf(error, '加载 PDF 导出配置失败'))
  } finally {
    loading.value = false
  }
}

const doSave = async () => {
  saving.value = true
  try {
    apply((await utils.adminExportPDFUpdate({ ...model.value })).data as ExportPDFResponse)
    message.success('已保存')
  } catch (error: any) {
    message.error(errorOf(error, '保存 PDF 导出配置失败'))
  } finally {
    saving.value = false
  }
}

const save = async () => {
  if (model.value.noSandbox && !JSON.parse(originalSnapshot.value || '{}').noSandbox) {
    await new Promise<void>((resolve) => {
      dialog.warning({
        title: '关闭 Chromium 沙箱',
        content: '关闭沙箱会降低渲染进程的隔离强度，只应在容器等无法启用沙箱的环境中使用。确定保存吗？',
        positiveText: '仍然保存',
        negativeText: '取消',
        onPositiveClick: () => { void doSave().finally(resolve) },
        onNegativeClick: () => resolve(),
        onClose: () => resolve(),
      })
    })
    return
  }
  await doSave()
}

const probe = async () => {
  probing.value = true
  try {
    const data = (await utils.adminExportPDFProbe()).data as ExportPDFResponse
    status.value = data.status || null
    if (data.status?.probing) message.info('检测仍在进行，请稍后刷新')
    else message.success(data.status?.browser?.available ? '检测完成：渲染器可用' : '检测完成：渲染器不可用')
  } catch (error: any) {
    message.error(errorOf(error, '重新检测失败'))
  } finally {
    probing.value = false
  }
}

const sourceText: Record<string, string> = {
  config: '手动配置',
  tools: 'tools 目录',
  path: 'PATH',
  fallback: '系统常见位置',
}
const formatTime = (value?: number) => (value ? new Date(value).toLocaleString() : '未检测')

const toolRows = (tool: ToolStatus | undefined) => {
  if (!tool) return []
  return [
    ['状态', tool.available ? '可用' : '不可用'],
    ['类型', tool.kind || '—'],
    ['版本', tool.version || '—'],
    ['路径', tool.path || '—'],
    ['来源', sourceText[tool.source] || tool.source || '—'],
    ['冒烟测试', tool.smokeTested ? '通过' : '未通过'],
  ]
}
const browserRows = computed(() => toolRows(status.value?.browser))
const mergerRows = computed(() => toolRows(status.value?.merger))
const runtimeText = computed(() => {
  const item = status.value
  if (!item) return '未知'
  if (!item.enabled) return '已关闭'
  if (item.probing || !item.probed) return '检测中'
  return item.browser?.available ? '可用' : '不可用'
})

onMounted(load)

defineExpose({
  save,
  isModified: () => isModified.value,
})
</script>

<template>
  <div class="admin-export-pdf">
    <n-alert type="info" title="后台 LOG PDF 导出" class="admin-export-pdf__notice">
      SealChat 不内置浏览器。Linux Server 推荐安装 chrome-headless-shell，可放在程序目录的
      <code>tools/chrome-headless-shell/</code> 下自动发现，或填写下方路径。安装 pdfunite（poppler-utils）或 qpdf
      后，超长 LOG 会合并为单个 PDF；否则输出分段 PDF 压缩包。渲染器不可用时，用户仍可使用浏览器打印。
    </n-alert>

    <div class="admin-export-pdf__grid">
      <n-card title="配置" :bordered="false" class="admin-export-pdf__card">
        <n-spin :show="loading || saving">
          <n-form label-placement="left" label-width="120">
            <n-form-item label="启用后台 PDF">
              <n-switch v-model:value="model.enabled" />
            </n-form-item>
            <n-form-item label="浏览器路径" feedback="留空时自动发现：tools 目录 → PATH → 系统常见位置。填写后只使用该路径。">
              <n-input v-model:value="model.browserPath" clearable placeholder="例如 /opt/chrome-headless-shell/chrome-headless-shell" />
            </n-form-item>
            <n-form-item label="合并工具路径" feedback="pdfunite 或 qpdf；留空自动发现。">
              <n-input v-model:value="model.mergerPath" clearable placeholder="例如 /usr/bin/pdfunite" />
            </n-form-item>
            <n-form-item label="并发任务数" :feedback="`同时运行的 PDF 任务上限（1–${limits.maxWorkerConcurrency}）；每个任务会启动一个浏览器进程。`">
              <n-input-number v-model:value="model.workerConcurrency" :min="1" :max="limits.maxWorkerConcurrency" :precision="0" />
            </n-form-item>
            <n-form-item label="单段超时（秒）" :feedback="`单个分段渲染的最长时间（${limits.minTimeoutSeconds}–${limits.maxTimeoutSeconds}）。`">
              <n-input-number v-model:value="model.timeoutSeconds" :min="limits.minTimeoutSeconds" :max="limits.maxTimeoutSeconds" :precision="0" />
            </n-form-item>
            <n-form-item label="关闭沙箱">
              <div class="admin-export-pdf__sandbox">
                <n-switch v-model:value="model.noSandbox" />
                <span v-if="model.noSandbox" class="admin-export-pdf__risk">已关闭 Chromium 沙箱：仅在容器等无法启用沙箱的环境中使用，存在安全风险。</span>
                <span v-else class="admin-export-pdf__muted">默认启用沙箱。</span>
              </div>
            </n-form-item>
          </n-form>
        </n-spin>
      </n-card>

      <n-card title="运行时状态" :bordered="false" class="admin-export-pdf__card">
        <n-spin :show="probing">
          <div class="admin-export-pdf__actions">
            <n-button size="small" @click="load">刷新</n-button>
            <n-button size="small" type="primary" :loading="probing" :disabled="!model.enabled && !status?.enabled" @click="probe">重新探测</n-button>
          </div>
          <div class="admin-export-pdf__row"><span>总体</span><strong>{{ runtimeText }}</strong></div>
          <div class="admin-export-pdf__row"><span>最近检测</span><strong>{{ formatTime(status?.checkedAt) }}</strong></div>

          <n-divider title-placement="left">浏览器渲染器</n-divider>
          <div v-if="status?.browser?.error" class="admin-export-pdf__error">{{ status.browser.error }}</div>
          <div v-for="row in browserRows" :key="`b-${row[0]}`" class="admin-export-pdf__row"><span>{{ row[0] }}</span><strong>{{ row[1] }}</strong></div>
          <details v-if="status?.browser?.attempts?.length" class="admin-export-pdf__attempts">
            <summary>已尝试 {{ status.browser.attempts.length }} 个候选</summary>
            <div v-for="(a, i) in status.browser.attempts" :key="`ba-${i}`" class="admin-export-pdf__attempt">
              <code>{{ a.path }}</code>（{{ sourceText[a.source] || a.source }}）：{{ a.error }}
            </div>
          </details>

          <n-divider title-placement="left">PDF 合并工具</n-divider>
          <div v-if="status?.merger?.error" class="admin-export-pdf__error">{{ status.merger.error }}</div>
          <div v-for="row in mergerRows" :key="`m-${row[0]}`" class="admin-export-pdf__row"><span>{{ row[0] }}</span><strong>{{ row[1] }}</strong></div>
          <details v-if="status?.merger?.attempts?.length" class="admin-export-pdf__attempts">
            <summary>已尝试 {{ status.merger.attempts.length }} 个候选</summary>
            <div v-for="(a, i) in status.merger.attempts" :key="`ma-${i}`" class="admin-export-pdf__attempt">
              <code>{{ a.path }}</code>（{{ sourceText[a.source] || a.source }}）：{{ a.error }}
            </div>
          </details>
        </n-spin>
      </n-card>
    </div>
  </div>
</template>

<style scoped>
.admin-export-pdf {
  max-height: 61vh;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 4px 8px 18px 4px;
  scrollbar-gutter: stable;
}
.admin-export-pdf__notice { margin-bottom: 12px; line-height: 1.7; }
.admin-export-pdf__grid {
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(300px, 0.9fr);
  gap: 14px;
}
.admin-export-pdf__actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; margin-bottom: 10px; }
.admin-export-pdf__sandbox { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.admin-export-pdf__risk { color: var(--error-color, #d03050); font-size: 13px; }
.admin-export-pdf__muted { opacity: 0.7; font-size: 13px; }
.admin-export-pdf__row {
  display: flex;
  gap: 12px;
  justify-content: space-between;
  padding: 4px 0;
  font-size: 13px;
}
.admin-export-pdf__row strong { min-width: 0; overflow-wrap: anywhere; text-align: right; font-weight: 500; }
.admin-export-pdf__error {
  margin-bottom: 6px;
  padding: 8px 10px;
  border-radius: 6px;
  font-size: 13px;
  overflow-wrap: anywhere;
  color: var(--error-color, #d03050);
  background: rgba(208, 48, 80, 0.08);
}
.admin-export-pdf__attempts { margin-top: 6px; font-size: 12px; }
.admin-export-pdf__attempt { padding: 2px 0; overflow-wrap: anywhere; opacity: 0.85; }
@media (max-width: 900px) {
  .admin-export-pdf__grid { grid-template-columns: minmax(0, 1fr); }
}
</style>
