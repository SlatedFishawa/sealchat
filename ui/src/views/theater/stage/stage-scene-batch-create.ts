import type { SceneFolder, StageImageRef, StageSurfaceStyle } from '../shared/stage-types'
import { normalizedTheaterMediaType, supportedTheaterMedia } from './stage-media'
import type { StageSceneCreateOptions } from './StageStore'

// Pure helpers and the sequential runner behind StageSceneBatchCreateModal.
// Files are generic so Node regressions can use plain objects.

export interface StageSceneBatchFile {
  name: string
  type: string
  size: number
  lastModified: number
  webkitRelativePath?: string
}

export type StageSceneBatchStatus = 'pending' | 'uploading' | 'created' | 'failed'

export interface StageSceneBatchItem<F extends StageSceneBatchFile = File> {
  key: string
  file: F
  fileName: string
  // Only used for ordering and folder mapping; never written into scene data.
  relativePath: string
  topDirectory: string
  name: string
  status: StageSceneBatchStatus
  error: string
  // Kept after a successful upload so a retry after a later failure skips re-uploading.
  uploaded: StageImageRef | null
  sceneId: string
}

export const STAGE_SCENE_NAME_MAX_LENGTH = 512
const FALLBACK_SCENE_NAME = '未命名场景'

const truncateChars = (value: string, max: number) => {
  const chars = [...value]
  return chars.length > max ? chars.slice(0, max).join('').trim() : value
}

export const sceneNameFromFileName = (fileName: string) => {
  const baseName = fileName.split(/[\\/]/).pop() || ''
  const name = baseName.replace(/\.[^.]*$/, '').trim()
  return truncateChars(name || FALLBACK_SCENE_NAME, STAGE_SCENE_NAME_MAX_LENGTH)
}

export const sceneNameError = (name: string) => {
  const normalized = name.trim()
  if (!normalized) return '场景名称不能为空'
  if ([...normalized].length > STAGE_SCENE_NAME_MAX_LENGTH) return `场景名称不能超过 ${STAGE_SCENE_NAME_MAX_LENGTH} 个字符`
  return ''
}

export const normalizeSceneBatchRelativePath = (file: Pick<StageSceneBatchFile, 'webkitRelativePath'>) => (
  (file.webkitRelativePath || '').replace(/\\/g, '/').split('/').filter(Boolean).join('/')
)

// "Picked/Sub/a.png" -> "Sub". The first segment is the picked directory itself,
// so files directly inside it have no first-level directory.
export const sceneBatchTopDirectory = (relativePath: string) => {
  const segments = relativePath.split('/').filter(Boolean)
  return segments.length > 2 ? segments[1].trim() : ''
}

export const isSupportedSceneBackgroundFile = (file: Pick<StageSceneBatchFile, 'name' | 'type'>) => (
  supportedTheaterMedia.has(normalizedTheaterMediaType(file))
)

export const sceneBatchFileKey = (file: StageSceneBatchFile) => (
  `${normalizeSceneBatchRelativePath(file) || file.name}\u0000${file.size}\u0000${file.lastModified}`
)

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

export const compareSceneBatchPaths = (left: string, right: string) => collator.compare(left, right) || (left < right ? -1 : left > right ? 1 : 0)

export interface SceneBatchCollectResult<F extends StageSceneBatchFile> {
  items: StageSceneBatchItem<F>[]
  unsupported: string[]
  duplicates: number
}

// New files are sorted by relative path (or name) and appended after existing items.
export const collectSceneBatchFiles = <F extends StageSceneBatchFile>(
  files: Iterable<F>,
  existingKeys: ReadonlySet<string> = new Set(),
): SceneBatchCollectResult<F> => {
  const seen = new Set(existingKeys)
  const unsupported: string[] = []
  let duplicates = 0
  const accepted: { file: F, key: string, relativePath: string }[] = []
  for (const file of files) {
    const relativePath = normalizeSceneBatchRelativePath(file)
    if (!isSupportedSceneBackgroundFile(file)) {
      unsupported.push(relativePath || file.name)
      continue
    }
    const key = sceneBatchFileKey(file)
    if (seen.has(key)) {
      duplicates += 1
      continue
    }
    seen.add(key)
    accepted.push({ file, key, relativePath })
  }
  accepted.sort((left, right) => compareSceneBatchPaths(left.relativePath || left.file.name, right.relativePath || right.file.name))
  return {
    items: accepted.map(({ file, key, relativePath }) => ({
      key,
      file,
      fileName: file.name,
      relativePath,
      topDirectory: sceneBatchTopDirectory(relativePath),
      name: sceneNameFromFileName(file.name),
      status: 'pending',
      error: '',
      uploaded: null,
      sceneId: '',
    })),
    unsupported: unsupported.sort(compareSceneBatchPaths),
    duplicates,
  }
}

