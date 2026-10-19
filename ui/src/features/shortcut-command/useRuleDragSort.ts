import { ref } from 'vue'

// 维护模式下的规则排序：同一分组（同作用域、同标签页类型）内拖拽或上下移动。

export const moveIdBefore = (ids: readonly string[], movingId: string, targetId: string): string[] => {
  const from = ids.indexOf(movingId)
  const to = ids.indexOf(targetId)
  if (from < 0 || to < 0 || from === to) return ids.slice()
  const next = ids.slice()
  next.splice(from, 1)
  // 移除后在原目标下标插入：向下拖动落在目标之后，向上拖动落在目标之前
  next.splice(to, 0, movingId)
  return next
}

export const moveIdBy = (ids: readonly string[], movingId: string, delta: number): string[] => {
  const from = ids.indexOf(movingId)
  const to = Math.max(0, Math.min(ids.length - 1, from + delta))
  if (from < 0 || from === to) return ids.slice()
  const next = ids.slice()
  next.splice(from, 1)
  next.splice(to, 0, movingId)
  return next
}

export const useRuleDragSort = (commit: (groupKey: string, ids: string[]) => void) => {
  const dragging = ref<{ groupKey: string; id: string } | null>(null)
  const overId = ref('')

  const onDragStart = (groupKey: string, id: string, event: DragEvent) => {
    dragging.value = { groupKey, id }
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('text/plain', id)
    }
  }

  const onDragOver = (groupKey: string, id: string, event: DragEvent) => {
    if (dragging.value?.groupKey !== groupKey) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    overId.value = id
  }

  const onDrop = (groupKey: string, ids: readonly string[], targetId: string, event: DragEvent) => {
    const current = dragging.value
    dragging.value = null
    overId.value = ''
    if (!current || current.groupKey !== groupKey) return
    event.preventDefault()
    const next = moveIdBefore(ids, current.id, targetId)
    if (next.join('|') !== ids.join('|')) commit(groupKey, next)
  }

  const onDragEnd = () => {
    dragging.value = null
    overId.value = ''
  }

  const move = (groupKey: string, ids: readonly string[], id: string, delta: number) => {
    const next = moveIdBy(ids, id, delta)
    if (next.join('|') !== ids.join('|')) commit(groupKey, next)
  }

  return { dragging, overId, onDragStart, onDragOver, onDrop, onDragEnd, move }
}
