import { api } from '@/stores/_config'
import type {
  ShortcutRule,
  ShortcutRuleConfig,
  ShortcutRuleListResponse,
  ShortcutRuleScope,
  ShortcutRuleType,
} from './types'

const normalizeRule = (raw: any): ShortcutRule => ({
  id: String(raw?.id || ''),
  scope: raw?.scope === 'world' ? 'world' : 'personal',
  worldId: String(raw?.worldId || ''),
  ownerId: String(raw?.ownerId || ''),
  type: raw?.type === 'replace' || raw?.type === 'message_action' ? raw.type : 'send_alias',
  trigger: String(raw?.trigger || ''),
  command: String(raw?.command || ''),
  config: raw?.config && typeof raw.config === 'object' ? { ...raw.config } : {},
  enabled: raw?.enabled !== false,
  sortOrder: Number(raw?.sortOrder) || 0,
  createdBy: raw?.createdBy || '',
  updatedBy: raw?.updatedBy || '',
  updatedByName: raw?.updatedByName || '',
  createdAt: raw?.createdAt || '',
  updatedAt: raw?.updatedAt || '',
})

export const describeShortcutApiError = (error: unknown, fallback = '操作失败') => {
  const data = (error as any)?.response?.data
  const message = String(data?.message || data?.error || '').trim()
  return message || (error instanceof Error && error.message ? error.message : fallback)
}

export const fetchShortcutRules = async (worldId: string): Promise<ShortcutRuleListResponse> => {
  const resp = await api.get('api/v1/shortcut-rules', { params: worldId ? { worldId } : {} })
  return {
    personal: (resp.data?.personal || []).map(normalizeRule),
    world: (resp.data?.world || []).map(normalizeRule),
    canManageWorld: resp.data?.canManageWorld === true,
  }
}

export interface ShortcutRuleCreatePayload {
  scope: ShortcutRuleScope
  worldId?: string
  type: ShortcutRuleType
  trigger: string
  command: string
  enabled: boolean
  config: ShortcutRuleConfig
}

export const createShortcutRule = async (payload: ShortcutRuleCreatePayload) => {
  const resp = await api.post('api/v1/shortcut-rules', payload)
  return normalizeRule(resp.data?.item)
}

export interface ShortcutRuleUpdatePayload {
  scope?: ShortcutRuleScope
  worldId?: string
  trigger?: string
  command?: string
  enabled?: boolean
  config?: ShortcutRuleConfig
}

export const updateShortcutRule = async (ruleId: string, payload: ShortcutRuleUpdatePayload) => {
  const resp = await api.patch(`api/v1/shortcut-rules/${encodeURIComponent(ruleId)}`, payload)
  return normalizeRule(resp.data?.item)
}

export const deleteShortcutRule = async (ruleId: string) => {
  await api.delete(`api/v1/shortcut-rules/${encodeURIComponent(ruleId)}`)
}

export const reorderShortcutRules = async (scope: ShortcutRuleScope, worldId: string, ids: string[]) => {
  const resp = await api.post('api/v1/shortcut-rules/reorder', { scope, worldId, ids })
  return (resp.data?.items || []).map(normalizeRule) as ShortcutRule[]
}
