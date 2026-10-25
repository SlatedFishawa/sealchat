import { isSafeStageImageUrl, stageSurfaceTransitionTypes, type StageImageRef, type StageLiveState, type StageSurfaceTarget, type StageSurfaceVariants } from './stage-types'

export const normalizeSurfaceTransition = (input: unknown): StageSurfaceVariants['transition'] => {
  const value = input && typeof input === 'object' ? input as Partial<StageSurfaceVariants['transition']> : {}
  return {
    type: stageSurfaceTransitionTypes.includes(value.type!) ? value.type! : 'fade',
    durationMs: typeof value.durationMs === 'number' && Number.isFinite(value.durationMs)
      ? Math.round(Math.min(5000, Math.max(20, value.durationMs))) : 350,
  }
}

const imageRef = (input: unknown): StageImageRef | null => {
  if (!input || typeof input !== 'object') return null
  const value = input as StageImageRef
  if (typeof value.url !== 'string' || !isSafeStageImageUrl(value.url)) return null
  return {
    resourceId: typeof value.resourceId === 'string' ? value.resourceId.trim() : '',
    url: value.url.trim(),
    ...(typeof value.alt === 'string' ? { alt: value.alt } : {}),
    ...(typeof value.mimeType === 'string' && value.mimeType.trim() ? { mimeType: value.mimeType.trim().toLowerCase() } : {}),
    ...(value.animated === true ? { animated: true } : {}),
    ...(Number.isInteger(value.loopCount) && value.loopCount! > 0 && value.loopCount! <= 65535 ? { loopCount: value.loopCount } : {}),
  }
}

export const normalizeSurfaceVariants = (input: unknown): StageSurfaceVariants => {
  const value = input && typeof input === 'object' ? input as Partial<StageSurfaceVariants> : {}
  const ids = new Set<string>()
  const slots = (Array.isArray(value.slots) ? value.slots : []).flatMap(slot => {
    if (!slot || typeof slot !== 'object' || typeof slot.id !== 'string' || !slot.id.trim() || slot.id.trim().length > 128 || ids.has(slot.id.trim())) return []
    const id = slot.id.trim()
    ids.add(id)
    return [{ id, name: typeof slot.name === 'string' ? slot.name.trim().slice(0, 128) || '未命名' : '未命名', image: imageRef(slot.image) }]
  })
  return {
    slots,
    activeId: value.activeId === null ? null : slots.find(slot => slot.id === value.activeId)?.id ?? slots.find(slot => slot.image)?.id ?? null,
    transition: normalizeSurfaceTransition(value.transition),
  }
}

// Legacy defaults are a read-only projection. Merely opening a scene never migrates it.
export const surfaceVariantsFor = (state: StageLiveState, target: StageSurfaceTarget): StageSurfaceVariants => (
  state.surfaceVariants?.[target] ?? {
    slots: state[target] ? [{ id: `default-${target}`, name: '默认', image: state[target] }] : [],
    activeId: state[target] ? `default-${target}` : null,
    transition: normalizeSurfaceTransition(null),
  }
)

export const normalizeSurfaceVariantState = (state: StageLiveState) => {
  if (!state.surfaceVariants || typeof state.surfaceVariants !== 'object') {
    delete state.surfaceVariants
    return state
  }
  const variants: NonNullable<StageLiveState['surfaceVariants']> = {}
  for (const target of ['background', 'foreground'] as const) {
    if (!state.surfaceVariants[target]) continue
    const group = normalizeSurfaceVariants(state.surfaceVariants[target])
    variants[target] = group
    state[target] = group.slots.find(slot => slot.id === group.activeId)?.image ?? null
  }
  state.surfaceVariants = variants
  return state
}

export type SurfaceVariantOperation =
  | { type: 'add', id: string, name: string, image: StageImageRef | null }
  | { type: 'select', id: string | null }
  | { type: 'rename', id: string, name: string }
  | { type: 'replace', id: string, image: StageImageRef | null }
  | { type: 'copy', id: string, newId: string }
  | { type: 'delete', id: string }
  | { type: 'transition', patch: Partial<StageSurfaceVariants['transition']> }

export const operateSurfaceVariant = (state: StageLiveState, target: StageSurfaceTarget, operation: SurfaceVariantOperation): boolean => {
  if ((operation.type === 'add' || operation.type === 'replace') && operation.image && !imageRef(operation.image)) return false
  const group = normalizeSurfaceVariants(surfaceVariantsFor(state, target))
  const slot = 'id' in operation ? group.slots.find(slot => slot.id === operation.id) : undefined
  switch (operation.type) {
    case 'add':
      if (!operation.id.trim() || operation.id.length > 128 || !operation.name.trim() || group.slots.some(slot => slot.id === operation.id.trim())) return false
      group.slots.push({ id: operation.id.trim(), name: operation.name, image: operation.image })
      group.activeId = operation.id.trim()
      break
    case 'select':
      if (operation.id !== null && !slot) return false
      group.activeId = operation.id
      break
    case 'rename':
      if (!slot || !operation.name.trim()) return false
      slot.name = operation.name
      break
    case 'replace':
      if (!slot) return false
      slot.image = operation.image
      break
    case 'copy':
      if (!slot || !operation.newId.trim() || operation.newId.length > 128 || group.slots.some(slot => slot.id === operation.newId.trim())) return false
      group.slots.push({ ...slot, id: operation.newId.trim(), name: `${slot.name} 副本` })
      group.activeId = operation.newId.trim()
      break
    case 'delete': {
      if (!slot) return false
      const index = group.slots.indexOf(slot)
      group.slots.splice(index, 1)
      if (group.activeId === slot.id) {
        const next = [...group.slots.slice(index), ...group.slots.slice(0, index)].find(slot => slot.image)
        group.activeId = next?.id ?? null
      }
      break
    }
    case 'transition':
      group.transition = normalizeSurfaceTransition({ ...group.transition, ...operation.patch })
  }
  const next = normalizeSurfaceVariants(group)
  state.surfaceVariants = { ...state.surfaceVariants, [target]: next }
  state[target] = next.slots.find(slot => slot.id === next.activeId)?.image ?? null
  return true
}
