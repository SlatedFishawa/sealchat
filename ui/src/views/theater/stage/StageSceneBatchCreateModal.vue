<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowReactive, watch } from 'vue'
import { NButton, NColorPicker, NIcon, NInput, NModal, NProgress, NRadio, NRadioGroup, NSlider, NSwitch } from 'naive-ui'
import { AlertTriangle, CircleCheck, Folder, Loader, Photo, Trash, X } from '@vicons/tabler'
import NSelect from '@/components/NSelect.vue'
import type { SceneFolder, StageSurfaceFit } from '../shared/stage-types'
import { createDefaultSceneBackgroundStyle, DEFAULT_NEW_SCENE_COLOR } from './StageStore'
import { normalizedTheaterMediaType } from './stage-media'
import {
  collectSceneBatchFiles,
  isSceneBatchRunnable,
  runSceneBatch,
  sceneNameError,
  type StageSceneBatchItem,
  type StageSceneBatchSession,
} from './stage-scene-batch-create'

const props = defineProps<{
  show: boolean
  folders: readonly SceneFolder[]
  // Called once per run; the session is bound to the theater scope at that moment.
  createSession: () => StageSceneBatchSession
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
  finished: [result: { created: number, failed: number }]
}>()

const fitOptions: { value: StageSurfaceFit, label: string }[] = [
  { value: 'cover', label: '铺满' },
  { value: 'contain', label: '适应' },
  { value: 'fill', label: '拉伸' },
  { value: 'tile', label: '平铺' },
  { value: 'center', label: '居中' },
]
const acceptedTypes = 'image/png,image/apng,image/jpeg,image/webp,image/gif,video/webm,.apng,.webm'
const folderMenuProps = { class: 'theater-secondary-surface theater-scene-batch-select-menu' }

const items = ref<StageSceneBatchItem[]>([])
const previewUrls = shallowReactive(new Map<string, string>())
const backgroundStyle = reactive(createDefaultSceneBackgroundStyle())
const backgroundColor = ref(DEFAULT_NEW_SCENE_COLOR)
const targetFolderId = ref('')
const mapTopDirectories = ref(false)
const running = ref(false)
const stopping = ref(false)
const progress = reactive({ total: 0, done: 0, current: '' })
const notice = ref('')
const summary = ref('')
const directorySupported = ref(false)
const fileInputRef = ref<HTMLInputElement | null>(null)
const directoryInputRef = ref<HTMLInputElement | null>(null)

let runToken = 0
let stopRequested = false
let unmounted = false

const folderOptions = computed(() => [
  { label: '未分类', value: '' },
  ...props.folders.map((folder) => ({ label: folder.name, value: folder.id })),
])
const hasDirectoryItems = computed(() => items.value.some((item) => item.topDirectory))
const runnableItems = computed(() => items.value.filter(isSceneBatchRunnable))
const pendingCount = computed(() => items.value.filter((item) => item.status === 'pending').length)
const failedCount = computed(() => items.value.filter((item) => item.status === 'failed').length)
const createdCount = computed(() => items.value.filter((item) => item.status === 'created').length)
const hasNameErrors = computed(() => runnableItems.value.some((item) => sceneNameError(item.name)))
const startLabel = computed(() => {
  if (running.value) return stopping.value ? '正在停止…' : '创建中…'
  if (!pendingCount.value && failedCount.value) return `重试失败项（${failedCount.value}）`
  if (!runnableItems.value.length) return '创建场景'
  return `创建 ${runnableItems.value.length} 个场景`
})
const progressPercentage = computed(() => progress.total ? Math.round(progress.done / progress.total * 100) : 0)

watch(() => props.folders.map((folder) => folder.id), (ids) => {
  if (targetFolderId.value && !ids.includes(targetFolderId.value)) targetFolderId.value = ''
})

const isVideo = (item: StageSceneBatchItem) => normalizedTheaterMediaType(item.file) === 'video/webm'

const revokePreview = (key: string) => {
  const url = previewUrls.get(key)
  if (url) URL.revokeObjectURL(url)
  previewUrls.delete(key)
}

