import type { WorldClueFolder, WorldClueSummary } from '@/stores/worldClue'
import type { WorldClueCsvRow } from './world-clue-batch-csv'

// Pure model, validation and sequential runner behind WorldClueBatchCreateModal.
// Image files are generic so Node regressions can use plain objects.

export type WorldClueBatchAccess = 'view' | 'none'
export type WorldClueBatchStatus = 'pending' | 'creating' | 'created' | 'failed'

export interface WorldClueBatchFile {
  name: string
  type: string
  size: number
}

export interface WorldClueBatchItem<F extends WorldClueBatchFile = File> {
  key: string
  // CSV line where the record starts; null for manually added items.
  line: number | null
  title: string
  content: string
  imageUrl: string
  imageFile: F | null
  folderId: string
  defaultAccess: WorldClueBatchAccess
  // Import problems that only a user choice can resolve (cleared when the field is edited).
  issues: { folder?: string, defaultAccess?: string }
  status: WorldClueBatchStatus
  error: string
  // Kept after a successful upload so a retry after a failed create skips re-uploading.
  attachmentId: string
  clueId: string
  // Assigned once before execution, including failed/pending items on retry.
  orderIndex: number | null
}

export interface WorldClueBatchDefaults {
  folderId: string
  defaultAccess: WorldClueBatchAccess
}

export type WorldClueBatchField = 'title' | 'imageUrl' | 'imageFile' | 'folder' | 'defaultAccess'
export type WorldClueBatchErrors = Partial<Record<WorldClueBatchField, string>>

export const WORLD_CLUE_TITLE_MAX_LENGTH = 255
export const WORLD_CLUE_ROOT_FOLDER_LABEL = '根目录'
const FOLDER_PATH_SEPARATOR = '/'

let keySeed = 0
const nextKey = () => `clue-batch-${Date.now().toString(36)}-${(keySeed += 1).toString(36)}`

export const createWorldClueBatchItem = <F extends WorldClueBatchFile = File>(
  defaults: WorldClueBatchDefaults,
  values: Partial<Pick<WorldClueBatchItem<F>, 'line' | 'title' | 'content' | 'imageUrl' | 'imageFile' | 'folderId' | 'defaultAccess' | 'issues'>> = {},
): WorldClueBatchItem<F> => ({
  key: nextKey(),
  line: values.line ?? null,
  title: values.title ?? '',
  content: values.content ?? '',
  imageUrl: values.imageUrl ?? '',
  imageFile: values.imageFile ?? null,
  folderId: values.folderId ?? defaults.folderId,
  defaultAccess: values.defaultAccess ?? defaults.defaultAccess,
  issues: { ...values.issues },
  status: 'pending',
  error: '',
  attachmentId: '',
  clueId: '',
  orderIndex: null,
})

export const isWorldClueBatchRunnable = (item: Pick<WorldClueBatchItem<WorldClueBatchFile>, 'status'>) => (
  item.status === 'pending' || item.status === 'failed'
)

export const setWorldClueBatchFolder = (
  item: Pick<WorldClueBatchItem<WorldClueBatchFile>, 'folderId' | 'orderIndex' | 'issues'>,
  folderId: string,
) => {
  if (item.folderId !== folderId) item.orderIndex = null
  item.folderId = folderId
  delete item.issues.folder
}

export const isHttpImageUrl = (value: string) => {
  const trimmed = value.trim()
  if (!trimmed) return false
  try {
    const parsed = new URL(trimmed)
    return !!parsed.host && (parsed.protocol === 'http:' || parsed.protocol === 'https:')
  } catch {
    return false
  }
}

export const isBatchImageFile = (file: Pick<WorldClueBatchFile, 'type'>) => file.type.toLowerCase().startsWith('image/')

