<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, shallowReactive, watch } from 'vue'
import { NButton, NIcon, NInput, NModal, NProgress, NSelect, NSwitch, useDialog } from 'naive-ui'
import { AlertTriangle, ChevronDown, ChevronUp, CircleCheck, Download, FileImport, Loader, Photo, PhotoOff, Plus, Trash, X } from '@vicons/tabler'
import { useWorldClueStore, type WorldClueSummary } from '@/stores/worldClue'
import { uploadImageAttachment } from '@/views/chat/composables/useAttachmentUploader'
import {
  createWorldClueBatchItem,
  createWorldClueBatchItemsFromCsv,
  isBatchImageFile,
  isHttpImageUrl,
  isWorldClueBatchRunnable,
  runWorldClueBatch,
  setWorldClueBatchFolder,
  sharedWorldClueFolderOptions,
  validateWorldClueBatchItem,
  WORLD_CLUE_ROOT_FOLDER_LABEL,
  type WorldClueBatchAccess,
  type WorldClueBatchErrors,
  type WorldClueBatchItem,
  type WorldClueBatchSession,
} from './world-clue-batch-create'
import { buildWorldClueCsvTemplate, parseWorldClueCsvBytes, worldClueBatchLimitError, WorldClueCsvError, WORLD_CLUE_CSV_MAX_BYTES, WORLD_CLUE_CSV_MAX_ROWS } from './world-clue-batch-csv'

const props = defineProps<{ show: boolean; worldId: string; channelId: string; canManage: boolean; initialFolderId: string }>()
const emit = defineEmits<{
  (event: 'update:show', value: boolean): void
  (event: 'finished', result: { worldId: string; created: number; failed: number }): void
}>()

const store = useWorldClueStore()
const dialog = useDialog()

const accessOptions: { label: string; value: WorldClueBatchAccess }[] = [
  { label: '默认可查看', value: 'view' },
  { label: '默认不可见', value: 'none' },
]
// Placeholder <option> for import issues, so re-picking the default value still fires a change.
const UNRESOLVED = '\u0000unresolved'
const statusLabels = { pending: '待创建', creating: '创建中', created: '已创建', failed: '失败' } as const

const items = ref<WorldClueBatchItem[]>([])
const defaults = reactive({ folderId: '', defaultAccess: 'view' as WorldClueBatchAccess })
const filePreviewUrls = shallowReactive(new Map<string, string>())
const failedImageUrls = reactive(new Set<string>())
const expandedKey = ref('')
const onlyInvalid = ref(false)
const importing = ref(false)
const notice = ref<{ type: 'info' | 'error'; text: string } | null>(null)
const summary = ref('')
const running = ref(false)
const stopping = ref(false)
const progress = reactive({ total: 0, done: 0, current: '' })
const csvInputRef = ref<HTMLInputElement | null>(null)
const imageInputRef = ref<HTMLInputElement | null>(null)
let imageTargetKey = ''
// World the current item list belongs to; items never move to another world.
const boundWorldId = ref('')
let runToken = 0
let importToken = 0
let stopRequested = false
let unmounted = false

const folderOptions = computed(() => (store.currentWorldId === boundWorldId.value ? sharedWorldClueFolderOptions(store.folders) : []))
const folderIds = computed(() => new Set(folderOptions.value.map(option => option.id)))
const folderSelectOptions = computed(() => [
  { label: WORLD_CLUE_ROOT_FOLDER_LABEL, value: '' },
  ...folderOptions.value.map(option => ({ label: option.label, value: option.id })),
])
const errorsByKey = computed(() => {
  const result = new Map<string, WorldClueBatchErrors>()
  for (const item of items.value) {
    if (isWorldClueBatchRunnable(item)) result.set(item.key, validateWorldClueBatchItem(item, folderIds.value))
  }
  return result
})
const itemErrors = (item: WorldClueBatchItem): WorldClueBatchErrors => errorsByKey.value.get(item.key) || {}
const hasErrors = (item: WorldClueBatchItem) => Object.keys(itemErrors(item)).length > 0
const invalidCount = computed(() => items.value.filter(hasErrors).length)
const runnableItems = computed(() => items.value.filter(isWorldClueBatchRunnable))
const pendingCount = computed(() => items.value.filter(item => item.status === 'pending').length)
const failedCount = computed(() => items.value.filter(item => item.status === 'failed').length)
const createdCount = computed(() => items.value.filter(item => item.status === 'created').length)
const visibleItems = computed(() => (onlyInvalid.value ? items.value.filter(hasErrors) : items.value))
const startLabel = computed(() => {
  if (running.value) return stopping.value ? '正在停止…' : '创建中…'
  if (!pendingCount.value && failedCount.value) return `重试失败项（${failedCount.value}）`
  if (!runnableItems.value.length) return '开始创建'
  return `创建 ${runnableItems.value.length} 条线索`
})
const progressPercentage = computed(() => (progress.total ? Math.round(progress.done / progress.total * 100) : 0))
const locked = computed(() => running.value || importing.value)

