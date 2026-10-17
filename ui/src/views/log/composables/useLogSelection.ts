// 选择模型：以源节点 ID（消息 ID 或 el-<元素ID>）为键，不使用 DOM 下标或分页片段。
// 单选、Shift 连选、Ctrl/Cmd 追加、Esc 清除；跨页片段共享同一 ID。
import { computed, ref, type Ref } from 'vue';

export const useLogSelection = (orderedIds: Ref<string[]>) => {
  const selected = ref<string[]>([]);
  let pivot: string | null = null;

  const select = (id: string | null, opts: { shift?: boolean; additive?: boolean } = {}) => {
    if (!id) {
      selected.value = [];
      pivot = null;
      return;
    }
    const isElement = id.startsWith('el-');
    if (opts.shift && pivot && !isElement && !pivot.startsWith('el-')) {
      const order = orderedIds.value.filter((x) => !x.startsWith('el-'));
      const a = order.indexOf(pivot);
      const b = order.indexOf(id);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        selected.value = order.slice(lo, hi + 1);
        return;
      }
    }
    if (opts.additive && !isElement && selected.value.every((x) => !x.startsWith('el-'))) {
      selected.value = selected.value.includes(id) ? selected.value.filter((x) => x !== id) : [...selected.value, id];
      pivot = id;
      return;
    }
    selected.value = [id];
    pivot = id;
  };

  /** 数据刷新后剔除已不存在的选中项（例如消息被删除或移出范围）。 */
  const prune = (existing: Set<string>) => {
    const next = selected.value.filter((id) => existing.has(id));
    if (next.length !== selected.value.length) selected.value = next;
    if (pivot && !existing.has(pivot)) pivot = null;
  };

  const elementId = computed(() => (selected.value.length === 1 && selected.value[0].startsWith('el-') ? selected.value[0].slice(3) : null));
  const messageIds = computed(() => selected.value.filter((id) => !id.startsWith('el-')));

  return { selected, select, prune, elementId, messageIds, clear: () => select(null) };
};
