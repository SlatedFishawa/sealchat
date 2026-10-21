<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NIcon, NSlider, NSwitch, useThemeVars } from 'naive-ui'
import { ArrowBackUp, ChevronLeft, ChevronRight, Volume, Volume3, X } from '@vicons/tabler'
import { useSpeechStore } from './store'
import { useChatStore } from '@/stores/chat'
import { useUserStore } from '@/stores/user'
import { speechAPI, speechError } from './api'
import { fitQuickPanel, quickScopeKey, speechCapabilities } from './quick-control'
import { clampQuickPoint, defaultQuickPoint, normalizeQuickPoint, readQuickPosition, restoreQuickPoint, saveQuickPosition, type QuickLayout, type QuickPosition } from './quick-control-position'
import { selectedEmotion } from './emotion-presets'
import type { RoleSpeechQuickState } from './types'
import TTSEmotionWheel from './TTSEmotionWheel.vue'

const props = defineProps<{ channelId: string; compact?: boolean }>()
const speech = useSpeechStore()
const chat = useChatStore()
const user = useUserStore()
const theme = useThemeVars()
const identityId = computed(() => chat.getActiveIdentityId(props.channelId) || '')
const scopeKey = computed(() => quickScopeKey(props.channelId, identityId.value))
const state = computed(() => speech.quickState(props.channelId, identityId.value))
const role = ref<RoleSpeechQuickState | null>(null)
const error = ref('')
const loading = ref(false)
const open = ref(false)
const wheelOpen = ref(false)
const root = ref<HTMLElement | null>(null)
const panel = ref<HTMLElement | null>(null)
const wheel = ref<HTMLElement | null>(null)
const emotionTrigger = ref<HTMLElement | null>(null)
const panelStyle = ref<Record<string, string>>({})
const wheelStyle = ref<Record<string, string>>({})
const safeArea = ref<HTMLElement | null>(null)
const ballPosition = ref({ left: 0, top: 0 })
const positioned = ref(false)
const dragging = ref(false)
const viewportWidth = ref(window.visualViewport?.width ?? window.innerWidth)
const layout = computed<QuickLayout>(() => props.compact || viewportWidth.value <= 768 ? 'compact' : 'desktop')
const positions: Partial<Record<QuickLayout, QuickPosition>> = {}
const ballStyle = computed(() => ({ left: `${ballPosition.value.left}px`, top: `${ballPosition.value.top}px`, visibility: positioned.value ? 'visible' as const : 'hidden' as const, '--tts-accent': theme.value.primaryColor }))
const capabilities = computed(() => speechCapabilities(role.value?.providerKind ?? '', role.value?.modelId ?? ''))
const enabled = computed(() => speech.optIn(props.channelId))
const available = computed(() => !!props.channelId && !!speech.quota?.enabled && !!speech.quota.autoSynthesis)
const editable = computed(() => !!identityId.value && !!role.value && !role.value.disabled && !loading.value)
const emotionLabel = computed(() => state.value?.override.instruction === undefined ? '默认' : selectedEmotion(state.value.override.instruction, state.value.presetId)?.label ?? '自定义')
const effective = computed(() => ({ ...role.value?.parameters, ...state.value?.override }))
const incompatibleOverride = computed(() => !!role.value && Object.keys(state.value?.override ?? {}).some(key => !capabilities.value[key as keyof typeof capabilities.value]))
const overridden = computed(() => Object.keys(state.value?.override ?? {}).length > 0)
const wheelStacked = ref(false)
const wheelSide = ref<'left' | 'right'>('right')
const wheelDirection = ref<'left' | 'right'>('right')
// Narrow screens cannot hold the dial beside the palette, so it replaces the palette in place.
const covered = computed(() => wheelOpen.value && wheelStacked.value && !!wheel.value)
const sliderTheme = computed(() => ({ railHeight: '3px', handleSize: layout.value === 'compact' ? '18px' : '13px' }))
const sliders = [
  { key: 'rate', label: '语速', min: .5, max: 2, step: .1 },
  { key: 'pitch', label: '音调', min: .5, max: 2, step: .1 },
  { key: 'volume', label: '音量', min: 0, max: 100, step: 1 },
] as const
let loadGeneration = 0
let closeTimer: ReturnType<typeof setTimeout> | undefined
let observer: ResizeObserver | undefined
let repositionFrame: number | undefined
let measuredBallSize = { width: 36, height: 36 }
let pointer: { id: number; x: number; y: number; left: number; top: number; target: HTMLElement; layout: QuickLayout } | undefined
let suppressClick = false

