import { computed, ref, type Ref } from 'vue';

// 聊天输入框的候选浮层状态机：世界术语、快速备选等多个候选来源共用
// 一个活动浮层与一套键盘导航生命周期（ArrowUp/ArrowDown/Enter/Escape、鼠标悬停与选择）。
// 来源只负责提供候选与“选中后如何修改输入框”，同一时刻只有一个来源处于活动状态。

export interface ComposerSuggestOption {
  id: string;
  label: string;
  category?: string;
  description?: string;
}

export interface ComposerSuggestProvider {
  options: Readonly<Ref<ComposerSuggestOption[]>>;
  loading?: Readonly<Ref<boolean>>;
  /** 没有候选时的提示；为空表示没有候选时不显示浮层 */
  emptyText?: Readonly<Ref<string>>;
  /** 浮层顶部的来源说明 */
  title?: Readonly<Ref<string>>;
  apply: (option: ComposerSuggestOption) => void;
  /** Escape 关闭浮层时调用 */
  dismiss?: () => void;
}

export type ComposerSuggestInitialIndex = 'first' | 'last' | number;

const clampIndex = (index: number, length: number) => (length > 0 ? Math.min(Math.max(index, 0), length - 1) : 0);

export const useComposerSuggest = <K extends string>(providers: Record<K, ComposerSuggestProvider>) => {
  const activeProvider = ref<K | null>(null) as Ref<K | null>;
  const rawIndex = ref(0);

  const provider = computed(() => (activeProvider.value ? providers[activeProvider.value] : null));
  const options = computed(() => provider.value?.options.value || []);
  const loading = computed(() => !!provider.value?.loading?.value);
  const emptyText = computed(() => provider.value?.emptyText?.value || '');
  const title = computed(() => provider.value?.title?.value || '');
  const visible = computed(() => !!provider.value && (options.value.length > 0 || loading.value || !!emptyText.value));
  const activeIndex = computed(() => clampIndex(rawIndex.value, options.value.length));

  const resolveIndex = (initial: ComposerSuggestInitialIndex) => {
    const length = options.value.length;
    if (initial === 'last') return Math.max(length - 1, 0);
    if (initial === 'first') return 0;
    return clampIndex(initial, length);
  };

  /** 激活某个来源（替换当前活动来源）。调用前应先更新该来源的候选。 */
  const open = (id: K, initial: ComposerSuggestInitialIndex = 'first') => {
    activeProvider.value = id;
    rawIndex.value = resolveIndex(initial);
  };

  /** 关闭浮层；传入来源时只在它处于活动状态时关闭。 */
  const close = (id?: K) => {
    if (id && activeProvider.value !== id) return;
    activeProvider.value = null;
    rawIndex.value = 0;
  };

  const select = (option: ComposerSuggestOption) => {
    const current = provider.value;
    if (!current) return;
    close();
    current.apply(option);
  };

  const hover = (index: number) => {
    rawIndex.value = clampIndex(index, options.value.length);
  };

  /** 返回 true 表示按键已被候选浮层消费。 */
  const handleKeydown = (event: KeyboardEvent): boolean => {
    if (!visible.value) return false;
    if (event.key === 'Escape') {
      const current = provider.value;
      close();
      current?.dismiss?.();
      event.preventDefault();
      return true;
    }
    const list = options.value;
    if (!list.length) return false;
    if (event.key === 'ArrowDown') {
      rawIndex.value = Math.min(activeIndex.value + 1, list.length - 1);
      event.preventDefault();
      return true;
    }
    if (event.key === 'ArrowUp') {
      rawIndex.value = Math.max(activeIndex.value - 1, 0);
      event.preventDefault();
      return true;
    }
    if (event.key === 'Enter' && !event.isComposing) {
      const selected = list[activeIndex.value];
      if (selected) {
        select(selected);
        event.preventDefault();
        return true;
      }
    }
    return false;
  };

  return {
    activeProvider,
    options,
    loading,
    emptyText,
    title,
    visible,
    activeIndex,
    open,
    close,
    select,
    hover,
    handleKeydown,
  };
};
