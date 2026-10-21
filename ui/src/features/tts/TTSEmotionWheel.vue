<script setup lang="ts">
import { computed, ref } from 'vue'
import { useElementSize } from '@vueuse/core'
import { emotionCategories, emotionPresets, selectedEmotion, type EmotionCategory, type EmotionPreset } from './emotion-presets'

const props = defineProps<{ instruction?: string; inheritedInstruction: string; presetId?: string; disabled?: boolean }>()
const emit = defineEmits<{ change: [instruction: string | undefined, presetId?: string] }>()
const current = computed(() => selectedEmotion(props.instruction, props.presetId))
// Opening on the page of the active preset is display-only; browsing pages never changes the selection.
const category = ref<EmotionCategory>(current.value?.category ?? 'basic')
const customOpen = ref(false)
const preview = ref<EmotionPreset | null>(null)
const ring = ref<HTMLElement | null>(null)
const { width } = useElementSize(ring, { width: 260, height: 260 })
const items = computed(() => emotionPresets.filter(preset => preset.category === category.value))
const label = computed(() => props.instruction === undefined ? '默认' : current.value?.label ?? '自定义')
const description = computed(() => current.value?.description ?? (props.instruction === undefined ? '继承角色朗读指令' : '使用自定义朗读指令'))
const instructionText = computed(() => props.instruction ?? props.inheritedInstruction)
const previewing = computed(() => !!preview.value && preview.value.id !== current.value?.id)
const hubLabel = computed(() => previewing.value ? preview.value!.label : label.value)
const hubDescription = computed(() => previewing.value ? preview.value!.description : description.value)
const hubCaption = computed(() => previewing.value ? '预览' : props.instruction === undefined ? '角色默认' : current.value ? '当前情绪' : '自定义指令')
const small = computed(() => width.value < 216)
const band = computed(() => Math.round(Math.min(50, Math.max(38, width.value * .19))))
const selectedIndex = computed(() => items.value.findIndex(preset => preset.id === current.value?.id))
const ringStyle = computed(() => {
  const sweep = 360 / Math.max(1, items.value.length)
  return { '--ew-band': `${band.value}px`, '--ew-sweep': `${sweep}deg`, '--ew-angle': `${Math.max(0, selectedIndex.value) * sweep}deg` }
})
// Hover previews clear only when the pointer leaves the ring, so gaps between items do not flash the selection back.
function leaveRing(event: PointerEvent) { if (event.pointerType === 'mouse') preview.value = null }
function itemStyle(index: number) {
  const angle = index * 360 / items.value.length
  const radius = Math.max(0, width.value / 2 - 3 - band.value / 2)
  return { transform: `translate(-50%, -50%) rotate(${angle}deg) translateY(-${radius}px) rotate(${-angle}deg)` }
}
function hover(preset: EmotionPreset, event: PointerEvent) { if (event.pointerType === 'mouse') preview.value = preset }
function select(preset: EmotionPreset) {
  if (!props.disabled) emit('change', preset.instruction, preset.id)
}
function useDefault() { if (!props.disabled) emit('change', undefined) }
function editInstruction(event: Event) {
  if (props.disabled) return
  emit('change', [...(event.target as HTMLTextAreaElement).value].slice(0, 500).join(''))
}
</script>

<template>
  <section class="ew" :class="{ 'is-small': small, 'is-disabled': disabled }" aria-label="选择情绪">
    <p v-if="disabled" class="ew-hint">当前音色不支持情绪控制</p>
    <span class="ew-sr" aria-live="polite">已选情绪：{{ label }}</span>
    <div ref="ring" class="ew-ring" :style="ringStyle" role="group" aria-label="情绪环" @pointerleave="leaveRing">
      <span class="ew-sector" :class="{ 'is-visible': selectedIndex >= 0 }" aria-hidden="true"></span>
      <div class="ew-hub" :class="{ 'is-set': instruction !== undefined, 'is-preview': previewing }">
        <small>{{ hubCaption }}</small>
        <strong>{{ hubLabel }}</strong>
        <span v-if="!small" class="ew-hub-desc">{{ hubDescription }}</span>
        <button v-if="instruction !== undefined" type="button" :disabled="disabled" @click="useDefault">恢复默认</button>
      </div>
      <Transition name="ew-swap" mode="out-in">
        <div :key="category" class="ew-items">
          <button v-for="(preset, index) in items" :key="preset.id" type="button" class="ew-item"
            :class="{ 'is-selected': current?.id === preset.id }" :style="itemStyle(index)"
            :aria-pressed="current?.id === preset.id" :title="preset.instruction" :disabled="disabled"
            @click="select(preset)" @pointerenter="hover(preset, $event)" @focus="preview = preset" @blur="preview = null">
            {{ preset.label }}
          </button>
        </div>
      </Transition>
    </div>
    <div class="ew-categories" role="group" aria-label="情绪分类">
      <button v-for="item in emotionCategories" :key="item.id" type="button" :class="{ 'has-selection': current?.category === item.id }"
        :aria-pressed="category === item.id" @click="category = item.id">{{ item.label }}</button>
    </div>
    <button type="button" class="ew-custom" :class="{ 'is-custom': instruction !== undefined && !current }" :disabled="disabled" :aria-expanded="customOpen" @click="customOpen = !customOpen">
      <span class="ew-custom-glyph" aria-hidden="true">✎</span>
      <span class="ew-custom-label">自定义朗读指令</span>
      <span class="ew-custom-meta">{{ instruction === undefined ? '继承角色' : current ? '使用预设' : '已自定义' }}</span>
      <span class="ew-caret" aria-hidden="true"></span>
    </button>
    <div v-if="customOpen" class="ew-editor">
      <textarea :value="instructionText" :disabled="disabled" rows="3" maxlength="500" aria-label="实际发送给 TTS 的 instruction" placeholder="输入实际发送给 TTS 的朗读指令" @input="editInstruction" />
      <small>实际发送的 instruction <span>{{ [...instructionText].length }}/500</span></small>
    </div>
  </section>