export const validateWorldClueBatchItem = (
  item: WorldClueBatchItem<WorldClueBatchFile>,
  folderIds: ReadonlySet<string>,
): WorldClueBatchErrors => {
  const errors: WorldClueBatchErrors = {}
  const title = item.title.trim()
  if (!title) errors.title = '标题不能为空'
  else if ([...title].length > WORLD_CLUE_TITLE_MAX_LENGTH) errors.title = `标题不能超过 ${WORLD_CLUE_TITLE_MAX_LENGTH} 个字符`
  if (item.imageFile) {
    if (!isBatchImageFile(item.imageFile)) errors.imageFile = '仅支持图片文件'
  } else if (item.imageUrl.trim() && !isHttpImageUrl(item.imageUrl)) {
    errors.imageUrl = '图片地址必须是 http/https 链接'
  }
  if (item.issues.folder) errors.folder = item.issues.folder
  else if (item.folderId && !folderIds.has(item.folderId)) errors.folder = '目标文件夹已不存在，请重新选择'
  if (item.issues.defaultAccess) errors.defaultAccess = item.issues.defaultAccess
  return errors
}

export const firstWorldClueBatchError = (errors: WorldClueBatchErrors) => (
  errors.title || errors.imageFile || errors.imageUrl || errors.folder || errors.defaultAccess || ''
)

// --- Shared folder paths -----------------------------------------------------

type FolderLike = Pick<WorldClueFolder, 'id' | 'name' | 'parentId' | 'scope' | 'orderIndex'>

const normalizeSegment = (value: string) => value.normalize('NFC').trim()

export interface WorldClueFolderOption {
  id: string
  path: string[]
  label: string
}

// Shared folders in tree order (siblings by orderIndex) with their full name path.
// Folders whose parent is missing are treated as top-level; cycles are cut.
export const sharedWorldClueFolderOptions = (folders: readonly FolderLike[]): WorldClueFolderOption[] => {
  const shared = folders.filter((folder) => folder.scope === 'shared')
  const ids = new Set(shared.map((folder) => folder.id))
  const children = new Map<string, FolderLike[]>()
  for (const folder of shared) {
    const parent = folder.parentId && ids.has(folder.parentId) && folder.parentId !== folder.id ? folder.parentId : ''
    const list = children.get(parent) || []
    list.push(folder)
    children.set(parent, list)
  }
  const result: WorldClueFolderOption[] = []
  const visited = new Set<string>()
  const walk = (parentId: string, path: string[]) => {
    const list = [...(children.get(parentId) || [])].sort((a, b) => a.orderIndex - b.orderIndex)
    for (const folder of list) {
      if (visited.has(folder.id)) continue
      visited.add(folder.id)
      const nextPath = [...path, folder.name]
      result.push({ id: folder.id, path: nextPath, label: nextPath.join(` ${FOLDER_PATH_SEPARATOR} `) })
      walk(folder.id, nextPath)
    }
  }
  walk('', [])
  return result
}

export type WorldClueFolderResolution = { folderId: string } | { error: string }

// Resolves a CSV folder cell against existing shared folders. Never creates folders.
// "A/B" is a path from the root; a bare name is accepted only when it is unique.
export const resolveWorldClueFolderPath = (
  raw: string,
  options: readonly WorldClueFolderOption[],
): WorldClueFolderResolution => {
  const value = raw.trim()
  if (value === FOLDER_PATH_SEPARATOR || value === WORLD_CLUE_ROOT_FOLDER_LABEL) return { folderId: '' }
  const segments = value.split(FOLDER_PATH_SEPARATOR).map(normalizeSegment).filter(Boolean)
  if (!segments.length) return { folderId: '' }
  const key = segments.join(FOLDER_PATH_SEPARATOR)
  const exact = options.filter((option) => option.path.map(normalizeSegment).join(FOLDER_PATH_SEPARATOR) === key)
  if (exact.length === 1) return { folderId: exact[0].id }
  if (exact.length > 1) return { error: `文件夹路径“${value}”对应多个文件夹，请在列表中手动选择` }
  if (segments.length === 1) {
    const byName = options.filter((option) => normalizeSegment(option.path[option.path.length - 1]) === segments[0])
    if (byName.length === 1) return { folderId: byName[0].id }
    if (byName.length > 1) return { error: `存在多个名为“${segments[0]}”的文件夹，请填写完整路径（如 上级/${segments[0]}）或手动选择` }
  }
  return { error: `未找到文件夹“${value}”，请选择已有文件夹` }
}