async function loadRole() {
  const generation = ++loadGeneration
  role.value = null
  error.value = ''
  loading.value = false
  if (!identityId.value || !speech.quota?.enabled) return
  loading.value = true
  try {
    const result = await speechAPI.roleQuickState(identityId.value)
    if (generation === loadGeneration) role.value = result
  } catch (e) { if (generation === loadGeneration) error.value = speechError(e) }
  finally { if (generation === loadGeneration) loading.value = false }
}
function toggle() { if (available.value) speech.setTemporary(props.channelId, !enabled.value) }
function setNumber(key: 'rate' | 'pitch' | 'volume', value: number) {
  if (editable.value && capabilities.value[key]) speech.setQuickOverride(props.channelId, identityId.value, { [key]: value })
}
function setEmotion(instruction: string | undefined, presetId?: string) {
  if (editable.value && capabilities.value.instruction) speech.setQuickOverride(props.channelId, identityId.value, { instruction }, presetId)
}
function restore() { speech.resetQuickOverride(props.channelId, identityId.value) }
function close() { open.value = false; wheelOpen.value = false; clearTimeout(closeTimer) }
function keepOpen() { clearTimeout(closeTimer) }
function hoverOpen(event: PointerEvent) { if (!pointer && event.pointerType === 'mouse') { keepOpen(); open.value = true } }
function scheduleClose() { clearTimeout(closeTimer); closeTimer = setTimeout(() => { if (!wheelOpen.value && !panel.value?.contains(document.activeElement)) close() }, 250) }
function viewport() {
  const visual = window.visualViewport
  const style = safeArea.value ? window.getComputedStyle(safeArea.value) : null
  const inset = (key: 'paddingLeft' | 'paddingRight' | 'paddingTop' | 'paddingBottom') => Number.parseFloat(style?.[key] ?? '0') || 0
  return {
    left: (visual?.offsetLeft ?? 0) + inset('paddingLeft'),
    top: (visual?.offsetTop ?? 0) + inset('paddingTop'),
    width: Math.max(0, (visual?.width ?? window.innerWidth) - inset('paddingLeft') - inset('paddingRight')),
    height: Math.max(0, (visual?.height ?? window.innerHeight) - inset('paddingTop') - inset('paddingBottom')),
  }
}
function ballSize() { return { width: root.value?.offsetWidth || 36, height: root.value?.offsetHeight || 36 } }
function refreshPosition() {
  viewportWidth.value = window.visualViewport?.width ?? window.innerWidth
  if (pointer) finishPointer(true)
  const area = viewport()
  const size = ballSize()
  measuredBallSize = size
  const saved = positions[layout.value] ?? readQuickPosition(layout.value) ?? normalizeQuickPoint(defaultQuickPoint(area, size, layout.value), area, size)
  positions[layout.value] = saved
  ballPosition.value = restoreQuickPoint(saved, area, size)
  positioned.value = true
  void nextTick(scheduleReposition)
}
function pointerDown(event: PointerEvent) {
  if (pointer || !event.isPrimary || event.button !== 0) return
  keepOpen()
  suppressClick = false
  const target = event.currentTarget as HTMLElement
  pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, ...ballPosition.value, target, layout: layout.value }
  target.setPointerCapture(event.pointerId)
}
function pointerMove(event: PointerEvent) {
  if (!pointer || event.pointerId !== pointer.id) return
  const dx = event.clientX - pointer.x
  const dy = event.clientY - pointer.y
  if (!dragging.value && Math.hypot(dx, dy) <= 5) return
  if (!dragging.value) { dragging.value = true; suppressClick = true; close() }
  event.preventDefault()
  ballPosition.value = clampQuickPoint({ left: pointer.left + dx, top: pointer.top + dy }, viewport(), ballSize())
}
function finishPointer(cancelled: boolean) {
  if (!pointer) return
  const active = pointer
  pointer = undefined
  if (dragging.value) {
    const position = normalizeQuickPoint(ballPosition.value, viewport(), ballSize())
    positions[active.layout] = position
    saveQuickPosition(active.layout, position)
  }
  suppressClick = suppressClick || cancelled
  dragging.value = false
  if (active.target.hasPointerCapture(active.id)) active.target.releasePointerCapture(active.id)
}
function pointerUp(event: PointerEvent) {
  if (event.pointerId !== pointer?.id) return
  pointerMove(event)
  finishPointer(false)
}
function pointerCancel(event: PointerEvent) { if (event.pointerId === pointer?.id) finishPointer(true) }
function ballClick(event: MouseEvent) {
  if (event.detail === 0 || !suppressClick) { toggle(); keepOpen(); open.value = true }
}
type QuickBox = { left: number; top: number; width: number; maxHeight: number }
type QuickRect = { left: number; top: number; right: number; bottom: number }
// Surfaces scale out of the point they belong to: the ball for the palette, the palette edge for the dial.
function surfaceStyle(box: QuickBox, originX: number, originY: number, room: number) {
  const origin = (value: number, size: number) => `${Math.round(Math.max(0, Math.min(value, size)))}px`
  return { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, maxHeight: `${box.maxHeight}px`, transformOrigin: `${origin(originX, box.width)} ${origin(originY, box.maxHeight)}`, '--tqc-room': `${Math.max(0, room)}px` }
}
// max-height is border-box while scrollHeight excludes borders; without them a 2px scrollbar appears.
function contentHeight(target: HTMLElement) { return target.scrollHeight + Math.max(0, target.offsetHeight - target.clientHeight) }
function placeFromBall(anchor: QuickRect, target: HTMLElement, width: number) {
  const area = viewport()
  const fit = fitQuickPanel(anchor, { width, height: contentHeight(target) }, area)
  return { fit, style: surfaceStyle(fit, (anchor.left + anchor.right) / 2 - fit.left, (anchor.top + anchor.bottom) / 2 - fit.top, area.height - 16) }
}
// The dial sits beside the palette away from the ball, else across the ball; without room it replaces the palette.
function besideSlot(anchor: QuickRect, box: { left: number; width: number }, width: number, area: ReturnType<typeof viewport>) {
  const right = wheelSide.value === 'right'
  const candidates: Array<[number, 'left' | 'right']> = [
    right ? [box.left + box.width + 8, 'right'] : [box.left - 8 - width, 'left'],
    right ? [Math.min(anchor.left, box.left) - 8 - width, 'left'] : [Math.max(anchor.right, box.left + box.width) + 8, 'right'],
  ]
  return candidates.find(([left]) => left >= area.left + 8 && left + width <= area.left + area.width - 8) ?? null
}
function placeWheel(anchor: QuickRect, target: HTMLElement, width: number) {
  const area = viewport()
  const margin = 8
  const box = { left: Number.parseFloat(panelStyle.value.left) || 0, top: Number.parseFloat(panelStyle.value.top) || 0, width: panel.value?.offsetWidth ?? 0, height: panel.value?.offsetHeight ?? 0 }
  const fitWidth = Math.min(width, Math.max(0, area.width - margin * 2))
  const height = Math.min(contentHeight(target), Math.max(0, area.height - margin * 2))
  const beside = panel.value ? besideSlot(anchor, box, fitWidth, area) : null
  wheelStacked.value = !beside
  wheelDirection.value = beside?.[1] ?? 'right'
  if (!beside) return placeFromBall(anchor, target, width).style
  const [left, direction] = beside
  const preferred = box.top >= anchor.top - 1 ? box.top : box.top + box.height - height
  const top = Math.max(area.top + margin, Math.min(preferred, area.top + area.height - margin - height))
  return surfaceStyle({ left, top, width: fitWidth, maxHeight: height }, direction === 'right' ? 0 : fitWidth, box.top + box.height / 2 - top, area.height - 16)
}
function scheduleReposition() {
  if (repositionFrame !== undefined) return
  if (typeof window.requestAnimationFrame !== 'function') { reposition(); return }
  repositionFrame = window.requestAnimationFrame(() => {
    repositionFrame = undefined
    reposition()
  })
}
function reposition() {
  if (!root.value) return
  const anchor = root.value.getBoundingClientRect()
  const wheelWidth = layout.value === 'compact' ? 304 : 300
  if (open.value && panel.value) {
    const { fit, style } = placeFromBall(anchor, panel.value, layout.value === 'compact' ? 304 : 284)
    panelStyle.value = style
    wheelSide.value = fit.left * 2 + fit.width >= anchor.left + anchor.right ? 'right' : 'left'
  }
  if (wheelOpen.value && wheel.value) wheelStyle.value = placeWheel(anchor, wheel.value, wheelWidth)
  else if (open.value && panel.value) {
    // Lets the emotion entry point toward where the dial will appear before it opens.
    const fit = besideSlot(anchor, { left: Number.parseFloat(panelStyle.value.left) || 0, width: panel.value.offsetWidth }, wheelWidth, viewport())
    wheelStacked.value = !fit
    wheelDirection.value = fit?.[1] ?? 'right'
  }
}
function closeWheel() {
  wheelOpen.value = false
  // The palette is inert while the dial covers it; focus returns once it is interactive again.
  void nextTick(() => emotionTrigger.value?.focus())
}
function outside(event: PointerEvent) {
  const target = event.target as Node
  if (![root.value, panel.value, wheel.value].some(element => element?.contains(target))) close()
}
function keyboard(event: KeyboardEvent) {
  if (event.key !== 'Escape' || !open.value) return
  if (wheelOpen.value) closeWheel()
  else { close(); root.value?.querySelector<HTMLButtonElement>('.tqc-ball')?.focus() }
}
watch([scopeKey, () => user.info.id, () => speech.quota?.enabled, () => speech.roleConfigRevision, () => speech.quota?.voiceContext], () => { finishPointer(true); close(); void loadRole() }, { immediate: true, flush: 'sync' })
watch(open, value => { if (!value) wheelOpen.value = false })
watch(() => speech.quickControlVisible, value => { if (!value) { finishPointer(true); close() } })
watch(() => props.compact, refreshPosition)
watch(covered, value => { if (value) void nextTick(() => wheel.value?.querySelector<HTMLButtonElement>('.tqc-wheel-chrome button')?.focus()) })
watch([open, wheelOpen, root, panel, wheel], async () => {
  await nextTick()
  observer?.disconnect()
  if (root.value) { observer?.observe(root.value); if (!positioned.value) refreshPosition() }
  // Observe intrinsic content only. Observing the positioned surfaces themselves creates
  // a max-height/scrollbar -> resize -> reposition feedback loop in real browsers.
  for (const content of [panel.value?.querySelector('.tqc-panel-body'), wheel.value?.querySelector('.ew')]) if (content) observer?.observe(content)
  scheduleReposition()
}, { flush: 'post' })
onMounted(() => {
  refreshPosition()
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(entries => {
      const size = ballSize()
      if (entries.some(entry => entry.target === root.value) && (size.width !== measuredBallSize.width || size.height !== measuredBallSize.height)) refreshPosition()
      else scheduleReposition()
    })
    if (root.value) observer.observe(root.value)
  }
  window.addEventListener('resize', refreshPosition)
  window.visualViewport?.addEventListener('resize', refreshPosition)
  window.visualViewport?.addEventListener('scroll', refreshPosition)
  document.addEventListener('pointerdown', outside)
  document.addEventListener('keydown', keyboard)
})
onBeforeUnmount(() => {
  finishPointer(true)
  loadGeneration++
  clearTimeout(closeTimer)
  observer?.disconnect()
  if (repositionFrame !== undefined && typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(repositionFrame)
  window.removeEventListener('resize', refreshPosition)
  window.visualViewport?.removeEventListener('resize', refreshPosition)
  window.visualViewport?.removeEventListener('scroll', refreshPosition)
  document.removeEventListener('pointerdown', outside)
  document.removeEventListener('keydown', keyboard)
})
</script>

<template>
  <Teleport to="body">
    <div ref="safeArea" class="tqc-safe-area" aria-hidden="true"></div>
    <div v-if="speech.quota?.enabled && speech.quickControlVisible && channelId" ref="root" class="tqc-anchor" :class="{ 'is-dragging': dragging }" :data-layout="layout" :style="ballStyle" @pointerenter="hoverOpen" @pointerleave="scheduleClose">
      <button type="button" class="tqc-ball" :class="{ 'is-on': enabled }" :aria-disabled="!available" :aria-pressed="enabled" :aria-expanded="open" :aria-label="enabled ? '关闭临时 TTS 合成' : '开启临时 TTS 合成'" :title="available ? `TTS 合成：${enabled ? '已开启' : '已关闭'}${overridden ? '（已应用临时参数）' : ''}` : '请先在朗读设置中开启自动合成'" @pointerdown="pointerDown" @pointermove="pointerMove" @pointerup="pointerUp" @pointercancel="pointerCancel" @lostpointercapture="pointerCancel" @click="ballClick">
        <NIcon :component="enabled ? Volume : Volume3" :size="layout === 'compact' ? 21 : 19" />
        <span v-if="overridden" class="tqc-ball-pip" aria-hidden="true"></span>
      </button>
    </div>
    <Transition name="tqc-pop">
      <section v-if="open && speech.quickControlVisible" ref="panel" class="tqc-surface tqc-panel" :class="{ 'is-covered': covered }" :data-layout="layout" :inert="covered" :style="{ ...panelStyle, '--tts-accent': theme.primaryColor, '--tts-warn': theme.warningColor }" aria-label="TTS 快捷控制" @pointerenter="keepOpen" @pointerleave="scheduleClose" @scroll="reposition">
        <div class="tqc-panel-body">
          <header class="tqc-head">
            <div class="tqc-voice">
              <strong :title="role?.voiceName">{{ loading ? '正在读取音色…' : role?.voiceName || 'TTS 快捷控制' }}</strong>
              <small :title="role?.modelId">{{ role?.modelId || '仅影响之后发送的新消息' }}</small>
            </div>
            <button type="button" class="tqc-icon-btn" aria-label="关闭快捷控制" @click="close"><NIcon :component="X" :size="15" /></button>
          </header>
          <label class="tqc-power" :class="{ 'is-on': enabled && available }">
            <span class="tqc-power-dot" aria-hidden="true"></span>
            <span class="tqc-power-text">临时 TTS 合成<small>{{ available ? enabled ? '已开启' : '已关闭' : '请先在朗读设置中开启自动合成' }}</small></span>
            <NSwitch :value="enabled" :disabled="!available" size="small" @update:value="value => speech.setTemporary(channelId, value)" />
          </label>
          <p v-if="error" class="tqc-hint is-alert" role="alert">{{ error }}</p>
          <p v-else-if="!identityId" class="tqc-hint">选择频道角色后可临时调整朗读参数。</p>
          <div class="tqc-params" role="group" aria-label="朗读参数">
            <div v-for="slider in sliders" :key="slider.key" class="tqc-slider" :class="{ 'is-modified': state?.override[slider.key] !== undefined, 'is-unsupported': !!role && !capabilities[slider.key] }">
              <span>{{ slider.label }}</span>
              <NSlider :value="effective[slider.key] ?? (slider.key === 'volume' ? 50 : 1)" :min="slider.min" :max="slider.max" :step="slider.step" :tooltip="false" :theme-overrides="sliderTheme" :disabled="!editable || !capabilities[slider.key]" :aria-label="slider.label" @update:value="value => { if (typeof value === 'number') setNumber(slider.key, value) }" />
              <output>{{ slider.key === 'volume' ? effective.volume ?? 50 : (effective[slider.key] ?? 1).toFixed(2) }}<small v-if="slider.key !== 'volume'">×</small></output>
            </div>
          </div>
          <button ref="emotionTrigger" type="button" class="tqc-emotion" :class="{ 'is-set': state?.override.instruction !== undefined, 'is-active': wheelOpen }" :disabled="!editable || !capabilities.instruction" :aria-expanded="wheelOpen" @click="wheelOpen = !wheelOpen">
            <span class="tqc-emotion-orb" aria-hidden="true">{{ capabilities.instruction ? emotionLabel.slice(0, 1) : '—' }}</span>
            <span class="tqc-emotion-text"><small>情绪</small><strong>{{ capabilities.instruction ? emotionLabel : '不支持情绪控制' }}</strong></span>
            <NIcon class="tqc-emotion-caret" :component="wheelDirection === 'left' ? ChevronLeft : ChevronRight" :size="15" />
          </button>
          <p v-if="role && !role.disabled && !capabilities.instruction" class="tqc-hint">当前音色不支持情绪控制</p>
          <p v-if="role && !capabilities.pitch" class="tqc-hint">当前音色不支持音调调整</p>
          <p v-if="incompatibleOverride" class="tqc-hint is-alert" role="alert">临时参数与当前音色不兼容，请恢复角色默认值后发送。</p>
          <footer class="tqc-foot">
            <button type="button" class="tqc-reset" :disabled="!state" @click="restore"><NIcon :component="ArrowBackUp" :size="14" />恢复角色默认值</button>
            <label>悬浮球 <NSwitch :value="speech.quickControlVisible" size="small" @update:value="speech.setQuickControlVisible" /></label>
          </footer>
        </div>
      </section>
    </Transition>
    <Transition name="tqc-pop">
      <section v-if="open && wheelOpen && editable && capabilities.instruction && speech.quickControlVisible" ref="wheel" class="tqc-surface tqc-wheel" :class="{ 'is-stacked': wheelStacked }" :data-layout="layout" :style="{ ...wheelStyle, '--tts-accent': theme.primaryColor }" aria-label="情绪选择器" @pointerenter="keepOpen">
        <div class="tqc-wheel-chrome">
          <button v-if="wheelStacked" type="button" class="tqc-back" aria-label="返回参数" @click="closeWheel"><NIcon :component="ChevronLeft" :size="14" />参数</button>
          <span v-else class="tqc-wheel-title">情绪</span>
          <button type="button" class="tqc-icon-btn" aria-label="关闭情绪选择器" @click="closeWheel"><NIcon :component="X" :size="15" /></button>
        </div>
        <TTSEmotionWheel :key="scopeKey" :instruction="state?.override.instruction" :preset-id="state?.presetId" :inherited-instruction="role?.parameters.instruction ?? ''" @change="setEmotion" />
      </section>
    </Transition>
  </Teleport>
</template>

<style scoped>
.tqc-safe-area { position: fixed; visibility: hidden; pointer-events: none; padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px); }
.tqc-anchor { position: fixed; z-index: 2199; display: flex; align-items: center; width: max-content; color: var(--sc-text-primary); }
.tqc-anchor, .tqc-surface {
  --tqc-line: color-mix(in srgb, var(--sc-text-primary) 11%, transparent);
  --tqc-tint: color-mix(in srgb, var(--sc-text-primary) 4.5%, transparent);
  --tqc-shadow: 0 1px 2px rgb(15 23 42 / .08), 0 6px 18px -4px rgb(15 23 42 / .2);
}