</template>

<style scoped>
.ew {
  --ew-accent: var(--tts-accent, currentColor);
  --ew-line: color-mix(in srgb, var(--sc-text-primary) 10%, transparent);
  display: flex; flex-direction: column; align-items: center; width: 100%; color: var(--sc-text-primary);
}
.ew button { color: inherit; font: inherit; cursor: pointer; -webkit-tap-highlight-color: transparent; }
.ew button:disabled { opacity: .4; cursor: default; }
.ew button:focus-visible, .ew textarea:focus-visible { outline: 2px solid var(--ew-accent); outline-offset: 2px; }
.ew-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
.ew-hint { margin: 0 0 8px; color: var(--sc-text-secondary); font-size: 12px; }

/* Ring sizing follows the room the fixed surface leaves in small theater frames, not only its width. */
.ew-ring {
  position: relative; flex: none; width: min(100%, 260px, max(168px, calc(var(--tqc-room, 9999px) - 92px))); aspect-ratio: 1;
}
.ew.is-disabled .ew-ring { opacity: .5; }
.ew-ring::before {
  position: absolute; inset: 3px; border: 1px solid var(--ew-line); border-radius: 50%; content: ''; pointer-events: none;
  background: radial-gradient(closest-side,
    transparent calc(100% - var(--ew-band)),
    var(--ew-line) calc(100% - var(--ew-band)) calc(100% - var(--ew-band) + 1px),
    color-mix(in srgb, var(--sc-text-primary) 3.5%, transparent) calc(100% - var(--ew-band) + 1px));
}
/* Hairline ticks between sectors make the band read as a dial without labeling every slot. */
.ew-ring::after, .ew-sector {
  position: absolute; inset: 4px; border-radius: 50%; pointer-events: none;
  -webkit-mask: radial-gradient(closest-side, transparent calc(100% - var(--ew-band) + 1px), rgb(0 0 0) calc(100% - var(--ew-band) + 1px));
  mask: radial-gradient(closest-side, transparent calc(100% - var(--ew-band) + 1px), rgb(0 0 0) calc(100% - var(--ew-band) + 1px));
}
.ew-ring::after {
  content: '';
  background: repeating-conic-gradient(from calc(var(--ew-sweep) / 2), var(--ew-line) 0 .7deg, transparent .7deg var(--ew-sweep));
}
.ew-sector {
  opacity: 0; transform: rotate(var(--ew-angle));
  background: conic-gradient(from calc(var(--ew-sweep) / -2), color-mix(in srgb, var(--ew-accent) 16%, transparent) 0 var(--ew-sweep), transparent 0);
  transition: opacity .12s ease;
}
.ew-sector.is-visible { opacity: 1; }

.ew-hub {
  position: absolute; inset: calc(3px + var(--ew-band) + 8px); z-index: 1;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
  border: 1px solid var(--ew-line); border-radius: 50%; background: var(--sc-bg-elevated); text-align: center;
  transition: border-color .16s ease, box-shadow .16s ease;
}
.ew-hub.is-set { border-color: color-mix(in srgb, var(--ew-accent) 40%, transparent); box-shadow: 0 0 0 4px color-mix(in srgb, var(--ew-accent) 7%, transparent); }
.ew-hub small { color: var(--sc-text-secondary); font-size: 10px; letter-spacing: .08em; }
.ew-hub strong { font-size: 22px; font-weight: 600; line-height: 1.25; letter-spacing: .04em; }
.ew-hub.is-set strong { color: var(--ew-accent); }
.ew-hub.is-preview strong { color: var(--sc-text-primary); opacity: .72; }
.ew-hub-desc { max-width: 9em; color: var(--sc-text-secondary); font-size: 11px; line-height: 1.35; }
.ew-hub button {
  margin-top: 4px; padding: 1px 8px; border: 1px solid var(--ew-line); border-radius: 999px; background: transparent;
  color: var(--sc-text-secondary) !important; font-size: 10.5px !important; line-height: 16px;
}
.ew-hub button:hover:not(:disabled) { color: var(--sc-text-primary) !important; border-color: color-mix(in srgb, var(--sc-text-primary) 22%, transparent); }
.ew.is-small .ew-hub strong { font-size: 17px; }