// --- CSV rows -> items ------------------------------------------------------

const VIEW_VALUES = new Set(['view', 'visible', '可查看', '默认可查看', '可见', '公开'])
const NONE_VALUES = new Set(['none', 'hidden', '不可见', '默认不可见', '隐藏'])

export const parseWorldClueBatchAccess = (raw: string): WorldClueBatchAccess | null => {
  const value = raw.trim().toLowerCase()
  if (VIEW_VALUES.has(value)) return 'view'
  if (NONE_VALUES.has(value)) return 'none'
  return null
}

export const createWorldClueBatchItemsFromCsv = (
  rows: readonly WorldClueCsvRow[],
  defaults: WorldClueBatchDefaults,
  folderOptions: readonly WorldClueFolderOption[],
): WorldClueBatchItem[] => rows.map((row) => {
  const issues: WorldClueBatchItem['issues'] = {}
  let folderId = defaults.folderId
  if (row.folder.trim()) {
    const resolved = resolveWorldClueFolderPath(row.folder, folderOptions)
    if ('error' in resolved) issues.folder = resolved.error
    else folderId = resolved.folderId
  }
  let defaultAccess = defaults.defaultAccess
  if (row.visibility.trim()) {
    const parsed = parseWorldClueBatchAccess(row.visibility)
    if (parsed) defaultAccess = parsed
    else issues.defaultAccess = `无法识别的可见性“${row.visibility.trim()}”，可填 view / none`
  }
  return createWorldClueBatchItem(defaults, {
    line: row.line,
    title: row.title.trim(),
    content: row.content,
    imageUrl: row.imageUrl.trim(),
    folderId,
    defaultAccess,
    issues,
  })
})

// --- Runner -------------------------------------------------------------------

type OrderSummary = Pick<WorldClueSummary, 'sharedFolderId' | 'orderIndex'>

export const assignWorldClueBatchOrder = (
  items: readonly WorldClueBatchItem<WorldClueBatchFile>[],
  summaries: readonly OrderSummary[],
) => {
  const maxima = new Map<string, number>()
  const remember = (folderId: string, orderIndex: number) => {
    maxima.set(folderId, Math.max(maxima.get(folderId) ?? -Infinity, orderIndex))
  }
  for (const summary of summaries) remember(summary.sharedFolderId || '', summary.orderIndex)
  // Reserve all prior assignments, even when a failed create is absent from summaries.
  for (const item of items) {
    if (item.orderIndex !== null) remember(item.folderId, item.orderIndex)
  }
  for (const item of items) {
    if (!isWorldClueBatchRunnable(item) || item.orderIndex !== null) continue
    item.orderIndex = (maxima.get(item.folderId) ?? -1) + 1
    remember(item.folderId, item.orderIndex)
  }
}

export interface WorldClueBatchCreatePayload {
  title: string
  kind: 'text' | 'image'
  contentFormat: 'plain'
  content: string
  defaultAccess: WorldClueBatchAccess
  sharedFolderId: string
  orderIndex: number
  imageAttachmentId?: string
  imageUrl?: string
}

// Uses the same fields as the single-clue create; presentation is omitted so the
// server applies its default presentation (identical to the editor's defaults).
export const buildWorldClueCreatePayload = (
  item: Pick<WorldClueBatchItem<WorldClueBatchFile>, 'title' | 'content' | 'imageUrl' | 'imageFile' | 'folderId' | 'defaultAccess' | 'orderIndex'>,
  attachmentId = '',
): WorldClueBatchCreatePayload => {
  if (item.orderIndex === null) throw new Error('尚未分配批量线索顺序')
  const payload: WorldClueBatchCreatePayload = {
    title: item.title.trim(),
    kind: 'text',
    contentFormat: 'plain',
    content: item.content,
    defaultAccess: item.defaultAccess,
    sharedFolderId: item.folderId,
    orderIndex: item.orderIndex,
  }
  if (item.imageFile && attachmentId) {
    payload.kind = 'image'
    payload.imageAttachmentId = attachmentId
  } else if (!item.imageFile && item.imageUrl.trim()) {
    payload.kind = 'image'
    payload.imageUrl = item.imageUrl.trim()
  }
  return payload
}