/* Ball: state reads from fill, ring and icon at a glance; the pip marks active temporary parameters. */
.tqc-ball {
  position: relative; display: grid; place-items: center; width: 40px; height: 40px; padding: 0;
  border: 1px solid var(--tqc-line); border-radius: 50%; background: var(--sc-bg-elevated); color: var(--sc-text-secondary);
  box-shadow: var(--tqc-shadow); cursor: pointer; opacity: .72; touch-action: none; user-select: none; -webkit-tap-highlight-color: transparent;
  transition: transform .16s cubic-bezier(.2, .8, .2, 1), opacity .16s ease, box-shadow .16s ease, background-color .16s ease, border-color .16s ease, color .16s ease;
}
.tqc-anchor[data-layout='compact'] .tqc-ball { width: 44px; height: 44px; }
.tqc-ball::before { position: absolute; inset: 3px; border: 1.5px solid transparent; border-radius: 50%; content: ''; transition: border-color .16s ease; }
.tqc-ball.is-on { border-color: color-mix(in srgb, var(--tts-accent) 35%, var(--tqc-line)); background: color-mix(in srgb, var(--tts-accent) 11%, var(--sc-bg-elevated)); color: var(--tts-accent); opacity: .96; }
.tqc-ball.is-on::before { border-color: color-mix(in srgb, var(--tts-accent) 55%, transparent); }
.tqc-ball[aria-disabled='true'] { opacity: .45; }
.tqc-anchor:hover .tqc-ball, .tqc-ball[aria-expanded='true'] { opacity: 1; }
.tqc-anchor:hover .tqc-ball { transform: scale(1.05); }
.tqc-ball:active { transform: scale(.94); }
.tqc-ball[aria-expanded='true'] { box-shadow: var(--tqc-shadow), 0 0 0 3px color-mix(in srgb, var(--tts-accent) 18%, transparent); }
.tqc-anchor.is-dragging .tqc-ball { cursor: grabbing; opacity: 1; transform: scale(1.08); box-shadow: 0 2px 4px rgb(15 23 42 / .1), 0 14px 28px -6px rgb(15 23 42 / .32); }
.tqc-ball-pip { position: absolute; top: 0; right: 0; width: 9px; height: 9px; border-radius: 50%; background: var(--tts-accent); box-shadow: 0 0 0 2px var(--sc-bg-elevated); }