const addFiles = (fileList: FileList | null) => {
  if (!fileList?.length || running.value) return
  const result = collectSceneBatchFiles(Array.from(fileList), new Set(items.value.map((item) => item.key)))
  result.items.forEach((item) => previewUrls.set(item.key, URL.createObjectURL(item.file)))
  items.value.push(...result.items)
  const messages: string[] = []
  if (result.unsupported.length) {
    const sample = result.unsupported.slice(0, 3).join('、')
    messages.push(`已跳过 ${result.unsupported.length} 个不支持的文件：${sample}${result.unsupported.length > 3 ? ' 等' : ''}`)
  }
  if (result.duplicates) messages.push(`已跳过 ${result.duplicates} 个重复文件`)
  if (!result.items.length && !messages.length) messages.push('所选位置没有可用的图片')
  notice.value = messages.join('；')
  summary.value = ''
}

const handleInputChange = (event: Event) => {
  const input = event.target as HTMLInputElement
  addFiles(input.files)
  input.value = ''
}

const removeItem = (key: string) => {
  if (running.value) return
  revokePreview(key)
  items.value = items.value.filter((item) => item.key !== key)
}

const clearItems = (predicate: (item: StageSceneBatchItem) => boolean = () => true) => {
  if (running.value) return
  items.value = items.value.filter((item) => {
    if (!predicate(item)) return true
    revokePreview(item.key)
    return false
  })
  if (!items.value.length) {
    notice.value = ''
    summary.value = ''
  }
}

const resetBackgroundStyle = () => {
  Object.assign(backgroundStyle, createDefaultSceneBackgroundStyle())
  backgroundColor.value = DEFAULT_NEW_SCENE_COLOR
}

const start = async () => {
  if (running.value || !runnableItems.value.length) return
  if (hasNameErrors.value) {
    summary.value = '请先修正标红的场景名称'
    return
  }
  const session = props.createSession()
  if (!session.isCurrent()) {
    summary.value = '当前没有批量创建场景的权限，或小剧场尚未就绪'
    return
  }
  const token = ++runToken
  stopRequested = false
  running.value = true
  stopping.value = false
  summary.value = ''
  Object.assign(progress, { total: runnableItems.value.length, done: 0, current: '' })
  const isCancelled = () => unmounted || stopRequested || token !== runToken
  try {
    const result = await runSceneBatch(items.value, session, {
      targetFolderId: targetFolderId.value,
      mapTopDirectories: mapTopDirectories.value && hasDirectoryItems.value,
      backgroundStyle: { ...backgroundStyle, overlay: { ...backgroundStyle.overlay } },
      backgroundColor: backgroundColor.value,
    }, {
      isCancelled,
      onItemStart: (item) => { if (!isCancelled()) progress.current = item.relativePath || item.fileName },
      onItemSettled: (item) => { if (!isCancelled() && item.status !== 'pending') progress.done += 1 },
    })
    if (unmounted || token !== runToken) return
    const parts = [`${result.created} 个成功`]
    if (result.failed) parts.push(`${result.failed} 个失败`)
    summary.value = `${parts.join('，')}${result.stopped ? '，其余已停止' : ''}`
    if (result.created || result.failed) emit('finished', { created: result.created, failed: result.failed })
  } finally {
    if (!unmounted && token === runToken) {
      running.value = false
      stopping.value = false
      progress.current = ''
    }
  }
}

// The in-flight upload finishes but its scene is not created; the item returns to pending.
const stop = () => {
  if (!running.value) return
  stopRequested = true
  stopping.value = true
}

const close = () => {
  if (running.value) return
  clearItems()
  Object.assign(progress, { total: 0, done: 0, current: '' })
  notice.value = ''
  summary.value = ''
  emit('update:show', false)
}

const ensureDirectoryInput = async () => {
  if (!directorySupported.value || !props.show) return
  await nextTick()
  directoryInputRef.value?.setAttribute('webkitdirectory', '')
}

