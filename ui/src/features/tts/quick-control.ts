import type { TTSQuickOverride } from './types'

export interface QuickSpeechState { override: TTSQuickOverride; presetId?: string }
export const quickScopeKey = (channelId: string, identityId: string) => JSON.stringify([channelId, identityId])

export function speechCapabilities(providerKind: string, modelId: string) {
  const qwen = providerKind === 'aliyun' && modelId.startsWith('qwen-audio-')
  const classic = providerKind === 'tencent' && ['tencent-tts-classic', 'tencent-tts-large'].includes(modelId)
  const mps = providerKind === 'tencent' && /^speech-(2\.(8|6)|02)-(hd|turbo)$/.test(modelId)
  return { rate: qwen || classic || mps, pitch: qwen || mps, volume: qwen || classic || mps, instruction: qwen }
}

export function sanitizeQuickOverride(value: unknown): TTSQuickOverride {
  const result: TTSQuickOverride = {}
  if (!value || typeof value !== 'object') return result
  const input = value as Record<string, unknown>
  for (const key of ['rate', 'pitch', 'volume'] as const) {
    const v = input[key]
    if (typeof v === 'number' && Number.isFinite(v) && (key === 'volume' ? Number.isInteger(v) && v >= 0 && v <= 100 : v >= .5 && v <= 2)) result[key] = v
  }
  if (typeof input.instruction === 'string' && [...input.instruction].length <= 500) result.instruction = input.instruction
  return result
}

export function patchQuickState(state: QuickSpeechState | undefined, patch: TTSQuickOverride, presetId?: string): QuickSpeechState {
  const override = { ...state?.override, ...patch }
  for (const key of Object.keys(override) as Array<keyof TTSQuickOverride>) if (override[key] === undefined) delete override[key]
  return { override: sanitizeQuickOverride(override), presetId: 'instruction' in patch ? presetId : state?.presetId }
}

// Used by fixed popovers in normal chat, embedded chat and small theater frames.
export function fitQuickPanel(anchor: { left: number; right: number; top: number; bottom: number }, size: { width: number; height: number }, viewport: { width: number; height: number; left?: number; top?: number }) {
  const margin = 8
  const leftEdge = (viewport.left ?? 0) + margin
  const topEdge = (viewport.top ?? 0) + margin
  const width = Math.min(size.width, Math.max(0, viewport.width - margin * 2))
  const height = Math.min(size.height, Math.max(0, viewport.height - margin * 2))
  const rightEdge = leftEdge + viewport.width - margin * 2
  const bottomEdge = topEdge + viewport.height - margin * 2
  const left = anchor.right + margin + width <= rightEdge ? anchor.right + margin : anchor.left - margin - width
  const top = anchor.top + height <= bottomEdge ? anchor.top : anchor.bottom - height
  return { left: Math.max(leftEdge, Math.min(left, rightEdge - width)), top: Math.max(topEdge, Math.min(top, bottomEdge - height)), width, maxHeight: height }
}