/* Surfaces: one floating palette language shared by the parameter HUD and the emotion dial. */
.tqc-surface {
  box-sizing: border-box; position: fixed; z-index: 2200; overflow: hidden auto; overscroll-behavior: contain;
  scrollbar-width: thin; scrollbar-color: var(--tqc-line) transparent; scrollbar-gutter: stable;
  padding: 12px; border: 1px solid var(--tqc-line); border-radius: 18px; background: var(--sc-bg-elevated);
  color: var(--sc-text-primary); font-size: 12px; box-shadow: 0 1px 2px rgb(15 23 42 / .06), 0 16px 40px -12px rgb(15 23 42 / .28);
  transition: opacity .14s ease, transform .16s cubic-bezier(.2, .8, .2, 1);
}
.tqc-surface button { font: inherit; color: inherit; cursor: pointer; -webkit-tap-highlight-color: transparent; }
.tqc-surface button:disabled { opacity: .45; cursor: default; }
.tqc-anchor button:focus-visible, .tqc-surface button:focus-visible { outline: 2px solid var(--tts-accent); outline-offset: 2px; }
/* Default widths make the first scrollHeight measurement match the width placement will assign. */
.tqc-panel { width: 284px; }
.tqc-wheel { width: 300px; }
.tqc-surface[data-layout='compact'] { width: 304px; }
.tqc-pop-enter-from, .tqc-pop-leave-to { opacity: 0; transform: scale(.9); }
.tqc-pop-leave-active { transition-duration: .1s; }
.tqc-panel.is-covered { opacity: 0; transform: scale(.96); pointer-events: none; }
.tqc-icon-btn { display: grid; flex: none; place-items: center; width: 26px; height: 26px; padding: 0; border: 0; border-radius: 50%; background: transparent; color: var(--sc-text-secondary) !important; }
.tqc-icon-btn:hover { background: var(--tqc-tint); color: var(--sc-text-primary) !important; }

