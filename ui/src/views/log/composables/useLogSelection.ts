// 选择模型：以源节点 ID（消息 ID 或 el-<元素ID>）为键，不使用 DOM 下标或分页片段。
// 单选、Shift 连选、Ctrl/Cmd 追加、Esc 清除；跨页片段共享同一 ID。
// 多选模式是工作台局部的瞬时状态：点击切换、Shift 或范围模式连选（并入已选），元素不参与。
import { computed, ref, type Ref } from 'vue';

const isElementId = (id: string) => id.startsWith('el-');

export const useLogSelection = (orderedIds: Ref<string[]>) => {
  const selected = ref<string[]>([]);
  const multi = ref(false);
  /** 范围模式：第一次点击为起点，第二次点击把两者之间的消息并入选择。 */
  const rangeMode = ref(false);
  const rangeAnchor = ref<string | null>(null);
  let pivot: string | null = null;

  const messageOrder = () => orderedIds.value.filter((x) => !isElementId(x));
  const rangeBetween = (from: string, to: string) => {
    const order = messageOrder();
    const a = order.indexOf(from);
    const b = order.indexOf(to);
    if (a < 0 || b < 0) return null;
    const [lo, hi] = a < b ? [a, b] : [b, a];
    return order.slice(lo, hi + 1);
  };
  /** 并入后按显示顺序保存，便于批量操作与提示。 */
  const merge = (ids: string[]) => {
    const set = new Set([...selected.value, ...ids]);
    selected.value = messageOrder().filter((x) => set.has(x));
  };

  const pickInMulti = (id: string | null, opts: { shift?: boolean }) => {
    if (!id || isElementId(id)) return; // 空白处与元素不改变多选
    if (rangeMode.value) {
      const anchor = rangeAnchor.value;
      const range = anchor && anchor !== id ? rangeBetween(anchor, id) : null;
      if (range) {
        merge(range);
        rangeAnchor.value = null;
      } else {
        merge([id]);
        rangeAnchor.value = id;
      }
      pivot = id;
      return;
    }
    if (opts.shift && pivot && pivot !== id) {
      const range = rangeBetween(pivot, id);
      if (range) {
        merge(range);
        pivot = id;
        return;
      }
    }
    if (selected.value.includes(id)) selected.value = selected.value.filter((x) => x !== id);
    else merge([id]);
    pivot = id;
  };

  const select = (id: string | null, opts: { shift?: boolean; additive?: boolean } = {}) => {
    if (multi.value) {
      pickInMulti(id, opts);
      return;
    }
    if (!id) {
      selected.value = [];
      pivot = null;
      return;
    }
    const isElement = isElementId(id);
    if (opts.shift && pivot && !isElement && !isElementId(pivot)) {
      const range = rangeBetween(pivot, id);
      if (range) {
        selected.value = range;
        return;
      }
    }
    if (opts.additive && !isElement && selected.value.every((x) => !isElementId(x))) {
      selected.value = selected.value.includes(id) ? selected.value.filter((x) => x !== id) : [...selected.value, id];
      pivot = id;
      return;
    }
    selected.value = [id];
    pivot = id;
  };

  /** 进入多选：给定消息成为第一条选中消息；否则沿用当前已选的消息（丢弃元素选择）。 */
  const enterMulti = (seedId?: string | null) => {
    const seed = seedId && !isElementId(seedId) ? seedId : null;
    const keep = seed ? [seed] : selected.value.filter((x) => !isElementId(x));
    multi.value = true;
    rangeMode.value = false;
    rangeAnchor.value = null;
    selected.value = [];
    merge(keep);
    pivot = seed || selected.value[selected.value.length - 1] || null;
  };

  const exitMulti = () => {
    multi.value = false;
    rangeMode.value = false;
    rangeAnchor.value = null;
    selected.value = [];
    pivot = null;
  };

  /** 全选当前来源片段（已加载窗口）中的全部消息，不含 LOG 元素。 */
  const selectAll = () => {
    if (!multi.value) return;
    selected.value = messageOrder();
  };

  const toggleRangeMode = () => {
    if (!multi.value) return;
    rangeMode.value = !rangeMode.value;
    rangeAnchor.value = null;
  };

  /** 数据刷新后剔除已不存在的选中项（例如消息被删除或移出范围）。 */
  const prune = (existing: Set<string>) => {
    const next = selected.value.filter((id) => existing.has(id));
    if (next.length !== selected.value.length) selected.value = next;
    if (pivot && !existing.has(pivot)) pivot = null;
    if (rangeAnchor.value && !existing.has(rangeAnchor.value)) rangeAnchor.value = null;
  };

  const elementId = computed(() => (selected.value.length === 1 && isElementId(selected.value[0]) ? selected.value[0].slice(3) : null));
  const messageIds = computed(() => selected.value.filter((id) => !isElementId(id)));

  return {
    selected,
    select,
    prune,
    elementId,
    messageIds,
    clear: () => {
      selected.value = [];
      pivot = null;
      rangeAnchor.value = null;
    },
    multi,
    rangeMode,
    rangeAnchor,
    enterMulti,
    exitMulti,
    selectAll,
    toggleRangeMode,
  };
};