function isContextCurrent() {
  return !unmounted && props.show && props.canManage && !!boundWorldId.value && props.worldId === boundWorldId.value && store.currentWorldId === boundWorldId.value
}

function folderLabel(folderId: string) {
  if (!folderId) return WORLD_CLUE_ROOT_FOLDER_LABEL
  return folderOptions.value.find(option => option.id === folderId)?.label || '（已失效的文件夹）'
}

function contentSummary(item: WorldClueBatchItem) {
  const text = item.content.replace(/\s+/g, ' ').trim()
  return text || '（无内容）'
}

function itemImagePreview(item: WorldClueBatchItem) {
  if (item.imageFile) return filePreviewUrls.get(item.key) || ''
  const url = item.imageUrl.trim()
  return isHttpImageUrl(url) && !failedImageUrls.has(url) ? url : ''
}

function revokePreview(key: string) {
  const url = filePreviewUrls.get(key)
  if (url) URL.revokeObjectURL(url)
  filePreviewUrls.delete(key)
}

function resetState() {
  importToken += 1
  filePreviewUrls.forEach(url => URL.revokeObjectURL(url))
  filePreviewUrls.clear()
  failedImageUrls.clear()
  items.value = []
  expandedKey.value = ''
  onlyInvalid.value = false
  importing.value = false
  notice.value = null
  summary.value = ''
  Object.assign(progress, { total: 0, done: 0, current: '' })
}

function openSession() {
  resetState()
  boundWorldId.value = props.worldId
  defaults.folderId = folderIds.value.has(props.initialFolderId) ? props.initialFolderId : ''
  defaults.defaultAccess = 'view'
}

function forceClose(reason: string) {
  resetState()
  boundWorldId.value = ''
  if (props.show) emit('update:show', false)
  if (reason) dialog.warning({ title: '批量创建已关闭', content: reason, positiveText: '知道了' })
}

watch(() => props.show, show => {
  if (show) openSession()
  else if (!running.value) {
    resetState()
    boundWorldId.value = ''
  }
}, { immediate: true })

// A world switch or permission loss discards the list: its folders and target
// world no longer apply. A running batch stops itself through isContextCurrent.
watch(() => [props.worldId, props.canManage] as const, () => {
  if (!props.show || running.value || !boundWorldId.value) return
  if (props.worldId !== boundWorldId.value) forceClose('当前世界已切换，未创建的条目已丢弃，避免写入错误的世界。')
  else if (!props.canManage) forceClose('你已没有管理此世界线索的权限。')
})

watch(folderIds, ids => {
  if (defaults.folderId && !ids.has(defaults.folderId)) defaults.folderId = ''
})

function addItem() {
  if (locked.value) return
  const limitError = worldClueBatchLimitError(items.value.length)
  if (limitError) {
    notice.value = { type: 'info', text: limitError }
    return
  }
  const item = createWorldClueBatchItem({ ...defaults })
  items.value.push(item)
  expandedKey.value = item.key
  summary.value = ''
}

function removeItem(item: WorldClueBatchItem) {
  if (running.value || item.status === 'creating') return
  revokePreview(item.key)
  if (expandedKey.value === item.key) expandedKey.value = ''
  items.value = items.value.filter(candidate => candidate.key !== item.key)
}

function clearItems(predicate: (item: WorldClueBatchItem) => boolean) {
  if (running.value) return
  items.value = items.value.filter(item => {
    if (!predicate(item)) return true
    revokePreview(item.key)
    if (expandedKey.value === item.key) expandedKey.value = ''
    return false
  })
  if (!items.value.length) summary.value = ''
}

function applyDefaultsToRunnable() {
  if (locked.value) return
  for (const item of runnableItems.value) {
    setWorldClueBatchFolder(item, defaults.folderId)
    item.defaultAccess = defaults.defaultAccess
    delete item.issues.defaultAccess
  }
}

function updateFolder(item: WorldClueBatchItem, folderId: string) {
  setWorldClueBatchFolder(item, folderId)
}