.tqc-head { display: flex; align-items: flex-start; gap: 8px; padding: 2px 0 0 4px; }
.tqc-voice { flex: 1; min-width: 0; }
.tqc-voice strong, .tqc-voice small, .tqc-emotion-text strong { display: -webkit-box; overflow: hidden; overflow-wrap: anywhere; -webkit-box-orient: vertical; -webkit-line-clamp: 1; line-clamp: 1; }
.tqc-voice strong { font-size: 14px; font-weight: 600; line-height: 20px; }
.tqc-voice small { margin-top: 1px; color: var(--sc-text-secondary); font-size: 10.5px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; opacity: .85; }

.tqc-power { display: flex; align-items: center; gap: 10px; margin-top: 10px; padding: 8px 10px; border-radius: 12px; background: var(--tqc-tint); transition: background-color .16s ease; }
.tqc-power.is-on { background: color-mix(in srgb, var(--tts-accent) 10%, transparent); }
.tqc-power-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: color-mix(in srgb, var(--sc-text-secondary) 55%, transparent); transition: background-color .16s ease, box-shadow .16s ease; }
.tqc-power.is-on .tqc-power-dot { background: var(--tts-accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--tts-accent) 20%, transparent); }
.tqc-power-text { flex: 1; min-width: 0; font-size: 12.5px; font-weight: 500; }
.tqc-power-text small { display: block; color: var(--sc-text-secondary); font-size: 10.5px; font-weight: 400; }

