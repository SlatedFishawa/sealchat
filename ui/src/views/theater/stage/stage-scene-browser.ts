import type { SceneFolder, StageScene } from '../shared/stage-types'

// Local-only Scene Browser presentation helpers. Nothing here enters StageStore,
// history, or synchronization.

export type SceneBrowserViewMode = 'list' | 'grid'
export type SceneBrowserThumbSize = 'small' | 'medium' | 'large'

export const sceneBrowserViewModeStorageKey = 'sealchat.theater.scene-browser.view-mode.v1'
export const sceneBrowserThumbSizeStorageKey = 'sealchat.theater.scene-browser.thumb-size.v1'
export const sceneBrowserThumbSizes: readonly SceneBrowserThumbSize[] = ['small', 'medium', 'large']

// Requested longest edge in pixels; covers roughly 2x density for each grid size.
export const sceneBrowserThumbRequestSize: Record<SceneBrowserThumbSize, number> = {
  small: 160,
  medium: 240,
  large: 360,
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

const defaultStorage = (): StorageLike | null => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

// An omitted storage argument uses localStorage; null disables persistence.
const readStoredValue = <T extends string>(key: string, allowed: readonly T[], fallback: T, storage: StorageLike | null = defaultStorage()): T => {
  try {
    const stored = storage?.getItem(key)
    return allowed.includes(stored as T) ? stored as T : fallback
  } catch {
    return fallback
  }
}

const writeStoredValue = (key: string, value: string, storage: StorageLike | null = defaultStorage()) => {
  try {
    storage?.setItem(key, value)
  } catch {
    // Browser storage may be unavailable; keep the preference in memory.
  }
}

export const readSceneBrowserViewMode = (storage?: StorageLike | null) => (
  readStoredValue<SceneBrowserViewMode>(sceneBrowserViewModeStorageKey, ['list', 'grid'], 'list', storage)
)

export const writeSceneBrowserViewMode = (mode: SceneBrowserViewMode, storage?: StorageLike | null) => (
  writeStoredValue(sceneBrowserViewModeStorageKey, mode, storage)
)

export const readSceneBrowserThumbSize = (storage?: StorageLike | null) => (
  readStoredValue<SceneBrowserThumbSize>(sceneBrowserThumbSizeStorageKey, sceneBrowserThumbSizes, 'medium', storage)
)

export const writeSceneBrowserThumbSize = (size: SceneBrowserThumbSize, storage?: StorageLike | null) => (
  writeStoredValue(sceneBrowserThumbSizeStorageKey, size, storage)
)

export const normalizeSceneSearchQuery = (query: string) => query.trim().toLocaleLowerCase()

export const sceneMatchesSearch = (scene: Pick<StageScene, 'name'>, normalizedQuery: string) => (
  !normalizedQuery || scene.name.toLocaleLowerCase().includes(normalizedQuery)
)

// '' stands for the virtual "未分类" folder, matching StageStore semantics for
// scenes whose folderId is missing or points at a deleted folder.
export const effectiveSceneFolderId = (scene: Pick<StageScene, 'folderId'>, folderIds: ReadonlySet<string>) => (
  scene.folderId && folderIds.has(scene.folderId) ? scene.folderId : ''
)

export const resolveSceneGridFolderId = (selected: string | null, folders: readonly SceneFolder[]) => (
  selected && folders.some((folder) => folder.id === selected) ? selected : ''
)

export type SceneListEntry =
  | { kind: 'scene', key: string, scene: StageScene, nested: boolean, folderName?: string | null }
  | { kind: 'folder', key: string, folder: SceneFolder, scenes: StageScene[], collapsed: boolean }
  | { kind: 'uncategorized', key: string, scenes: StageScene[], collapsed: boolean }

// List mode keeps folder grouping; while searching, folders without matches
// are hidden and matches stay visible even inside collapsed folders.
export const buildSceneListEntries = (input: {
  scenes: readonly StageScene[]
  folders: readonly SceneFolder[]
  normalizedQuery: string
  isCollapsed: (folderId: string) => boolean
  includeEmptyFolders: boolean
}): SceneListEntry[] => {
  const { folders, normalizedQuery: query } = input
  const folderIds = new Set(folders.map((folder) => folder.id))
  const grouped = new Map<string, StageScene[]>()
  const uncategorized: StageScene[] = []
  input.scenes.forEach((scene) => {
    if (!sceneMatchesSearch(scene, query)) return
    const folderId = effectiveSceneFolderId(scene, folderIds)
    if (!folderId) uncategorized.push(scene)
    else {
      const bucket = grouped.get(folderId)
      if (bucket) bucket.push(scene)
      else grouped.set(folderId, [scene])
    }
  })
  const entries: SceneListEntry[] = []
  folders.forEach((folder) => {
    const scenesInFolder = grouped.get(folder.id) || []
    if (query && !scenesInFolder.length) return
    const collapsed = !query && input.isCollapsed(folder.id)
    entries.push({ kind: 'folder', key: `folder:${folder.id}`, folder, scenes: scenesInFolder, collapsed })
    if (!collapsed) scenesInFolder.forEach((scene) => entries.push({ kind: 'scene', key: scene.id, scene, nested: true }))
  })
  if (!query || uncategorized.length) {
    const collapsed = !query && input.isCollapsed('')
    entries.push({ kind: 'uncategorized', key: 'virtual-folder:uncategorized', scenes: uncategorized, collapsed })
    if (!collapsed) uncategorized.forEach((scene) => entries.push({ kind: 'scene', key: scene.id, scene, nested: true }))
  }
  return input.includeEmptyFolders
    ? entries
    : entries.filter((entry) => entry.kind === 'scene' || entry.scenes.length > 0)
}

export interface SceneGridFolderTab {
  id: string
  name: string
  count: number
  folder: SceneFolder | null
}

export const buildSceneGridFolderTabs = (folders: readonly SceneFolder[], scenes: readonly StageScene[]): SceneGridFolderTab[] => {
  const folderIds = new Set(folders.map((folder) => folder.id))
  const counts = new Map<string, number>()
  scenes.forEach((scene) => {
    const folderId = effectiveSceneFolderId(scene, folderIds)
    counts.set(folderId, (counts.get(folderId) || 0) + 1)
  })
  return [
    ...folders.map((folder) => ({ id: folder.id, name: folder.name, count: counts.get(folder.id) || 0, folder })),
    { id: '', name: '未分类', count: counts.get('') || 0, folder: null },
  ]
}

export interface SceneGridEntry {
  scene: StageScene
  folderName: string | null
}

// Searching shows global matches labelled with their folder; otherwise only
// the selected folder tab is shown in store order.
export const buildSceneGridEntries = (
  scenes: readonly StageScene[],
  folders: readonly SceneFolder[],
  selectedFolderId: string,
  normalizedQuery: string,
): SceneGridEntry[] => {
  const folderIds = new Set(folders.map((folder) => folder.id))
  const folderNames = new Map(folders.map((folder) => [folder.id, folder.name]))
  if (normalizedQuery) {
    return scenes
      .filter((scene) => sceneMatchesSearch(scene, normalizedQuery))
      .map((scene) => {
        const folderId = effectiveSceneFolderId(scene, folderIds)
        return { scene, folderName: folderId ? folderNames.get(folderId) || '' : '未分类' }
      })
  }
  return scenes
    .filter((scene) => effectiveSceneFolderId(scene, folderIds) === selectedFolderId)
    .map((scene) => ({ scene, folderName: null }))
}

export type SceneBrowserDropTarget =
  | { kind: 'scene', id: string, placement: 'before' | 'after' }
  | { kind: 'folder', folderId: string }

// Search results are filtered, so neighbouring cards do not define a stable
// position; only folder targets stay valid while searching.
export const resolveSceneBrowserDropTarget = (input: {
  sourceSceneId: string
  searching: boolean
  folderId?: string | null
  sceneId?: string | null
  placement?: 'before' | 'after'
}): SceneBrowserDropTarget | null => {
  if (typeof input.folderId === 'string') return { kind: 'folder', folderId: input.folderId }
  if (input.searching || !input.sceneId || input.sceneId === input.sourceSceneId) return null
  return { kind: 'scene', id: input.sceneId, placement: input.placement || 'after' }
}