function updateAccess(item: WorldClueBatchItem, value: string) {
  item.defaultAccess = value === 'none' ? 'none' : 'view'
  delete item.issues.defaultAccess
}

function updateImageUrl(item: WorldClueBatchItem, value: string) {
  item.imageUrl = value
  failedImageUrls.delete(value.trim())
}

function toggleExpanded(item: WorldClueBatchItem) {
  expandedKey.value = expandedKey.value === item.key ? '' : item.key
}

function pickImage(item: WorldClueBatchItem) {
  if (running.value || !isWorldClueBatchRunnable(item)) return
  imageTargetKey = item.key
  imageInputRef.value?.click()
}

function handleImageChange(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  const item = items.value.find(candidate => candidate.key === imageTargetKey)
  imageTargetKey = ''
  if (!file || !item || running.value || !isWorldClueBatchRunnable(item)) return
  if (!isBatchImageFile(file)) {
    notice.value = { type: 'error', text: `“${file.name}”不是图片文件，已忽略` }
    return
  }
  revokePreview(item.key)
  filePreviewUrls.set(item.key, URL.createObjectURL(file))
  item.imageFile = file
  item.imageUrl = ''
  item.attachmentId = ''
}

function removeImage(item: WorldClueBatchItem) {
  if (running.value || !isWorldClueBatchRunnable(item)) return
  revokePreview(item.key)
  item.imageFile = null
  item.imageUrl = ''
  item.attachmentId = ''
}

async function handleCsvChange(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || locked.value) return
  const token = ++importToken
  importing.value = true
  notice.value = null
  summary.value = ''
  try {
    if (file.size > WORLD_CLUE_CSV_MAX_BYTES) {
      throw new WorldClueCsvError(`CSV 文件不能超过 ${WORLD_CLUE_CSV_MAX_BYTES / 1024 / 1024} MB`)
    }
    const limitError = worldClueBatchLimitError(items.value.length)
    if (limitError) throw new WorldClueCsvError(limitError)
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (token !== importToken || !isContextCurrent()) return
    const parsed = parseWorldClueCsvBytes(bytes, items.value.length)
    const imported = createWorldClueBatchItemsFromCsv(parsed.rows, { ...defaults }, folderOptions.value)
    items.value.push(...imported)
    const invalid = imported.filter(item => Object.keys(validateWorldClueBatchItem(item, folderIds.value)).length).length
    const parts = [`已从“${file.name}”读取 ${imported.length} 条（${parsed.encoding.toUpperCase()}）`]
    if (invalid) parts.push(`其中 ${invalid} 条需要修正`)
    if (parsed.ignoredColumns.length) parts.push(`已忽略未知列：${parsed.ignoredColumns.join('、')}`)
    notice.value = { type: 'info', text: `${parts.join('；')}。尚未写入，确认后点击创建。` }
  } catch (error) {
    if (token !== importToken) return
    notice.value = {
      type: 'error',
      text: error instanceof WorldClueCsvError ? error.message : `读取 CSV 失败：${error instanceof Error ? error.message : '未知错误'}`,
    }
  } finally {
    if (token === importToken) importing.value = false
  }
}

