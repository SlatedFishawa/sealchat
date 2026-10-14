import { computed, ref, type Ref } from 'vue';

/**
 * Local-only "new UI / legacy UI" preference for a page or feature.
 *
 * - Stored per feature under `sealchat.uiVariant.<feature>` with value `modern` | `legacy`.
 * - Nothing is stored until the user picks a variant, so `defaultVariant` keeps applying until then.
 * - Instances of the same feature share one ref, so a shell and its pages stay in sync.
 */
export type UiVariant = 'modern' | 'legacy';

const STORAGE_PREFIX = 'sealchat.uiVariant.';
const FEATURE_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const variantStates = new Map<string, Ref<UiVariant>>();

const isUiVariant = (value: unknown): value is UiVariant => value === 'modern' || value === 'legacy';

const readStoredVariant = (key: string): UiVariant | null => {
  try {
    const raw = window.localStorage.getItem(key);
    return isUiVariant(raw) ? raw : null;
  } catch {
    return null;
  }
};

const writeStoredVariant = (key: string, value: UiVariant) => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage may be unavailable (private mode / blocked); keep the in-memory choice.
  }
};

export function useUiVariant(feature: string, defaultVariant: UiVariant = 'modern') {
  if (!FEATURE_PATTERN.test(feature)) {
    throw new Error(`[useUiVariant] invalid feature key: ${feature}`);
  }
  const key = `${STORAGE_PREFIX}${feature}`;
  let state = variantStates.get(key);
  if (!state) {
    state = ref<UiVariant>(readStoredVariant(key) ?? defaultVariant);
    variantStates.set(key, state);
  }
  const current = state;

  const setVariant = (next: UiVariant) => {
    if (!isUiVariant(next)) return;
    current.value = next;
    writeStoredVariant(key, next);
  };

  return {
    variant: computed(() => current.value),
    isLegacy: computed(() => current.value === 'legacy'),
    setVariant,
  };
}