.ew-items { position: absolute; inset: 0; }
.ew-item {
  position: absolute; top: 50%; left: 50%; z-index: 2; display: grid; place-items: center; width: 44px; height: 28px; padding: 0;
  border: 1px solid transparent; border-radius: 14px; background: transparent;
  color: var(--sc-text-secondary) !important; font-size: 13px !important; letter-spacing: .02em;
  transition: background-color .12s ease, color .12s ease, border-color .12s ease;
}
.ew-item:hover:not(:disabled) { background: color-mix(in srgb, var(--sc-text-primary) 7%, transparent); color: var(--sc-text-primary) !important; }
.ew-item.is-selected, .ew-item.is-selected:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--ew-accent) 40%, transparent); background: var(--sc-bg-elevated);
  color: var(--ew-accent) !important; font-weight: 600;
}
.ew.is-small .ew-item { width: 38px; height: 26px; font-size: 12px !important; }
.ew-swap-enter-active, .ew-swap-leave-active { transition: opacity .09s ease; }
.ew-swap-enter-from, .ew-swap-leave-to { opacity: 0; }

.ew-categories {
  display: inline-flex; gap: 2px; margin-top: 6px; padding: 3px; border: 1px solid var(--ew-line); border-radius: 999px;
  background: color-mix(in srgb, var(--sc-text-primary) 4%, transparent);
}
.ew-categories button {
  position: relative; padding: 3px 12px; border: 0; border-radius: 999px; background: transparent;
  color: var(--sc-text-secondary) !important; font-size: 12px !important; line-height: 18px;
}
.ew-categories button:hover { color: var(--sc-text-primary) !important; }
.ew-categories button[aria-pressed='true'] {
  background: var(--sc-bg-elevated); color: var(--ew-accent) !important; font-weight: 600;
  box-shadow: 0 1px 2px rgb(15 23 42 / .1), 0 0 0 1px var(--ew-line);
}
/* Marks the page holding the active preset while another page is being browsed. */
.ew-categories button.has-selection::after {
  position: absolute; top: 3px; right: 5px; width: 4px; height: 4px; border-radius: 50%; background: var(--ew-accent); content: '';
}

.ew-custom {
  display: flex; align-items: center; gap: 6px; align-self: stretch; margin-top: 8px; padding: 6px 4px 2px;
  border: 0; border-top: 1px solid var(--ew-line); background: transparent; color: var(--sc-text-secondary) !important; font-size: 12px !important; text-align: left;
}
.ew-custom:hover:not(:disabled) { color: var(--sc-text-primary) !important; }
.ew-custom-glyph { width: 1em; text-align: center; }
.ew-custom-label { flex: 1; }
.ew-custom-meta { font-size: 10.5px; opacity: .8; }
.ew-custom.is-custom .ew-custom-meta { color: var(--ew-accent); opacity: 1; }
.ew-caret { width: 6px; height: 6px; margin: 0 2px 2px 4px; border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor; transform: rotate(45deg); transition: transform .16s ease; }
.ew-custom[aria-expanded='true'] .ew-caret { margin-bottom: -2px; transform: rotate(-135deg); }
.ew-editor { align-self: stretch; margin-top: 6px; }
.ew-editor textarea {
  box-sizing: border-box; display: block; width: 100%; max-height: 132px; padding: 8px 10px; resize: vertical;
  border: 1px solid var(--ew-line); border-radius: 10px; background: var(--sc-bg-input, var(--sc-bg-elevated));
  color: inherit; font: inherit; font-size: 12px; line-height: 1.5;
}
.ew-editor small { display: flex; justify-content: space-between; gap: 8px; margin-top: 4px; padding: 0 2px; color: var(--sc-text-secondary); font-size: 10px; }
.ew-editor small span { font-variant-numeric: tabular-nums; }
@media (prefers-reduced-motion: reduce) {
  .ew-item, .ew-sector, .ew-hub, .ew-caret, .ew-swap-enter-active, .ew-swap-leave-active { transition: none; }
}
</style>