watch(() => props.show, (show) => {
  if (show) void ensureDirectoryInput()
})

onMounted(() => {
  directorySupported.value = typeof HTMLInputElement !== 'undefined' && 'webkitdirectory' in HTMLInputElement.prototype
  // The modal content is lazily rendered, so bind after the input actually exists.
  void ensureDirectoryInput()
})

onBeforeUnmount(() => {
  unmounted = true
  runToken += 1
  previewUrls.forEach((url) => URL.revokeObjectURL(url))
  previewUrls.clear()
})
</script>

<template>
  <n-modal :show="show" :mask-closable="!running" :close-on-esc="!running" @update:show="value => { if (!value) close() }">
    <!-- Root must be a <div>: Naive's focus trap only treats a div as the trapped content. -->
    <div class="theater-scene-batch" role="dialog" aria-modal="true" aria-label="批量创建场景">
      <header class="theater-scene-batch__header">
        <div>
          <strong>批量创建场景</strong>
          <small>每个背景文件创建一个场景，确认后才会上传</small>
        </div>
        <n-button text aria-label="关闭批量创建场景" :disabled="running" @click="close"><n-icon><X /></n-icon></n-button>
      </header>

      <div class="theater-scene-batch__body">
        <section class="theater-scene-batch__section">
          <div class="theater-scene-batch__section-title">素材选择</div>
          <div class="theater-scene-batch__pickers">
            <n-button size="small" :disabled="running" @click="fileInputRef?.click()">
              <template #icon><n-icon><Photo /></n-icon></template>选择图片
            </n-button>
            <n-button v-if="directorySupported" size="small" :disabled="running" @click="directoryInputRef?.click()">
              <template #icon><n-icon><Folder /></n-icon></template>选择文件夹
            </n-button>
            <small>支持 PNG、APNG、JPEG、WebP、GIF、WebM{{ directorySupported ? '；选择文件夹会递归读取其中的图片' : '' }}</small>
          </div>
          <input ref="fileInputRef" class="theater-scene-batch__input" type="file" multiple :accept="acceptedTypes" @change="handleInputChange">
          <input ref="directoryInputRef" class="theater-scene-batch__input" type="file" multiple @change="handleInputChange">
          <p v-if="notice" class="theater-scene-batch__notice">{{ notice }}</p>
        </section>

        <div class="theater-scene-batch__columns">
          <section class="theater-scene-batch__section theater-scene-batch__settings">
            <div class="theater-scene-batch__section-title">统一背景设置</div>
            <div class="theater-scene-batch__field">
              <span>填充方式</span>
              <n-radio-group v-model:value="backgroundStyle.fit" size="small" :disabled="running">
                <n-radio v-for="option in fitOptions" :key="option.value" :value="option.value">{{ option.label }}</n-radio>
              </n-radio-group>
            </div>
            <div class="theater-scene-batch__slider">
              <span>放大</span>
              <n-slider :value="Math.round(backgroundStyle.zoom * 100)" :min="10" :max="500" :step="1" :disabled="running" @update:value="backgroundStyle.zoom = $event / 100" />
              <output>{{ Math.round(backgroundStyle.zoom * 100) }}%</output>
            </div>
            <div class="theater-scene-batch__slider">
              <span>透明度</span>
              <n-slider :value="Math.round(backgroundStyle.opacity * 100)" :min="0" :max="100" :step="1" :disabled="running" @update:value="backgroundStyle.opacity = $event / 100" />
              <output>{{ Math.round(backgroundStyle.opacity * 100) }}%</output>
            </div>
            <div class="theater-scene-batch__slider">
              <span>模糊</span>
              <n-slider v-model:value="backgroundStyle.blurPx" :min="0" :max="40" :step="1" :disabled="running" />
              <output>{{ Math.round(backgroundStyle.blurPx) }}px</output>
            </div>
            <div class="theater-scene-batch__slider">
              <span>亮度</span>
              <n-slider :value="Math.round(backgroundStyle.brightness * 100)" :min="0" :max="200" :step="1" :disabled="running" @update:value="backgroundStyle.brightness = $event / 100" />
              <output>{{ Math.round(backgroundStyle.brightness * 100) }}%</output>
            </div>
            <div class="theater-scene-batch__toggle">
              <span>颜色叠加</span>
              <n-switch v-model:value="backgroundStyle.overlay.enabled" size="small" :disabled="running" />
            </div>
            <div class="theater-scene-batch__toggle" :class="{ 'is-disabled': !backgroundStyle.overlay.enabled }">
              <span>叠加颜色</span>
              <n-color-picker v-model:value="backgroundStyle.overlay.color" :show-alpha="false" :modes="['hex']" size="small" :disabled="running || !backgroundStyle.overlay.enabled" />
            </div>
            <div class="theater-scene-batch__slider" :class="{ 'is-disabled': !backgroundStyle.overlay.enabled }">
              <span>叠加透明度</span>
              <n-slider :value="Math.round(backgroundStyle.overlay.opacity * 100)" :min="0" :max="100" :step="1" :disabled="running || !backgroundStyle.overlay.enabled" @update:value="backgroundStyle.overlay.opacity = $event / 100" />
              <output>{{ Math.round(backgroundStyle.overlay.opacity * 100) }}%</output>
            </div>
            <div class="theater-scene-batch__toggle">
              <span>舞台底色</span>
              <n-color-picker v-model:value="backgroundColor" :show-alpha="false" :modes="['hex']" size="small" :disabled="running" />
            </div>
            <n-button class="theater-scene-batch__reset" text size="small" :disabled="running" @click="resetBackgroundStyle">重置为默认</n-button>

            <div class="theater-scene-batch__section-title">创建位置</div>
            <div class="theater-scene-batch__field">
              <span>场景文件夹</span>
              <n-select v-model:value="targetFolderId" size="small" :options="folderOptions" :menu-props="folderMenuProps" :disabled="running" />
            </div>
            <div v-if="hasDirectoryItems" class="theater-scene-batch__toggle">
              <span>按一级目录创建场景文件夹</span>
              <n-switch v-model:value="mapTopDirectories" size="small" :disabled="running" />
            </div>
            <small v-if="hasDirectoryItems" class="theater-scene-batch__hint">
              开启后，所选文件夹下的第一层子目录会映射为同名场景文件夹（已存在则复用）；直接位于所选文件夹中的图片放入上面的目标文件夹。
            </small>
          </section>

          <section class="theater-scene-batch__section theater-scene-batch__list-section">
            <div class="theater-scene-batch__list-heading">
              <span class="theater-scene-batch__section-title">待创建场景 <small>{{ items.length }}</small></span>
              <div>
                <n-button v-if="createdCount" text size="tiny" :disabled="running" @click="clearItems(item => item.status === 'created')">移除已创建</n-button>
                <n-button text size="tiny" :disabled="running || !items.length" @click="clearItems()">清空</n-button>
              </div>
            </div>
            <div v-if="!items.length" class="theater-scene-batch__empty">尚未选择背景文件</div>
            <ol v-else class="theater-scene-batch__list">
              <li v-for="item in items" :key="item.key" class="theater-scene-batch__item" :class="`is-${item.status}`">
                <div class="theater-scene-batch__thumb">
                  <video v-if="isVideo(item)" :src="previewUrls.get(item.key)" muted preload="metadata" />
                  <img v-else :src="previewUrls.get(item.key)" alt="" loading="lazy">
                </div>
                <div class="theater-scene-batch__item-main">
                  <n-input
                    v-model:value="item.name"
                    size="small"
                    maxlength="512"
                    placeholder="场景名称"
                    :status="isSceneBatchRunnable(item) && sceneNameError(item.name) ? 'error' : undefined"
                    :disabled="running || !isSceneBatchRunnable(item)"
                    :aria-label="`${item.fileName} 的场景名称`"
                  />
                  <small class="theater-scene-batch__file" :title="item.relativePath || item.fileName">{{ item.relativePath || item.fileName }}</small>
                  <small v-if="isSceneBatchRunnable(item) && sceneNameError(item.name)" class="theater-scene-batch__error">{{ sceneNameError(item.name) }}</small>
                  <small v-else-if="item.status === 'failed'" class="theater-scene-batch__error">{{ item.error }}</small>
                </div>
                <div class="theater-scene-batch__status">
                  <n-icon v-if="item.status === 'uploading'" class="is-spinning" aria-label="处理中"><Loader /></n-icon>
                  <n-icon v-else-if="item.status === 'created'" aria-label="已创建"><CircleCheck /></n-icon>
                  <n-icon v-else-if="item.status === 'failed'" aria-label="失败"><AlertTriangle /></n-icon>
                </div>
                <n-button text size="tiny" :aria-label="`移除 ${item.fileName}`" :disabled="running" @click="removeItem(item.key)"><n-icon><Trash /></n-icon></n-button>
              </li>
            </ol>
          </section>
        </div>
      </div>

      <footer class="theater-scene-batch__footer">
        <div class="theater-scene-batch__progress">
          <template v-if="running || progress.total">
            <n-progress type="line" :percentage="progressPercentage" :show-indicator="false" :status="failedCount ? 'warning' : 'default'" />
            <small v-if="running">{{ progress.done }} / {{ progress.total }}<template v-if="progress.current"> · 正在处理：{{ progress.current }}</template></small>
          </template>
          <small v-if="summary" class="theater-scene-batch__summary">{{ summary }}</small>
        </div>
        <div class="theater-scene-batch__actions">
          <n-button v-if="running" :disabled="stopping" @click="stop">停止</n-button>
          <n-button v-else @click="close">关闭</n-button>
          <n-button type="primary" :loading="running" :disabled="running || !runnableItems.length || hasNameErrors" @click="start">{{ startLabel }}</n-button>
        </div>
      </footer>
    </div>
  </n-modal>