.tqc-params { margin-top: 8px; padding: 0 4px; }
.tqc-slider { display: grid; grid-template-columns: 2.4em minmax(0, 1fr) 3.6em; gap: 10px; align-items: center; min-height: 32px; transition: opacity .16s ease; }
.tqc-slider > span { position: relative; color: var(--sc-text-secondary); font-size: 12px; }
.tqc-slider output { color: var(--sc-text-primary); font-size: 12px; font-variant-numeric: tabular-nums; text-align: right; }
.tqc-slider output small { margin-left: 1px; color: var(--sc-text-secondary); font-size: 10px; }
.tqc-slider.is-modified > span { color: var(--sc-text-primary); }
.tqc-slider.is-modified > span::after { position: absolute; top: 1px; right: -2px; width: 4px; height: 4px; border-radius: 50%; background: var(--tts-accent); content: ''; }
.tqc-slider.is-modified output { color: var(--tts-accent); font-weight: 600; }
.tqc-slider.is-unsupported { opacity: .5; }

.tqc-emotion {
  display: flex; align-items: center; gap: 10px; width: 100%; margin-top: 8px; padding: 6px 8px 6px 6px;
  border: 1px solid var(--tqc-line); border-radius: 14px; background: transparent; text-align: left;
  transition: border-color .14s ease, background-color .14s ease;
}
.tqc-emotion:hover:not(:disabled) { background: var(--tqc-tint); }
.tqc-emotion.is-active { border-color: color-mix(in srgb, var(--tts-accent) 50%, transparent); background: color-mix(in srgb, var(--tts-accent) 6%, transparent); }
.tqc-emotion-orb {
  display: grid; flex: none; place-items: center; width: 30px; height: 30px; border-radius: 50%;
  background: var(--tqc-tint); color: var(--sc-text-secondary); font-size: 13px; font-weight: 600;
}
.tqc-emotion.is-set .tqc-emotion-orb { background: color-mix(in srgb, var(--tts-accent) 16%, transparent); color: var(--tts-accent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--tts-accent) 35%, transparent); }
.tqc-emotion-text { flex: 1; min-width: 0; }
.tqc-emotion-text small { display: block; color: var(--sc-text-secondary); font-size: 10.5px; }
.tqc-emotion-text strong { font-size: 13px; font-weight: 600; }
.tqc-emotion-caret { flex: none; color: var(--sc-text-secondary); transition: transform .16s ease; }
.tqc-emotion.is-active .tqc-emotion-caret { color: var(--tts-accent); }