function downloadTemplate() {
  const blob = new Blob([buildWorldClueCsvTemplate()], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = 'world-clue-batch-template.csv'
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

function createSession(summaries: readonly WorldClueSummary[]): WorldClueBatchSession {
  const worldId = boundWorldId.value
  const channelId = props.channelId
  return {
    isCurrent: () => isContextCurrent() && boundWorldId.value === worldId,
    folderIds: () => folderIds.value,
    summaries: () => summaries,
    upload: async file => {
      const result = await uploadImageAttachment(file, { channelId, rootId: worldId, rootIdType: 'world_clue', skipCompression: true })
      return result.attachmentId.replace(/^id:/, '')
    },
    create: async payload => {
      const item = await store.saveClue(worldId, null, { ...payload })
      return { id: item.id }
    },
  }
}

async function start() {
  if (running.value || importing.value || !runnableItems.value.length) return
  if (invalidCount.value) {
    summary.value = `还有 ${invalidCount.value} 条需要修正，请先处理标红的字段`
    onlyInvalid.value = true
    return
  }
  if (!isContextCurrent()) {
    summary.value = '当前世界或权限已变化，无法创建'
    return
  }
  const worldId = boundWorldId.value
  const token = ++runToken
  stopRequested = false
  running.value = true
  stopping.value = false
  expandedKey.value = ''
  summary.value = ''
  Object.assign(progress, { total: runnableItems.value.length, done: 0, current: '' })
  const isCancelled = () => unmounted || stopRequested || token !== runToken
  let created = 0
  let failed = 0
  try {
    // Search results in store.summaries may omit the folder's largest orderIndex.
    // Read an unfiltered snapshot without changing the clue box's search state.
    const summaries = runnableItems.value.some(item => item.orderIndex === null)
      ? await store.fetchSummariesReadonly(worldId)
      : []
    if (isCancelled() || !isContextCurrent()) return
    const session = createSession(summaries)
    const result = await runWorldClueBatch(items.value, session, {
      isCancelled,
      onItemStart: item => { if (!unmounted && token === runToken) progress.current = item.title.trim() || '未命名线索' },
      onItemSettled: item => { if (!unmounted && token === runToken && item.status !== 'pending') progress.done += 1 },
    })
    created = result.created
    failed = result.failed
    if (unmounted || token !== runToken) return
    const parts = [`${result.created} 条成功`]
    if (result.failed) parts.push(`${result.failed} 条失败`)
    let text = parts.join('，')
    if (result.stopReason === 'user') text += '，其余已停止'
    else if (result.stopReason === 'context') text += '；世界或权限已变化，已停止后续创建'
    summary.value = text
  } catch (error) {
    if (!unmounted && token === runToken && isContextCurrent()) {
      summary.value = `读取线索顺序失败：${error instanceof Error ? error.message : '未知错误'}`
    }
  } finally {
    if (!unmounted && token === runToken && (created || failed)) emit('finished', { worldId, created, failed })
    if (!unmounted && token === runToken) {
      running.value = false
      stopping.value = false
      progress.current = ''
      if (props.show && props.worldId !== worldId) forceClose(`当前世界已切换，已停止批量创建（已创建 ${created} 条）。`)
      else if (props.show && !props.canManage) forceClose(`你已没有管理此世界线索的权限，已停止批量创建（已创建 ${created} 条）。`)
    }
  }
}

// The in-flight request finishes; its item keeps its result and the rest stay pending.
function stop() {
  if (!running.value) return
  stopRequested = true
  stopping.value = true
}

function close() {
  if (running.value) return
  const unfinished = runnableItems.value.length
  if (!unfinished) {
    emit('update:show', false)
    return
  }
  dialog.warning({
    title: '关闭批量创建',
    content: `还有 ${unfinished} 条未创建，关闭后这些条目将被丢弃。`,
    positiveText: '丢弃并关闭',
    negativeText: '继续编辑',
    onPositiveClick: () => { if (!running.value) emit('update:show', false) },
  })
}

onBeforeUnmount(() => {
  unmounted = true
  runToken += 1
  importToken += 1
  filePreviewUrls.forEach(url => URL.revokeObjectURL(url))
  filePreviewUrls.clear()
})
</script>

<template>
  <NModal :show="show" :mask-closable="false" :close-on-esc="!running" @update:show="(value: boolean) => { if (!value) close() }">
    <!-- Root must be a <div> without overflow clipping: Naive's focus trap only treats a div as the
         trapped content, and Select followers mount inside the modal root. -->
    <div class="clue-batch" role="dialog" aria-modal="true" aria-label="批量创建线索">
      <header class="clue-batch__header">
        <div>
          <strong>批量创建线索</strong>
          <small>先设置默认值，再手动添加或导入 CSV；点击创建前不会写入任何数据</small>
        </div>
        <NButton circle quaternary size="small" title="关闭" aria-label="关闭批量创建" :disabled="running" @click="close"><template #icon><NIcon><X /></NIcon></template></NButton>
      </header>

      <section class="clue-batch__defaults">
        <label class="clue-batch__default-field">
          <span>默认文件夹</span>
          <NSelect v-model:value="defaults.folderId" size="small" filterable :options="folderSelectOptions" :disabled="locked" />
        </label>
        <label class="clue-batch__default-field clue-batch__default-field--access">
          <span>默认可见性</span>
          <NSelect v-model:value="defaults.defaultAccess" size="small" :options="accessOptions" :disabled="locked" />
        </label>
        <NButton size="small" quaternary :disabled="locked || !runnableItems.length" title="把默认文件夹和可见性覆盖到所有未创建的条目" @click="applyDefaultsToRunnable">应用到未创建条目</NButton>
        <small class="clue-batch__hint">默认值只用于之后新增或导入的条目，不会改动已有条目。</small>
      </section>

      <section class="clue-batch__toolbar">
        <div class="clue-batch__toolbar-actions">
          <NButton size="small" :disabled="locked" @click="addItem"><template #icon><NIcon><Plus /></NIcon></template>添加一条</NButton>
          <NButton size="small" :loading="importing" :disabled="locked" @click="csvInputRef?.click()"><template #icon><NIcon><FileImport /></NIcon></template>导入 CSV</NButton>
          <NButton size="small" quaternary @click="downloadTemplate"><template #icon><NIcon><Download /></NIcon></template>下载 CSV 示例</NButton>
          <input ref="csvInputRef" class="clue-batch__input" type="file" accept=".csv,text/csv,text/plain" @change="handleCsvChange">
          <input ref="imageInputRef" class="clue-batch__input" type="file" accept="image/*" @change="handleImageChange">
        </div>
        <div class="clue-batch__counts">
          <span>共 {{ items.length }} 条</span>
          <span v-if="invalidCount" class="clue-batch__count--error"><NIcon><AlertTriangle /></NIcon>{{ invalidCount }} 条需修正</span>
          <span v-if="createdCount" class="clue-batch__count--success">{{ createdCount }} 条已创建</span>
          <label v-if="invalidCount || onlyInvalid" class="clue-batch__filter"><NSwitch v-model:value="onlyInvalid" size="small" />只看需修正</label>
          <NButton v-if="createdCount" text size="tiny" :disabled="running" @click="clearItems((item: WorldClueBatchItem) => item.status === 'created')">移除已创建</NButton>
          <NButton text size="tiny" :disabled="running || !items.length" @click="clearItems(() => true)">清空</NButton>
        </div>
      </section>
      <p v-if="notice" class="clue-batch__notice" :class="`clue-batch__notice--${notice.type}`">{{ notice.text }}</p>

      <div class="clue-batch__body">
        <div v-if="!items.length" class="clue-batch__empty">
          <span>还没有待创建的线索</span>
          <small>CSV 列：title（必填）、content、image_url、folder（如 调查记录/证物）、visibility（view / none）；单次批量最多 {{ WORLD_CLUE_CSV_MAX_ROWS }} 条线索</small>
        </div>
        <template v-else>
          <div class="clue-batch__row clue-batch__row--head" aria-hidden="true">
            <span>状态</span><span>图片</span><span>标题 / 内容</span><span>文件夹</span><span>可见性</span><span />
          </div>
          <ol class="clue-batch__list">
            <li v-for="item in visibleItems" :key="item.key" class="clue-batch__item" :class="[`is-${item.status}`, { 'has-error': hasErrors(item), 'is-expanded': expandedKey === item.key }]">
              <div class="clue-batch__row">
                <div class="clue-batch__status">
                  <NIcon v-if="item.status === 'creating'" class="is-spinning"><Loader /></NIcon>
                  <NIcon v-else-if="item.status === 'created'"><CircleCheck /></NIcon>
                  <NIcon v-else-if="item.status === 'failed' || hasErrors(item)"><AlertTriangle /></NIcon>
                  <span>{{ item.status === 'pending' && hasErrors(item) ? '需修正' : statusLabels[item.status] }}</span>
                  <small v-if="item.line !== null">第 {{ item.line }} 行</small>
                </div>
                <div class="clue-batch__image">
                  <button type="button" class="clue-batch__thumb" :class="{ 'is-error': itemErrors(item).imageUrl || itemErrors(item).imageFile }" :disabled="running || !isWorldClueBatchRunnable(item)" :title="item.imageFile ? item.imageFile.name : item.imageUrl || '选择本地图片'" @click="pickImage(item)">
                    <img v-if="itemImagePreview(item)" :src="itemImagePreview(item)" alt="" loading="lazy" :referrerpolicy="item.imageFile ? undefined : 'no-referrer'" @error="failedImageUrls.add(item.imageUrl.trim())">
                    <NIcon v-else-if="item.imageUrl.trim() || item.imageFile"><PhotoOff /></NIcon>
                    <NIcon v-else><Photo /></NIcon>
                  </button>
                  <NButton v-if="(item.imageFile || item.imageUrl) && isWorldClueBatchRunnable(item)" text size="tiny" :disabled="running" @click="removeImage(item)">移除</NButton>
                </div>
                <div class="clue-batch__main">
                  <input
                    v-model="item.title" class="clue-batch__control clue-batch__title" :class="{ 'is-error': itemErrors(item).title }"
                    placeholder="标题（必填）" :disabled="running || !isWorldClueBatchRunnable(item)" aria-label="标题"
                  >
                  <button type="button" class="clue-batch__summary-text" :title="item.content || '编辑内容'" @click="toggleExpanded(item)">{{ contentSummary(item) }}</button>
                </div>
                <div class="clue-batch__field">
                  <select class="clue-batch__control" :class="{ 'is-error': itemErrors(item).folder }" :value="item.issues.folder ? UNRESOLVED : item.folderId" :disabled="running || !isWorldClueBatchRunnable(item)" :title="item.issues.folder ? '请选择文件夹' : folderLabel(item.folderId)" aria-label="文件夹" @change="updateFolder(item, ($event.target as HTMLSelectElement).value)">
                    <option v-if="item.issues.folder" :value="UNRESOLVED" disabled>请选择文件夹</option>
                    <option v-else-if="item.folderId && !folderIds.has(item.folderId)" :value="item.folderId" disabled>（已失效的文件夹）</option>
                    <option v-for="option in folderSelectOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
                  </select>
                </div>
                <div class="clue-batch__field">
                  <select class="clue-batch__control" :class="{ 'is-error': itemErrors(item).defaultAccess }" :value="item.issues.defaultAccess ? UNRESOLVED : item.defaultAccess" :disabled="running || !isWorldClueBatchRunnable(item)" aria-label="默认可见性" @change="updateAccess(item, ($event.target as HTMLSelectElement).value)">
                    <option v-if="item.issues.defaultAccess" :value="UNRESOLVED" disabled>请选择</option>
                    <option v-for="option in accessOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
                  </select>
                </div>
                <div class="clue-batch__actions">
                  <NButton circle quaternary size="tiny" :title="expandedKey === item.key ? '收起' : '编辑内容与图片地址'" :aria-expanded="expandedKey === item.key" @click="toggleExpanded(item)"><template #icon><NIcon><component :is="expandedKey === item.key ? ChevronUp : ChevronDown" /></NIcon></template></NButton>
                  <NButton circle quaternary size="tiny" type="error" title="移除此条" :disabled="running" @click="removeItem(item)"><template #icon><NIcon><Trash /></NIcon></template></NButton>
                </div>
              </div>
              <ul v-if="hasErrors(item) || (item.status === 'failed' && item.error)" class="clue-batch__errors">
                <li v-for="(text, field) in itemErrors(item)" :key="field">{{ text }}</li>
                <li v-if="item.status === 'failed' && item.error && !hasErrors(item)">创建失败：{{ item.error }}</li>
              </ul>
              <div v-if="expandedKey === item.key" class="clue-batch__editor">
                <label>
                  <span>内容（纯文本，可留空）</span>
                  <NInput v-model:value="item.content" type="textarea" :autosize="{ minRows: 3, maxRows: 10 }" placeholder="线索内容" :disabled="running || !isWorldClueBatchRunnable(item)" />
                </label>
                <label v-if="!item.imageFile">
                  <span>图片地址（可选，http/https）</span>
                  <NInput :value="item.imageUrl" size="small" placeholder="https://" :status="itemErrors(item).imageUrl ? 'error' : undefined" :disabled="running || !isWorldClueBatchRunnable(item)" @update:value="updateImageUrl(item, $event)" />
                </label>
                <small v-else>已选择本地图片“{{ item.imageFile.name }}”，创建时上传；点击左侧缩略图可更换。</small>
              </div>
            </li>
          </ol>
          <div v-if="onlyInvalid && !visibleItems.length" class="clue-batch__empty clue-batch__empty--small">没有需要修正的条目</div>
        </template>
      </div>

      <footer class="clue-batch__footer">
        <div class="clue-batch__progress">
          <template v-if="running || progress.total">
            <NProgress type="line" :percentage="progressPercentage" :show-indicator="false" :status="failedCount ? 'warning' : 'default'" />
            <small v-if="running">{{ progress.done }} / {{ progress.total }}<template v-if="progress.current"> · 正在创建：{{ progress.current }}</template></small>
          </template>
          <small v-if="summary" class="clue-batch__summary">{{ summary }}</small>
        </div>
        <div class="clue-batch__footer-actions">
          <NButton v-if="running" :disabled="stopping" @click="stop">停止</NButton>
          <NButton v-else @click="close">关闭</NButton>
          <NButton type="primary" :loading="running" :disabled="running || importing || !runnableItems.length || invalidCount > 0" @click="start">{{ startLabel }}</NButton>
        </div>
      </footer>
    </div>
  </NModal>
</template>

<style scoped>
.clue-batch { display: flex; width: min(1120px, calc(100vw - 32px)); max-height: min(820px, calc(100dvh - 32px)); flex-direction: column; color: var(--sc-text-primary); border: 1px solid var(--sc-border-strong); border-radius: 8px; background: color-mix(in srgb, var(--sc-bg-surface) 96%, transparent); box-shadow: 0 18px 50px #0004; backdrop-filter: blur(14px); }
.clue-batch small { color: var(--sc-text-secondary); font-size: 11px; }
.clue-batch__header { display: flex; flex: none; align-items: center; justify-content: space-between; gap: 16px; padding: 13px 14px 11px 18px; border-bottom: 1px solid var(--sc-border-mute); }
.clue-batch__header > div { display: grid; min-width: 0; gap: 3px; }
.clue-batch__header strong { font-size: 15px; }
.clue-batch__defaults { display: flex; flex: none; flex-wrap: wrap; align-items: flex-end; gap: 8px 12px; padding: 12px 18px; border-bottom: 1px solid var(--sc-border-mute); background: color-mix(in srgb, var(--sc-bg-elevated) 88%, transparent); }
.clue-batch__default-field { display: grid; width: min(320px, 100%); gap: 4px; }
.clue-batch__default-field--access { width: 160px; }
.clue-batch__default-field > span { color: var(--sc-text-secondary); font-size: 12px; }
.clue-batch__hint { flex: 1 1 200px; padding-bottom: 6px; }
.clue-batch__toolbar { display: flex; flex: none; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; padding: 10px 18px; }
.clue-batch__toolbar-actions, .clue-batch__counts { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
.clue-batch__counts { color: var(--sc-text-secondary); font-size: 12px; }
.clue-batch__counts .n-icon { margin-right: 3px; vertical-align: -2px; }
.clue-batch__count--error { color: var(--sc-color-error, #d03050); }
.clue-batch__count--success { color: var(--sc-color-success, #18a058); }
.clue-batch__filter { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; }
.clue-batch__input { display: none; }
.clue-batch__notice { flex: none; margin: 0 18px 8px; padding: 7px 10px; font-size: 12px; line-height: 1.5; border: 1px solid var(--sc-border-mute); border-radius: 5px; word-break: break-word; }
.clue-batch__notice--info { color: var(--sc-text-primary); background: color-mix(in srgb, var(--primary-color, #3388de) 8%, transparent); }
.clue-batch__notice--error { color: var(--sc-color-error, #d03050); border-color: color-mix(in srgb, var(--sc-color-error, #d03050) 45%, var(--sc-border-mute)); background: color-mix(in srgb, var(--sc-color-error, #d03050) 7%, transparent); }
.clue-batch__body { min-height: 200px; flex: 1; overflow: auto; padding: 0 18px 12px; }
.clue-batch__empty { display: grid; min-height: 200px; place-items: center; align-content: center; gap: 8px; padding: 16px; color: var(--sc-text-secondary); font-size: 13px; text-align: center; border: 1px dashed var(--sc-border-mute); border-radius: 6px; }
.clue-batch__empty--small { min-height: 80px; margin-top: 6px; }
.clue-batch__row { display: grid; grid-template-columns: 76px 64px minmax(0, 1.7fr) minmax(130px, 1fr) 120px 60px; align-items: center; gap: 10px; }
.clue-batch__row--head { position: sticky; z-index: 1; top: 0; padding: 6px 9px; color: var(--sc-text-secondary); font-size: 11px; background: var(--sc-bg-surface); }
.clue-batch__list { display: flex; flex-direction: column; gap: 5px; margin: 0; padding: 0; list-style: none; }
.clue-batch__item { padding: 7px 9px; border: 1px solid var(--sc-border-mute); border-radius: 6px; background: color-mix(in srgb, var(--sc-bg-elevated) 92%, transparent); }
.clue-batch__item.is-creating { border-color: var(--primary-color, #3388de); }
.clue-batch__item.is-created { opacity: .7; }
.clue-batch__item.is-failed, .clue-batch__item.has-error { border-color: color-mix(in srgb, var(--sc-color-error, #d03050) 60%, var(--sc-border-mute)); }
.clue-batch__status { display: grid; grid-template-columns: auto 1fr; align-items: center; gap: 2px 4px; font-size: 12px; }
.clue-batch__status small { grid-column: 1 / -1; }
.is-created .clue-batch__status { color: var(--sc-color-success, #18a058); }
.is-failed .clue-batch__status, .has-error .clue-batch__status { color: var(--sc-color-error, #d03050); }
.is-spinning { animation: clue-batch-spin 1s linear infinite; }
@keyframes clue-batch-spin { to { transform: rotate(360deg); } }
.clue-batch__image { display: grid; justify-items: center; gap: 2px; }
.clue-batch__thumb { display: grid; width: 56px; height: 42px; padding: 0; overflow: hidden; place-items: center; color: var(--sc-text-secondary); font-size: 18px; border: 1px dashed var(--sc-border-mute); border-radius: 4px; background: color-mix(in srgb, var(--sc-bg-surface) 80%, transparent); cursor: pointer; }
.clue-batch__thumb:disabled { cursor: default; }
.clue-batch__thumb.is-error { border-color: var(--sc-color-error, #d03050); color: var(--sc-color-error, #d03050); }
.clue-batch__thumb img { display: block; width: 100%; height: 100%; object-fit: cover; }
.clue-batch__main { display: grid; min-width: 0; gap: 4px; }
.clue-batch__control { box-sizing: border-box; width: 100%; min-width: 0; height: 28px; padding: 0 8px; color: var(--sc-text-primary); font: inherit; font-size: 13px; border: 1px solid var(--sc-border-mute); border-radius: 4px; background: var(--sc-bg-surface); outline: none; }
.clue-batch__control:focus { border-color: var(--primary-color, #3388de); }
.clue-batch__control:disabled { opacity: .65; cursor: default; }
.clue-batch__control.is-error { border-color: var(--sc-color-error, #d03050); }
.clue-batch__control option { color: var(--sc-text-primary); background: var(--sc-bg-surface); }
select.clue-batch__control { padding-right: 4px; text-overflow: ellipsis; }
.clue-batch__summary-text { min-width: 0; padding: 0; overflow: hidden; color: var(--sc-text-secondary); font: inherit; font-size: 12px; text-align: left; text-overflow: ellipsis; white-space: nowrap; border: 0; background: transparent; cursor: pointer; }
.clue-batch__summary-text:hover { color: var(--sc-text-primary); }
.clue-batch__field { min-width: 0; }
.clue-batch__actions { display: flex; justify-content: flex-end; gap: 2px; }
.clue-batch__errors { margin: 6px 0 0; padding: 0 0 0 150px; color: var(--sc-color-error, #d03050); font-size: 12px; list-style: none; }
.clue-batch__editor { display: grid; gap: 8px; margin: 8px 0 2px 150px; padding-top: 8px; border-top: 1px dashed var(--sc-border-mute); }
.clue-batch__editor label { display: grid; gap: 4px; }
.clue-batch__editor label > span { color: var(--sc-text-secondary); font-size: 12px; }
.clue-batch__footer { display: flex; flex: none; align-items: center; justify-content: space-between; gap: 16px; padding: 10px 18px 14px; border-top: 1px solid var(--sc-border-mute); }
.clue-batch__progress { display: grid; min-width: 0; flex: 1; gap: 4px; }
.clue-batch__progress small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.clue-batch .clue-batch__summary { color: var(--sc-text-primary); }
.clue-batch__footer-actions { display: flex; gap: 8px; }
.clue-batch :deep(.n-input), .clue-batch :deep(.n-base-selection) { --n-box-shadow-hover: none !important; --n-box-shadow-focus: none !important; --n-box-shadow-active: none !important; --n-box-shadow-hover-warning: none !important; --n-box-shadow-focus-warning: none !important; --n-box-shadow-active-warning: none !important; --n-box-shadow-hover-error: none !important; --n-box-shadow-focus-error: none !important; --n-box-shadow-active-error: none !important; }
@media (max-width: 760px) {
  .clue-batch { width: 100vw; max-height: 100dvh; border-width: 0; border-radius: 0; }
  .clue-batch__default-field, .clue-batch__default-field--access { width: 100%; }
  .clue-batch__row--head { display: none; }
  .clue-batch__row { grid-template-columns: 64px minmax(0, 1fr) auto; grid-template-areas: 'image main actions' 'status folder access'; }
  .clue-batch__status { grid-area: status; }
  .clue-batch__image { grid-area: image; }
  .clue-batch__main { grid-area: main; }
  .clue-batch__field:nth-of-type(4) { grid-area: folder; }
  .clue-batch__field:nth-of-type(5) { grid-area: access; }
  .clue-batch__actions { grid-area: actions; }
  .clue-batch__errors, .clue-batch__editor { margin-left: 0; padding-left: 0; }
  .clue-batch__footer { flex-direction: column; align-items: stretch; }
  .clue-batch__footer-actions { justify-content: flex-end; }
}
</style>
