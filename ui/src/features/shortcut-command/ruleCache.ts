import { computed, reactive, type ComputedRef } from 'vue'
import { fetchShortcutRules } from './api'
import { buildEffectiveShortcutRules, type EffectiveShortcutRules } from './ruleMatching'
import type { ShortcutRule, ShortcutRuleScope } from './types'

// 轻量规则缓存：个人规则跨世界共享一份，世界规则按 worldId 缓存。
// 不是 Pinia store：只有快捷命令功能自己读写，状态随登录用户切换整体重置。

interface WorldEntry {
  rules: ShortcutRule[]
  canManageWorld: boolean
  loadedAt: number
  error: string
}

const state = reactive({
  personal: [] as ShortcutRule[],
  personalLoaded: false,
  worlds: {} as Record<string, WorldEntry>,
  loading: {} as Record<string, boolean>,
  generation: 0,
})

const inflight = new Map<string, Promise<void>>()
const effectiveComputeds = new Map<string, ComputedRef<EffectiveShortcutRules>>()

const sortByOrder = (rules: ShortcutRule[]) => rules.sort((a, b) => (a.sortOrder - b.sortOrder) || a.id.localeCompare(b.id))

export const SHORTCUT_RULE_CACHE_MAX_AGE_MS = 60_000

export const resetShortcutRuleCache = () => {
  state.generation += 1
  state.personal = []
  state.personalLoaded = false
  state.worlds = {}
  state.loading = {}
  inflight.clear()
}

export const ensureShortcutRules = (
  worldId: string,
  options: { force?: boolean; maxAgeMs?: number } = {},
): Promise<void> => {
  const key = String(worldId || '').trim()
  const entry = state.worlds[key]
  const maxAge = options.maxAgeMs ?? SHORTCUT_RULE_CACHE_MAX_AGE_MS
  if (!options.force && entry && !entry.error && Date.now() - entry.loadedAt < maxAge) return Promise.resolve()
  const pending = inflight.get(key)
  if (pending && !options.force) return pending
  const generation = state.generation
  state.loading[key] = true
  const request = fetchShortcutRules(key)
    .then((result) => {
      if (generation !== state.generation || inflight.get(key) !== request) return
      state.personal = sortByOrder(result.personal)
      state.personalLoaded = true
      state.worlds[key] = { rules: sortByOrder(result.world), canManageWorld: result.canManageWorld, loadedAt: Date.now(), error: '' }
    })
    .catch((error) => {
      if (generation !== state.generation || inflight.get(key) !== request) return
      const previous = state.worlds[key]
      state.worlds[key] = {
        rules: previous?.rules || [],
        canManageWorld: previous?.canManageWorld || false,
        loadedAt: Date.now(),
        error: error instanceof Error ? error.message : '加载失败',
      }
      throw error
    })
    .finally(() => {
      if (inflight.get(key) === request) {
        inflight.delete(key)
        state.loading[key] = false
      }
    })
  inflight.set(key, request)
  return request
}

export const getShortcutRuleSnapshot = (worldId: string) => {
  const key = String(worldId || '').trim()
  const entry = state.worlds[key]
  return {
    personal: state.personal,
    world: entry?.rules || [],
    canManageWorld: entry?.canManageWorld === true,
    loaded: !!entry,
    loading: state.loading[key] === true,
    error: entry?.error || '',
  }
}

/** 当前用户在某世界中生效的规则；每个世界共享一个 computed，供大量消息行复用。 */
export const getEffectiveShortcutRules = (worldId: string): EffectiveShortcutRules => {
  const key = String(worldId || '').trim()
  let effective = effectiveComputeds.get(key)
  if (!effective) {
    effective = computed(() => buildEffectiveShortcutRules(state.personal, state.worlds[key]?.rules || []))
    effectiveComputeds.set(key, effective)
  }
  return effective.value
}

const bucketList = (scope: ShortcutRuleScope, worldId: string) => {
  if (scope === 'personal') return state.personal
  return state.worlds[worldId]?.rules
}

const removeEverywhere = (ruleId: string) => {
  state.personal = state.personal.filter((rule) => rule.id !== ruleId)
  for (const entry of Object.values(state.worlds)) {
    if (entry.rules.some((rule) => rule.id === ruleId)) entry.rules = entry.rules.filter((rule) => rule.id !== ruleId)
  }
}

/** 本地写入创建/更新结果（包括作用域移动）。 */
export const applyShortcutRuleUpsert = (rule: ShortcutRule) => {
  removeEverywhere(rule.id)
  if (rule.scope === 'personal') {
    state.personal = sortByOrder([...state.personal, rule])
    return
  }
  const entry = state.worlds[rule.worldId]
  if (entry) entry.rules = sortByOrder([...entry.rules, rule])
}

export const applyShortcutRuleRemoval = (ruleId: string) => removeEverywhere(ruleId)

export const applyShortcutRuleOrder = (scope: ShortcutRuleScope, worldId: string, rules: ShortcutRule[]) => {
  if (!bucketList(scope, worldId)) return
  if (scope === 'personal') state.personal = sortByOrder(rules.slice())
  else state.worlds[worldId].rules = sortByOrder(rules.slice())
}
