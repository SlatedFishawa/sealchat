<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NButton, NIcon, NTooltip, useMessage } from 'naive-ui'
import { Volume, Volume2, Refresh, Microphone } from '@vicons/tabler'
import { speechPlayer } from './player'
import { useSpeechStore } from './store'
import { speechAPI, speechError } from './api'
import type { MessageSpeech } from './types'
const props = defineProps<{
  message: { id: string; tts?: MessageSpeech | null; editCount?: number; icMode?: string; widgetData?: string; isRevoked?: boolean; isDeleted?: boolean }
  canSynthesize?: boolean
}>()
const speech = useSpeechStore()
const feedback = useMessage()
const submitting = ref(false)
const autoplayRevision = ref<number | null>(null)
const revision = computed(() => props.message.editCount ?? props.message.tts?.messageRevision ?? 0)
const metadata = computed(() => {
  const current = props.message.tts
  const polled = speech.messageStates[props.message.id]
  if (polled === null) return null
  if (polled?.messageRevision === revision.value) return polled
  return current?.messageRevision === revision.value ? current : null
})
const ready = computed(() => metadata.value?.status === 'ready' && !!metadata.value.audioResourceId)
const processing = computed(() => ['pending', 'queued', 'running', 'storage_pending', 'archiving'].includes(metadata.value?.status || ''))
const uncertain = computed(() => metadata.value?.status === 'usage_unknown')
const canGenerate = computed(() => props.canSynthesize && props.message.icMode === 'ic' && !props.message.widgetData && !props.message.isRevoked && !props.message.isDeleted)
const visible = computed(() => speech.quota?.enabled && (ready.value || canGenerate.value))
const active = computed(() => speechPlayer.state.key === `messages:${props.message.id}`)
const loading = computed(() => submitting.value || processing.value || (active.value && speechPlayer.state.loading))
const label = computed(() => ready.value
  ? (active.value ? '停止语音' : '播放语音')
  : processing.value || submitting.value ? '正在合成语音'
    : uncertain.value ? '语音用量待确认，请勿重复合成'
      : metadata.value?.status === 'invalidated' ? '重新合成' : '合成语音')
async function onClick() {
  if (submitting.value || processing.value || uncertain.value) return
  if (ready.value) { speechPlayer.play('messages', props.message.id); return }
  if (!canGenerate.value) return
  const messageId = props.message.id
  const messageRevision = revision.value
  const shouldAutoplay = metadata.value?.status === 'invalidated'
  const states = speech.messageStates
  const previous = states[messageId]
  if (shouldAutoplay) autoplayRevision.value = messageRevision
  submitting.value = true
  try {
    const state = await speechAPI.synthesizeMessage(messageId)
    // A gateway update (possibly already ready), edit or scope reset wins.
    if (speech.messageStates === states && states[messageId] === previous && props.message.id === messageId && revision.value === messageRevision && state?.messageRevision === messageRevision) {
      states[messageId] = state
    }
  } catch (error) {
    if (autoplayRevision.value === messageRevision) autoplayRevision.value = null
    feedback.error(speechError(error))
  } finally { submitting.value = false }
}
watch(metadata, (value) => {
  if (active.value && (!value || ['invalidated', 'cancelled', 'failed', 'skipped', 'unavailable', 'usage_unknown'].includes(value.status))) speechPlayer.stop()
  if (autoplayRevision.value === null) return
  if (autoplayRevision.value !== revision.value) {
    autoplayRevision.value = null
    return
  }
  if (value?.status === 'ready' && value.audioResourceId) {
    autoplayRevision.value = null
    void speechPlayer.ensurePlay('messages', props.message.id)
  } else if (value && ['cancelled', 'failed', 'skipped', 'unavailable', 'usage_unknown'].includes(value.status)) {
    autoplayRevision.value = null
  }
})
watch(revision, (value) => {
  if (autoplayRevision.value !== null && autoplayRevision.value !== value) autoplayRevision.value = null
})
watch(() => speech.messageStates, () => {
  autoplayRevision.value = null
})
</script>
<template>
  <NTooltip v-if="visible" trigger="hover">
    <template #trigger>
      <NButton text size="small" class="message-action-bar__btn message-speech-button" :aria-label="label" :loading="loading" :disabled="submitting || processing || uncertain" @click.stop="onClick">
        <NIcon v-if="!loading" :component="ready ? (active ? Volume : Volume2) : metadata?.status === 'invalidated' ? Refresh : Microphone" size="18" />
      </NButton>
    </template>
    {{ (ready && speechPlayer.state.error) || label }}
  </NTooltip>
</template>