.tqc-hint { margin: 6px 4px 0; color: var(--sc-text-secondary); font-size: 11px; line-height: 1.45; }
.tqc-hint.is-alert { color: var(--tts-warn, var(--sc-text-primary)); }

.tqc-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 10px; padding: 8px 2px 0 4px; border-top: 1px solid var(--tqc-line); }
.tqc-reset { display: inline-flex; align-items: center; gap: 4px; padding: 3px 6px 3px 2px; border: 0; border-radius: 8px; background: transparent; color: var(--sc-text-secondary) !important; font-size: 11.5px !important; }
.tqc-reset:hover:not(:disabled) { background: var(--tqc-tint); color: var(--sc-text-primary) !important; }
.tqc-foot label { display: flex; align-items: center; gap: 6px; color: var(--sc-text-secondary); font-size: 11.5px; }

.tqc-wheel { z-index: 2201; padding: 12px 12px 10px; border-radius: 24px; }
.tqc-wheel-chrome { position: absolute; inset: 8px 8px auto; z-index: 3; display: flex; align-items: center; justify-content: space-between; pointer-events: none; }
.tqc-wheel-chrome > * { pointer-events: auto; }
.tqc-wheel-title { padding-left: 6px; color: var(--sc-text-secondary); font-size: 11px; letter-spacing: .12em; }
.tqc-back { display: inline-flex; align-items: center; gap: 2px; height: 26px; padding: 0 8px 0 4px; border: 0; border-radius: 13px; background: var(--tqc-tint); color: var(--sc-text-secondary) !important; font-size: 11.5px !important; }
.tqc-back:hover { color: var(--sc-text-primary) !important; }