</template>

<style scoped>
.theater-scene-batch {
  --theater-accent: #3b82f6;
  width: min(980px, calc(100vw - 32px));
  max-height: min(760px, calc(100vh - 32px));
  max-height: min(760px, calc(100dvh - 32px));
  display: flex;
  flex-direction: column;
  /* No overflow clipping: Naive mounts Select/ColorPicker followers inside the modal root. */
  border: 1px solid var(--sc-border-strong, rgba(255, 255, 255, .16));
  border-radius: 7px;
  color: var(--sc-text-primary, #f4f4f5);
  background: color-mix(in srgb, var(--sc-bg-surface, #262626) 72%, transparent);
  box-shadow: 0 14px 34px rgba(0, 0, 0, .2);
  backdrop-filter: blur(12px) saturate(120%);
  -webkit-backdrop-filter: blur(12px) saturate(120%);
}
.theater-scene-batch__header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 16px; border-bottom: 1px solid var(--sc-border-mute, rgba(255, 255, 255, .08)); }
.theater-scene-batch__header div { min-width: 0; display: grid; gap: 3px; }
.theater-scene-batch__header strong { font-size: 15px; }
.theater-scene-batch small { color: var(--sc-text-secondary, #b5b5c5); font-size: 11px; }
.theater-scene-batch__body { min-height: 0; flex: 1; display: flex; flex-direction: column; gap: 12px; overflow: auto; padding: 14px 16px; }
.theater-scene-batch__section { min-width: 0; display: flex; flex-direction: column; gap: 8px; }
.theater-scene-batch__section-title { font-size: 13px; font-weight: 600; }
.theater-scene-batch__pickers { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.theater-scene-batch__input { display: none; }
.theater-scene-batch__notice { margin: 0; color: var(--sc-color-warning, #f59e0b); font-size: 12px; word-break: break-word; }
.theater-scene-batch__columns { min-height: 0; display: grid; grid-template-columns: minmax(260px, 320px) minmax(0, 1fr); gap: 16px; }
.theater-scene-batch__settings { padding-right: 16px; border-right: 1px solid var(--sc-border-mute, rgba(255, 255, 255, .08)); }
.theater-scene-batch__field { display: grid; gap: 5px; font-size: 12px; }
.theater-scene-batch__field > span, .theater-scene-batch__slider > span, .theater-scene-batch__toggle > span { color: var(--sc-text-secondary, #b5b5c5); font-size: 12px; }
.theater-scene-batch__slider { display: grid; grid-template-columns: 72px minmax(0, 1fr) 44px; align-items: center; gap: 8px; }
.theater-scene-batch__slider output { text-align: right; font-size: 11px; font-variant-numeric: tabular-nums; }
.theater-scene-batch__toggle { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.theater-scene-batch__toggle :deep(.n-color-picker) { width: 128px; }
.is-disabled { opacity: .55; }
.theater-scene-batch__reset { align-self: flex-start; }
.theater-scene-batch__hint { line-height: 1.5; }
.theater-scene-batch__list-section { min-height: 240px; }
.theater-scene-batch__list-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.theater-scene-batch__list-heading > div { display: flex; gap: 10px; }
.theater-scene-batch__empty { min-height: 160px; display: grid; place-items: center; border: 1px dashed var(--sc-border-mute, rgba(255, 255, 255, .16)); border-radius: 6px; color: var(--sc-text-secondary, #b5b5c5); font-size: 12px; }
.theater-scene-batch__list { min-height: 0; max-height: 440px; display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; overflow: auto; list-style: none; }
.theater-scene-batch__item { display: grid; grid-template-columns: 64px minmax(0, 1fr) 20px auto; align-items: center; gap: 10px; padding: 6px 8px; border: 1px solid var(--sc-border-mute, rgba(255, 255, 255, .08)); border-radius: 6px; background: color-mix(in srgb, var(--sc-bg-layer, #3f3f46) 40%, transparent); }
.theater-scene-batch__item.is-uploading { border-color: var(--sc-accent, var(--theater-accent)); }
.theater-scene-batch__item.is-created { opacity: .72; }
.theater-scene-batch__item.is-failed { border-color: var(--sc-color-error, #ef4444); }
.theater-scene-batch__thumb { width: 64px; height: 40px; overflow: hidden; border-radius: 4px; background: rgba(0, 0, 0, .3); }
.theater-scene-batch__thumb img, .theater-scene-batch__thumb video { width: 100%; height: 100%; display: block; object-fit: cover; }
.theater-scene-batch__item-main { min-width: 0; display: grid; gap: 3px; }
.theater-scene-batch__file { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.theater-scene-batch .theater-scene-batch__error { color: var(--sc-color-error, #ef4444); word-break: break-word; }
.theater-scene-batch__status { display: grid; place-items: center; }
.is-created .theater-scene-batch__status { color: var(--sc-color-success, #22c55e); }
.is-failed .theater-scene-batch__status { color: var(--sc-color-error, #ef4444); }
.is-spinning { animation: theater-scene-batch-spin 1s linear infinite; }
@keyframes theater-scene-batch-spin { to { transform: rotate(360deg); } }
.theater-scene-batch__footer { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 10px 16px 14px; border-top: 1px solid var(--sc-border-mute, rgba(255, 255, 255, .08)); }
.theater-scene-batch__progress { min-width: 0; flex: 1; display: grid; gap: 4px; }
.theater-scene-batch__progress small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.theater-scene-batch .theater-scene-batch__summary { color: var(--sc-text-primary, #f4f4f5); }
.theater-scene-batch__actions { display: flex; gap: 8px; }
@media (max-width: 760px) {
  .theater-scene-batch__columns { grid-template-columns: minmax(0, 1fr); }
  .theater-scene-batch__settings { padding-right: 0; border-right: 0; }
  .theater-scene-batch__list { max-height: none; }
  .theater-scene-batch__footer { flex-direction: column; align-items: stretch; }
  .theater-scene-batch__actions { justify-content: flex-end; }
}
</style>
