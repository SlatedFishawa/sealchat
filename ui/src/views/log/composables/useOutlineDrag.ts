// 编排大纲的指针拖拽排序：鼠标与触摸共用 Pointer Events，不依赖 HTML5 DnD（移动端不可靠）。
// 只计算落点并显示插入线，真正的顺序变更由调用方在 drop 回调里通过纯函数写回草稿。
// DOM 约定：容器内 [data-drop-chapter] 为章节卡片；[data-drop-list="<chapterKey>"] 为片段列表，
// 其中的 [data-drop-row] 为片段行。
import { onBeforeUnmount, ref, shallowRef, type Ref } from 'vue';

export type OutlineDragKind = 'chapter' | 'section';
export interface OutlineDropTarget {
  /** 章节拖拽时为 null；片段拖拽时为目标章节 key。 */
  listKey: string | null;
  index: number;
}

const START_DISTANCE = 5;
const EDGE = 48;

export const useOutlineDrag = (
  container: Ref<HTMLElement | null>,
  onDrop: (kind: OutlineDragKind, id: string, target: OutlineDropTarget) => void,
) => {
  const dragging = shallowRef<{ kind: OutlineDragKind; id: string; label: string } | null>(null);
  const target = shallowRef<OutlineDropTarget | null>(null);
  /** 插入线位置（相对容器内容坐标）。 */
  const indicator = shallowRef<{ top: number; left: number; width: number } | null>(null);
  const ghost = ref<{ x: number; y: number } | null>(null);

  let pending: { kind: OutlineDragKind; id: string; label: string; x: number; y: number; pointerId: number } | null = null;
  let lastY = 0;
  let raf = 0;

  const rows = (list: Element, selector: string) => Array.from(list.querySelectorAll<HTMLElement>(selector));

  const place = (clientY: number) => {
    const root = container.value;
    const d = dragging.value;
    if (!root || !d) return;
    const rootRect = root.getBoundingClientRect();
    const toLocal = (y: number) => y - rootRect.top + root.scrollTop;
    let items: HTMLElement[];
    let listKey: string | null = null;
    let frame: DOMRect;
    if (d.kind === 'chapter') {
      items = rows(root, '[data-drop-chapter]');
      frame = rootRect;
    } else {
      const lists = rows(root, '[data-drop-list]');
      if (!lists.length) return;
      // 优先选垂直方向包含指针的列表，否则取最近的列表。
      let best = lists[0];
      let bestDist = Infinity;
      for (const list of lists) {
        const r = list.getBoundingClientRect();
        const dist = clientY < r.top ? r.top - clientY : clientY > r.bottom ? clientY - r.bottom : 0;
        if (dist < bestDist) {
          best = list;
          bestDist = dist;
        }
      }
      listKey = best.dataset.dropList || null;
      items = rows(best, '[data-drop-row]');
      frame = best.getBoundingClientRect();
    }
    let index = items.length;
    for (let i = 0; i < items.length; i++) {
      const r = items[i].getBoundingClientRect();
      if (clientY < r.top + r.height / 2) {
        index = i;
        break;
      }
    }
    let y: number;
    if (!items.length) y = frame.top + 4;
    else if (index < items.length) y = items[index].getBoundingClientRect().top - 3;
    else y = items[items.length - 1].getBoundingClientRect().bottom + 3;
    const ref0 = items[0]?.getBoundingClientRect() || frame;
    target.value = { listKey, index };
    indicator.value = { top: toLocal(y), left: ref0.left - rootRect.left, width: ref0.width };
  };

  // 指针靠近容器上下边缘时持续滚动，便于在长列表中拖到屏幕外的位置。
  const tick = () => {
    raf = 0;
    const root = container.value;
    if (!root || !dragging.value) return;
    const r = root.getBoundingClientRect();
    let delta = 0;
    if (lastY < r.top + EDGE) delta = -Math.ceil((r.top + EDGE - lastY) / 4);
    else if (lastY > r.bottom - EDGE) delta = Math.ceil((lastY - (r.bottom - EDGE)) / 4);
    if (delta) {
      const before = root.scrollTop;
      root.scrollTop += Math.max(-24, Math.min(24, delta));
      if (root.scrollTop !== before) place(lastY);
      raf = requestAnimationFrame(tick);
    }
  };

  const onMove = (e: PointerEvent) => {
    if (pending && e.pointerId === pending.pointerId && !dragging.value) {
      if (Math.hypot(e.clientX - pending.x, e.clientY - pending.y) < START_DISTANCE) return;
      dragging.value = { kind: pending.kind, id: pending.id, label: pending.label };
    }
    if (!dragging.value || (pending && e.pointerId !== pending.pointerId)) return;
    e.preventDefault();
    lastY = e.clientY;
    ghost.value = { x: e.clientX, y: e.clientY };
    place(e.clientY);
    if (!raf) raf = requestAnimationFrame(tick);
  };

  const stop = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', cancel);
    window.removeEventListener('keydown', onKey, true);
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    pending = null;
    dragging.value = null;
    target.value = null;
    indicator.value = null;
    ghost.value = null;
  };

  const onUp = (e: PointerEvent) => {
    if (pending && e.pointerId !== pending.pointerId) return;
    const d = dragging.value;
    const t = target.value;
    stop();
    if (d && t) onDrop(d.kind, d.id, t);
  };

  const cancel = () => stop();
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && (dragging.value || pending)) {
      e.preventDefault();
      e.stopPropagation();
      stop();
    }
  };

  /** 在拖拽手柄的 pointerdown 上调用；移动超过阈值后才进入拖拽，单击手柄不触发排序。 */
  const begin = (e: PointerEvent, kind: OutlineDragKind, id: string, label: string) => {
    if (e.button !== 0 || pending || dragging.value) return;
    e.preventDefault();
    pending = { kind, id, label, x: e.clientX, y: e.clientY, pointerId: e.pointerId };
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', onKey, true);
  };

  onBeforeUnmount(stop);

  return { dragging, target, indicator, ghost, begin, cancel: stop };
};