/* Touch layouts keep the same language with larger targets instead of a scaled-down desktop. */
.tqc-surface[data-layout='compact'] .tqc-icon-btn { width: 32px; height: 32px; }
.tqc-surface[data-layout='compact'] .tqc-back { height: 32px; border-radius: 16px; }
.tqc-panel[data-layout='compact'] .tqc-slider { min-height: 40px; }
.tqc-panel[data-layout='compact'] .tqc-emotion { min-height: 48px; }
.tqc-panel[data-layout='compact'] .tqc-reset { min-height: 32px; }

@supports (backdrop-filter: blur(12px)) {
  .tqc-ball, .tqc-surface { backdrop-filter: blur(14px) saturate(1.15); }
  .tqc-surface { background: color-mix(in srgb, var(--sc-bg-elevated) 94%, transparent); }
}
@media (prefers-reduced-motion: reduce) {
  .tqc-ball, .tqc-ball::before, .tqc-surface, .tqc-power, .tqc-power-dot, .tqc-slider, .tqc-emotion, .tqc-emotion-caret { transition: none; }
  .tqc-anchor:hover .tqc-ball, .tqc-ball:active, .tqc-anchor.is-dragging .tqc-ball, .tqc-pop-enter-from, .tqc-pop-leave-to { transform: none; }
}
</style>