// Narrow capabilities bound to one world/permission scope captured at run start.
export interface WorldClueBatchSession<F extends WorldClueBatchFile = File> {
  isCurrent: () => boolean
  folderIds: () => ReadonlySet<string>
  summaries: () => readonly OrderSummary[]
  upload: (file: F) => Promise<string>
  create: (payload: WorldClueBatchCreatePayload) => Promise<{ id: string }>
}

export interface WorldClueBatchRunHooks<F extends WorldClueBatchFile> {
  isCancelled: () => boolean
  onItemStart?: (item: WorldClueBatchItem<F>) => void
  onItemSettled?: (item: WorldClueBatchItem<F>) => void
}

export interface WorldClueBatchRunResult {
  created: number
  failed: number
  stopped: boolean
  // 'context' means the world/permission scope became invalid during the run.
  stopReason: 'user' | 'context' | null
}

export const worldClueBatchErrorMessage = (error: unknown, fallback: string) => {
  const response = (error as { response?: { data?: { message?: unknown } } } | null)?.response
  const message = response?.data?.message
  if (typeof message === 'string' && message.trim()) return message
  if (error instanceof Error && error.message) return error.message
  return fallback
}

const stopped = Symbol('clue-batch-stopped')

// Processes runnable items one by one in list order. Created items are never
// touched again, so a retry only re-runs pending/failed items.
export const runWorldClueBatch = async <F extends WorldClueBatchFile>(
  items: readonly WorldClueBatchItem<F>[],
  session: WorldClueBatchSession<F>,
  hooks: WorldClueBatchRunHooks<F>,
): Promise<WorldClueBatchRunResult> => {
  const result: WorldClueBatchRunResult = { created: 0, failed: 0, stopped: false, stopReason: null }
  const stopReason = () => hooks.isCancelled() ? 'user' as const : !session.isCurrent() ? 'context' as const : null
  if (!stopReason()) assignWorldClueBatchOrder(items, session.summaries())
  for (const item of items.filter(isWorldClueBatchRunnable)) {
    const reason = stopReason()
    if (reason) {
      result.stopped = true
      result.stopReason = reason
      break
    }
    item.status = 'creating'
    item.error = ''
    hooks.onItemStart?.(item)
    try {
      const validationError = firstWorldClueBatchError(validateWorldClueBatchItem(item, session.folderIds()))
      if (validationError) throw new Error(validationError)
      if (item.imageFile && !item.attachmentId) {
        let attachmentId: string
        try {
          attachmentId = await session.upload(item.imageFile)
        } catch (error) {
          if (stopReason()) throw stopped
          throw new Error(worldClueBatchErrorMessage(error, '图片上传失败'))
        }
        if (!attachmentId) throw new Error('图片上传失败')
        item.attachmentId = attachmentId
        if (stopReason()) throw stopped
      }
      let created: { id: string }
      try {
        created = await session.create(buildWorldClueCreatePayload(item, item.attachmentId))
      } catch (error) {
        throw new Error(worldClueBatchErrorMessage(error, '线索创建失败'))
      }
      item.status = 'created'
      item.clueId = created.id
      result.created += 1
    } catch (error) {
      if (error === stopped) {
        item.status = 'pending'
        result.stopped = true
        result.stopReason = stopReason() || 'user'
        break
      }
      item.status = 'failed'
      item.error = error instanceof Error ? error.message : '线索创建失败'
      result.failed += 1
    } finally {
      hooks.onItemSettled?.(item)
    }
  }
  return result
}