export type SceneBatchFolderPlan = { folderId: string } | { createFolderName: string }

// Existing folders are matched by exact name, mirroring the store's uniqueness rule.
export const planSceneBatchFolder = (
  topDirectory: string,
  mapTopDirectories: boolean,
  folders: readonly SceneFolder[],
  targetFolderId: string,
): SceneBatchFolderPlan => {
  const name = topDirectory.trim()
  if (!mapTopDirectories || !name) return { folderId: targetFolderId }
  const existing = folders.find((folder) => folder.name === name)
  return existing ? { folderId: existing.id } : { createFolderName: name }
}

export const isSceneBatchRunnable = (item: Pick<StageSceneBatchItem<StageSceneBatchFile>, 'status'>) => (
  item.status === 'pending' || item.status === 'failed'
)

// Narrow capabilities StageApp binds to one theater request scope.
export interface StageSceneBatchSession<F extends StageSceneBatchFile = File> {
  isCurrent: () => boolean
  upload: (file: F) => Promise<StageImageRef>
  createScene: (options: StageSceneCreateOptions) => string | null
  createFolder: (name: string) => SceneFolder | null
  folders: () => readonly SceneFolder[]
}

export interface StageSceneBatchConfig {
  targetFolderId: string
  mapTopDirectories: boolean
  backgroundStyle: StageSurfaceStyle
  backgroundColor: string
}

export interface StageSceneBatchRunHooks<F extends StageSceneBatchFile> {
  isCancelled: () => boolean
  onItemStart?: (item: StageSceneBatchItem<F>) => void
  onItemSettled?: (item: StageSceneBatchItem<F>) => void
}

export interface StageSceneBatchRunResult {
  created: number
  failed: number
  stopped: boolean
}

const stopped = Symbol('scene-batch-stopped')

// Processes runnable items one by one in list order. Each success is committed
// immediately; failures stay on the item and never roll back earlier scenes.
export const runSceneBatch = async <F extends StageSceneBatchFile>(
  items: readonly StageSceneBatchItem<F>[],
  session: StageSceneBatchSession<F>,
  config: StageSceneBatchConfig,
  hooks: StageSceneBatchRunHooks<F>,
): Promise<StageSceneBatchRunResult> => {
  const result: StageSceneBatchRunResult = { created: 0, failed: 0, stopped: false }
  const active = () => !hooks.isCancelled() && session.isCurrent()
  for (const item of items.filter(isSceneBatchRunnable)) {
    if (!active()) {
      result.stopped = true
      break
    }
    item.status = 'uploading'
    item.error = ''
    hooks.onItemStart?.(item)
    try {
      const nameError = sceneNameError(item.name)
      if (nameError) throw new Error(nameError)
      if (!item.uploaded) {
        let image: StageImageRef
        try {
          image = await session.upload(item.file)
        } catch (error) {
          if (!active()) throw stopped
          throw new Error((error instanceof Error && error.message) || '上传失败')
        }
        if (!active()) throw stopped
        item.uploaded = image
      }
      const plan = planSceneBatchFolder(item.topDirectory, config.mapTopDirectories, session.folders(), config.targetFolderId)
      let folderId = 'folderId' in plan ? plan.folderId : ''
      if ('createFolderName' in plan) {
        const folder = session.createFolder(plan.createFolderName)
        if (!active()) throw stopped
        if (!folder) throw new Error(`无法创建场景文件夹“${plan.createFolderName}”（名称过长或文件夹数量已达上限）`)
        folderId = folder.id
      }
      const sceneId = session.createScene({
        name: item.name.trim(),
        folderId: folderId || null,
        backgroundColor: config.backgroundColor,
        backgroundStyle: { ...config.backgroundStyle, overlay: { ...config.backgroundStyle.overlay } },
        background: { image: item.uploaded },
      })
      if (!active()) throw stopped
      if (!sceneId) throw new Error(folderId ? '场景创建失败：目标文件夹可能已被删除' : '场景创建失败')
      item.status = 'created'
      item.sceneId = sceneId
      result.created += 1
    } catch (error) {
      if (error === stopped) {
        item.status = 'pending'
        result.stopped = true
        break
      }
      item.status = 'failed'
      item.error = error instanceof Error ? error.message : '场景创建失败'
      result.failed += 1
    } finally {
      hooks.onItemSettled?.(item)
    }
  }
  return result
}
