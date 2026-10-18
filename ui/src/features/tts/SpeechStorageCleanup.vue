<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { NAlert, NButton, NCheckbox, NModal, NSpin } from 'naive-ui'
import { useUserStore } from '@/stores/user'
import { speechAPI, speechError } from './api'
import { useSpeechStore } from './store'
import type { SpeechCleanupCategory, SpeechCleanupSelection, SpeechStorageSummary } from './types'

const props = defineProps<{ channelId: string }>()
const user = useUserStore()
const speech = useSpeechStore()
const summary = ref<SpeechStorageSummary | null>(null)
const loading = ref(false)
const busy = ref(false)
const error = ref('')
const success = ref('')
const scope = ref<'channel' | 'world'>('channel')
const selection = reactive<SpeechCleanupSelection>({ invalidatedMessages: true, deletedMessages: true, expiredPreviews: true })
const categories: { key: SpeechCleanupCategory; label: string; hint: string }[] = [
  { key: 'invalidatedMessages', label: '编辑后失效的旧语音', hint: '消息已更新，旧版本语音已不再使用。' },
  { key: 'deletedMessages', label: '已删除消息的遗留语音', hint: '消息已删除或撤回，音频仍占用存储。' },
  { key: 'expiredPreviews', label: '已过期的试听与预览', hint: '仅回收已过期且没有其他有效用途的音频。' },
]
function capacity(bytes: number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = Math.max(0, bytes)
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: unit ? 2 : 0 }).format(value)} ${units[unit]}`
}
const count = (value: number) => value.toLocaleString('zh-CN')
const selected = computed(() => categories.reduce((total, category) => {
  const amount = summary.value?.reclaimable[category.key]
  if (selection[category.key] && amount) { total.files += amount.files; total.bytes += amount.bytes }
  return total
}, { files: 0, bytes: 0 }))
const target = computed(() => summary.value?.[scope.value])
const reclaimPercent = computed(() => summary.value?.total.bytes
  ? Math.min(100, summary.value.reclaimable.total.bytes / summary.value.total.bytes * 100) : 0)
type Confirmation = { kind: 'cleanup'; summary: SpeechStorageSummary; selection: SpeechCleanupSelection; files: number; bytes: number }
  | { kind: 'purge'; summary: SpeechStorageSummary; scope: 'channel' | 'world' }
const confirmation = ref<Confirmation | null>(null)
const confirmationTitle = computed(() => {
  const dialog = confirmation.value
  if (!dialog || dialog.kind === 'cleanup') return '确认清理无用 TTS 音频？'
  return `确认清空「${dialog.summary[dialog.scope].name || (dialog.scope === 'channel' ? '当前频道' : '当前世界')}」的 TTS 音频？`
})
let alive = true
let revision = 0
let contextEpoch = 0
function isCurrent(channelId: string, userId: string, epoch: number) { return alive && epoch === contextEpoch && channelId === props.channelId && userId === user.info.id }
async function scan() {
  const channelId = props.channelId
  const userId = user.info.id
  const epoch = contextEpoch
  const request = ++revision
  if (!channelId) { summary.value = null; loading.value = false; return }
  loading.value = true
  error.value = ''
  try {
    const value = await speechAPI.storage(channelId)
    if (isCurrent(channelId, userId, epoch) && request === revision) summary.value = value
  } catch (cause) {
    if (isCurrent(channelId, userId, epoch) && request === revision) { summary.value = null; error.value = speechError(cause) }
  } finally {
    if (isCurrent(channelId, userId, epoch) && request === revision) loading.value = false
  }
}
watch([() => props.channelId, () => user.info.id], () => {
  revision++
  contextEpoch++
  summary.value = null
  confirmation.value = null
  success.value = ''
  void scan()
}, { immediate: true, flush: 'sync' })
onBeforeUnmount(() => { alive = false; revision++ })
function confirmCleanup() {
  if (!summary.value || busy.value || loading.value || !selected.value.files) return
  confirmation.value = { kind: 'cleanup', summary: summary.value, selection: { ...selection }, ...selected.value }
}
function confirmPurge() {
  if (!summary.value || busy.value || loading.value || !target.value || !(target.value.files || target.value.messages)) return
  confirmation.value = { kind: 'purge', summary: summary.value, scope: scope.value }
}
async function refreshPurgedMessageStates(channelId: string, userId: string, epoch: number) {
  // Purge detaches message metadata before storage I/O, so even a failed HTTP
  // response may have partially applied. Treat the old prop snapshot as stale.
  speech.suppressMessageFallback(channelId)
  speech.messageStates = {}
  const states = speech.messageStates
  const before = { ...states }
  try {
    const items = await speechAPI.states(channelId)
    if (isCurrent(channelId, userId, epoch) && speech.messageStates === states) {
      for (const item of items) { if (states[item.id] === before[item.id]) states[item.id] = item.tts }
    }
    return ''
  } catch {
    return '朗读状态刷新失败；重新进入频道后会更新。'
  }
}
async function execute() {
  const dialog = confirmation.value
  if (!dialog || busy.value) return
  const channelId = props.channelId
  const userId = user.info.id
  const epoch = contextEpoch
  busy.value = true
  error.value = ''
  success.value = ''
  try {
    const result = dialog.kind === 'cleanup'
      ? await speechAPI.cleanupStorage(channelId, dialog.selection)
      : await speechAPI.purgeStorage(channelId, dialog.scope)
    if (!isCurrent(channelId, userId, epoch)) return
    confirmation.value = null
    success.value = `已删除 ${count(result.files)} 个音频文件，释放 ${capacity(result.bytes)}。${'messages' in result && typeof result.messages === 'number' ? `已清除 ${count(result.messages)} 条消息的朗读关联。` : ''}`
    // Storage cleanup does not change billing or voice slots. Only purge needs
    // a metadata snapshot; never submit synthesis or playback during refresh.
    const refreshError = dialog.kind === 'purge' ? await refreshPurgedMessageStates(channelId, userId, epoch) : ''
    if (isCurrent(channelId, userId, epoch)) await scan()
    if (isCurrent(channelId, userId, epoch) && refreshError) error.value = refreshError
  } catch (cause) {
    if (isCurrent(channelId, userId, epoch)) {
      confirmation.value = null
      const refreshError = dialog.kind === 'purge' ? await refreshPurgedMessageStates(channelId, userId, epoch) : ''
      await scan()
      if (isCurrent(channelId, userId, epoch)) error.value = [speechError(cause), refreshError].filter(Boolean).join(' ')
    }
  } finally { busy.value = false }
}
</script>

<template>
  <div class="storage-cleanup" :aria-busy="loading || busy">
    <NAlert v-if="error" type="error">{{ error }}</NAlert>
    <NAlert v-if="success" type="success" aria-live="polite">{{ success }}</NAlert>
    <p v-if="!channelId" class="storage-hint">进入世界中的频道后可管理 TTS 存储。</p>
    <NSpin v-if="loading && !summary" size="small" />
    <NButton v-if="error && !summary && channelId" :disabled="busy" :loading="loading" @click="scan">重新扫描</NButton>
    <template v-if="summary">
      <section class="storage-section">
        <h3>当前世界 TTS 存储概览</h3>
        <div class="storage-overview">
          <div><strong class="storage-total">{{ capacity(summary.total.bytes) }}</strong><p class="storage-hint">共 {{ count(summary.total.files) }} 个音频文件 · {{ summary.world.name || '当前世界' }}</p></div>
          <div class="storage-reclaim"><span class="storage-hint">可安全清理</span><strong>{{ capacity(summary.reclaimable.total.bytes) }}</strong><span class="storage-hint">{{ count(summary.reclaimable.total.files) }} 个文件</span></div>
          <dl class="storage-backends">
            <div><dt>本地存储</dt><dd>{{ capacity(summary.local.bytes) }} / {{ count(summary.local.files) }} 个</dd></div>
            <div><dt>S3 存储</dt><dd>{{ capacity(summary.s3.bytes) }} / {{ count(summary.s3.files) }} 个</dd></div>
          </dl>
        </div>
        <div class="storage-bar" role="img" :aria-label="`可安全清理 ${capacity(summary.reclaimable.total.bytes)}，总计 ${capacity(summary.total.bytes)}`"><span :style="{ width: `${100 - reclaimPercent}%` }" /><span class="storage-bar-reclaim" :style="{ width: `${reclaimPercent}%` }" /></div>
        <div class="storage-legend"><span>其余音频 {{ capacity(summary.total.bytes - summary.reclaimable.total.bytes) }}</span><span>可安全清理 {{ capacity(summary.reclaimable.total.bytes) }}</span></div>
      </section>

      <section class="storage-section">
        <div class="storage-heading"><h3>无用音频清理</h3><NButton size="small" :disabled="busy" :loading="loading" @click="scan">重新扫描</NButton></div>
        <p class="storage-hint">清理已经失效或不再需要的音频，不影响正常消息朗读。</p>
        <div class="storage-categories">
          <div v-for="category in categories" :key="category.key" class="storage-row">
            <NCheckbox v-model:checked="selection[category.key]" :disabled="busy"><span>{{ category.label }}</span><small class="storage-hint">{{ category.hint }}</small></NCheckbox>
            <span class="storage-amount">{{ count(summary.reclaimable[category.key].files) }} 个文件 · {{ capacity(summary.reclaimable[category.key].bytes) }}</span>
          </div>
        </div>
        <NButton class="storage-delete" type="error" :disabled="!selected.files || loading || busy" @click="confirmCleanup"><span>清理选中的 {{ count(selected.files) }} 个文件 · 预计释放 {{ capacity(selected.bytes) }}</span></NButton>
      </section>

      <section class="storage-section">
        <h3>频道与世界音频</h3>
        <p class="storage-hint">批量清除已生成的消息朗读。消息、角色和 TTS 配置会保留。</p>
        <div class="storage-segment" role="group" aria-label="清理范围">
          <button v-for="item in (['channel', 'world'] as const)" :key="item" type="button" :aria-pressed="scope === item" :disabled="busy" @click="scope = item">{{ item === 'channel' ? '当前频道' : '当前世界' }}</button>
        </div>
        <div v-if="target" class="storage-target">
          <strong>{{ target.name || (scope === 'channel' ? '当前频道' : '当前世界') }}</strong>
          <p class="storage-hint"><template v-if="scope === 'world'">{{ count(target.channels || 0) }} 个频道 · </template>{{ count(target.messages) }} 条消息 TTS · {{ count(target.files) }} 个可释放文件 · 预计释放 {{ capacity(target.bytes) }}</p>
          <p class="storage-hint">其他消息、音色预览或缓存仍在使用的文件会保留；已清除的消息朗读以后可重新合成。</p>
        </div>
        <NButton class="storage-delete" type="error" :disabled="busy || loading || !target || !(target.files || target.messages)" @click="confirmPurge">清空{{ scope === 'channel' ? '当前频道' : '当前世界' }}的 TTS 音频</NButton>
      </section>
    </template>

    <NModal :show="!!confirmation" preset="card" :title="confirmationTitle" class="storage-confirm" :style="{ width: 'min(480px, calc(100vw - 32px))' }" :mask-closable="!busy" :close-on-esc="!busy" :closable="!busy" @update:show="value => { if (!value && !busy) confirmation = null }">
      <template v-if="confirmation?.kind === 'cleanup'">
        <p>将永久删除 {{ count(confirmation.files) }} 个已经失效或过期的音频文件，预计释放 {{ capacity(confirmation.bytes) }}。正常消息正在使用的语音不会被删除。</p>
        <dl class="storage-confirm-list">
          <template v-for="category in categories" :key="category.key">
            <div v-if="confirmation.selection[category.key]"><dt>{{ category.label }}</dt><dd>{{ count(confirmation.summary.reclaimable[category.key].files) }} 个 · {{ capacity(confirmation.summary.reclaimable[category.key].bytes) }}</dd></div>
          </template>
        </dl>
      </template>
      <template v-else-if="confirmation?.kind === 'purge'">
        <p>将清除 {{ count(confirmation.summary[confirmation.scope].messages) }} 条消息的朗读关联，预计释放 {{ capacity(confirmation.summary[confirmation.scope].bytes) }}。</p>
        <p>聊天消息、角色、TTS 配置不会删除。已生成的消息朗读将失效，以后需要播放时可重新合成。</p>
        <p>共享给其他有效用途的物理资源会保留，不会误删。正在生成的任务不受影响。</p>
      </template>
      <p class="storage-hint">实际释放容量以删除时的有效引用和存储处理结果为准。</p>
      <template #footer>
        <div class="storage-confirm-actions">
          <NButton :disabled="busy" @click="confirmation = null">取消</NButton>
          <NButton type="error" :loading="busy" :disabled="busy" @click="execute">{{ confirmation?.kind === 'cleanup' ? `删除 ${count(confirmation.files)} 个文件` : `清空该${confirmation?.kind === 'purge' && confirmation.scope === 'world' ? '世界' : '频道'}的 TTS 音频` }}</NButton>
        </div>
      </template>
    </NModal>
  </div>
</template>

<style scoped>
.storage-cleanup { flex: 1 1 auto; min-height: 0; min-width: 0; overflow-y: auto; padding: 0 22px 20px; display: flex; flex-direction: column; gap: 14px; color: var(--sc-text-primary); }
.storage-section { padding: 18px; border: 1px solid var(--sc-border-mute); border-radius: 8px; background: color-mix(in srgb, var(--sc-text-primary) 3%, transparent); }
h3 { margin: 0; font-size: 15px; font-weight: 600; }
.storage-hint { display: block; margin: 6px 0 0; font-size: 12px; line-height: 1.6; color: var(--sc-text-secondary); overflow-wrap: anywhere; }
.storage-overview { display: flex; align-items: center; flex-wrap: wrap; gap: 20px 30px; margin: 16px 0; }
.storage-total { font-size: 32px; line-height: 1.2; font-weight: 650; letter-spacing: -.6px; font-variant-numeric: tabular-nums; }
.storage-reclaim { display: flex; flex-direction: column; gap: 2px; }
.storage-reclaim strong { font-size: 21px; color: var(--vp-accent); }
.storage-reclaim .storage-hint { margin: 0; }
.storage-backends { margin: 0 0 0 auto; font-size: 12px; color: var(--sc-text-secondary); }
.storage-backends div { display: flex; justify-content: space-between; gap: 18px; padding: 3px 0; }
dd { margin: 0; font-variant-numeric: tabular-nums; }
.storage-bar { display: flex; height: 9px; border-radius: 9px; overflow: hidden; background: var(--sc-border-mute); }
.storage-bar span { background: var(--vp-accent); transition: width .2s ease; }
.storage-bar .storage-bar-reclaim { background: color-mix(in srgb, var(--vp-accent) 30%, var(--sc-text-secondary)); }
.storage-legend { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 5px 12px; margin-top: 8px; font-size: 11px; color: var(--sc-text-secondary); }
.storage-heading { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.storage-categories { margin: 10px 0 16px; }
.storage-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--sc-border-mute); }
.storage-row :deep(.n-checkbox__label) { min-width: 0; }
.storage-row small { margin: 2px 0 0; }
.storage-amount { flex-shrink: 0; font-size: 12px; color: var(--sc-text-secondary); font-variant-numeric: tabular-nums; }
.storage-delete { max-width: 100%; height: auto; min-height: 34px; padding: 8px 14px; }
.storage-delete :deep(.n-button__content) { white-space: normal; line-height: 1.6; text-align: left; }
.storage-segment { box-sizing: border-box; display: flex; width: min(100%, 300px); margin-top: 14px; padding: 3px; border: 1px solid var(--sc-border-mute); border-radius: 7px; }
.storage-segment button { flex: 1; min-width: 0; padding: 6px 12px; border: 0; border-radius: 4px; background: transparent; color: var(--sc-text-secondary); font: inherit; font-size: 13px; cursor: pointer; transition: background-color .15s ease, color .15s ease; }
.storage-segment button[aria-pressed="true"] { background: color-mix(in srgb, var(--vp-accent) 15%, transparent); color: var(--sc-text-primary); }
.storage-segment button:focus-visible { outline: 2px solid var(--vp-accent); }
.storage-target { margin: 16px 0; overflow-wrap: anywhere; }
.storage-confirm-list { margin: 16px 0; font-size: 13px; }
.storage-confirm-list div { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 4px 12px; margin: 10px 0; }
.storage-confirm-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 10px; }
.storage-confirm-actions :deep(.n-button) { max-width: 100%; height: auto; min-height: 34px; }
.storage-confirm-actions :deep(.n-button__content) { white-space: normal; }
@media (max-width: 720px) {
  .storage-cleanup { padding: 0 16px 16px; }
  .storage-section { padding: 14px; }
  .storage-row { align-items: flex-start; flex-direction: column; gap: 6px; }
  .storage-amount { padding-left: 26px; }
  .storage-backends { flex: 1 1 100%; margin-left: 0; }
  .storage-total { font-size: 28px; }
}
@media (prefers-reduced-motion: reduce) { .storage-bar span, .storage-segment button { transition: none; } }
</style>
