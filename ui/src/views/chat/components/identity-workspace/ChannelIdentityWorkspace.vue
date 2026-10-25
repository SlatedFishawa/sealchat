<script setup lang="ts">
import { getCurrentInstance } from 'vue';
import AvatarVue from '@/components/avatar.vue';
import type { IdentityWorkspaceAvatar, IdentityWorkspaceBadge, IdentityWorkspaceTab } from './identityWorkspaceTypes';

// 频道角色编辑工作区外壳：负责覆盖层、身份标题、以及「角色资料 / 头像差分」两个同级编辑域的布局。
// 宽度足够时双栏并排；工作区本身较窄（移动端、窄窗口、小剧场内嵌聊天）时由容器查询切换为单列 Tab。
const props = withDefaults(defineProps<{
  show: boolean;
  tab: IdentityWorkspaceTab;
  title: string;
  displayName: string;
  color?: string;
  avatar: IdentityWorkspaceAvatar;
  badges?: IdentityWorkspaceBadge[];
  hint?: string;
  variantCount?: number;
  variantsHidden?: boolean;
  variantDirty?: boolean;
  /** 工作区之外 Teleport 的子浮层（如表情选择器）打开时需放开焦点陷阱，避免抢占其输入框焦点。 */
  trapFocus?: boolean;
}>(), {
  color: '',
  badges: () => [],
  hint: '',
  variantCount: 0,
  variantsHidden: false,
  variantDirty: false,
  trapFocus: true,
});

const emit = defineEmits<{
  (e: 'update:tab', value: IdentityWorkspaceTab): void;
  (e: 'close'): void;
}>();

const workspaceA11yId = `identity-workspace-${getCurrentInstance()?.uid ?? 0}`;
const profileTabId = `${workspaceA11yId}-tab-profile`;
const variantsTabId = `${workspaceA11yId}-tab-variants`;
const profilePanelId = `${workspaceA11yId}-panel-profile`;
const variantsPanelId = `${workspaceA11yId}-panel-variants`;

const handleUpdateShow = (value: boolean) => {
  if (!value) emit('close');
};

const selectTab = (value: IdentityWorkspaceTab) => {
  if (props.tab !== value) emit('update:tab', value);
};
</script>

<template>
  <n-modal
    :show="show"
    :auto-focus="false"
    :trap-focus="trapFocus"
    transform-origin="center"
    @update:show="handleUpdateShow"
  >
    <div
      class="identity-workspace"
      role="dialog"
      aria-modal="true"
      :aria-label="title"
    >
      <header class="identity-workspace__header">
        <div class="identity-workspace__identity">
          <AvatarVue
            class="identity-workspace__avatar"
            :size="40"
            :border="false"
            v-bind="avatar"
          />
          <div class="identity-workspace__identity-text">
            <div class="identity-workspace__eyebrow">
              <span>{{ title }}</span>
              <n-tooltip v-if="hint" trigger="hover">
                <template #trigger>
                  <button type="button" class="identity-workspace__help" aria-label="查看说明">？</button>
                </template>
                {{ hint }}
              </n-tooltip>
            </div>
            <div class="identity-workspace__name-row">
              <span
                class="identity-workspace__name"
                :style="color ? { color } : undefined"
              >{{ displayName || '未命名角色' }}</span>
              <n-tag
                v-for="badge in badges"
                :key="badge.label"
                size="small"
                :bordered="false"
                :type="badge.type"
              >
                {{ badge.label }}
              </n-tag>
            </div>
          </div>
        </div>
        <n-button quaternary circle class="identity-workspace__close" aria-label="关闭" @click="emit('close')">
          <template #icon>
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
            </svg>
          </template>
        </n-button>
      </header>
      <div class="identity-workspace__body">
        <div
          class="identity-workspace__layout"
          :class="[`is-tab-${tab}`, { 'is-single': variantsHidden }]"
        >
          <div v-if="!variantsHidden" class="identity-workspace__tabs" role="tablist" aria-label="编辑内容">
            <button
              :id="profileTabId"
              type="button"
              role="tab"
              class="identity-workspace__tab"
              :class="{ 'is-active': tab === 'profile' }"
              :aria-selected="tab === 'profile'"
              :aria-controls="profilePanelId"
              @click="selectTab('profile')"
            >
              角色资料
            </button>
            <button
              :id="variantsTabId"
              type="button"
              role="tab"
              class="identity-workspace__tab"
              :class="{ 'is-active': tab === 'variants' }"
              :aria-selected="tab === 'variants'"
              :aria-controls="variantsPanelId"
              @click="selectTab('variants')"
            >
              头像差分
              <span class="identity-workspace__tab-count">{{ variantCount }}</span>
              <span v-if="variantDirty" class="identity-workspace__tab-dot" aria-label="有未保存的差分修改" />
            </button>
          </div>
          <section
            :id="profilePanelId"
            class="identity-workspace__pane identity-workspace__pane--profile"
            role="tabpanel"
            :aria-labelledby="variantsHidden ? undefined : profileTabId"
            :aria-label="variantsHidden ? '角色资料' : undefined"
          >
            <slot name="profile" />
          </section>
          <section
            v-if="!variantsHidden"
            :id="variantsPanelId"
            class="identity-workspace__pane identity-workspace__pane--variants"
            role="tabpanel"
            :aria-labelledby="variantsTabId"
          >
            <slot name="variants" />
          </section>
        </div>
      </div>
    </div>
  </n-modal>
</template>

<style scoped>
/* 工作区内共享的局部色彩令牌，全部派生自全局主题变量，夜间与自定义主题自动跟随。 */
.identity-workspace {
  --idws-surface: var(--sc-bg-surface, #ffffff);
  --idws-pane: color-mix(in srgb, var(--sc-bg-layer, #f5f5f7) 55%, var(--sc-bg-surface, #ffffff));
  --idws-card: var(--sc-bg-elevated, #ffffff);
  --idws-border: var(--sc-border-mute, rgba(15, 23, 42, 0.06));
  --idws-border-strong: var(--sc-border-strong, rgba(15, 23, 42, 0.12));
  --idws-text: var(--sc-text-primary, #0f172a);
  --idws-muted: var(--sc-text-secondary, #475569);
  --idws-accent: var(--primary-color, #3388de);
  --idws-accent-soft: color-mix(in srgb, var(--idws-accent) 12%, transparent);
  --idws-radius: 12px;

  display: flex;
  flex-direction: column;
  width: min(1240px, calc(100vw - 48px));
  height: min(880px, calc(100vh - 48px));
  height: min(880px, calc(100dvh - 48px));
  color: var(--idws-text);
  background: var(--idws-surface);
  border: 1px solid var(--idws-border-strong);
  border-radius: 16px;
  box-shadow: 0 18px 48px color-mix(in srgb, #000 16%, transparent);
}

.identity-workspace__header {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.85rem 1rem 0.85rem 1.25rem;
  border-bottom: 1px solid var(--idws-border);
}

.identity-workspace__identity {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  min-width: 0;
}

.identity-workspace__avatar {
  flex-shrink: 0;
}

.identity-workspace__identity-text {
  min-width: 0;
}

.identity-workspace__eyebrow {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.75rem;
  color: var(--idws-muted);
}

.identity-workspace__help {
  width: 1.1rem;
  height: 1.1rem;
  padding: 0;
  border: 1px solid var(--idws-border-strong);
  border-radius: 999px;
  background: transparent;
  color: inherit;
  font-size: 0.7rem;
  line-height: 1;
  cursor: help;
}

.identity-workspace__name-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin-top: 0.1rem;
}

.identity-workspace__name {
  font-size: 1.05rem;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}

.identity-workspace__close {
  flex-shrink: 0;
}

.identity-workspace__body {
  flex: 1 1 auto;
  min-height: 0;
  container-type: inline-size;
  container-name: identity-workspace;
}

.identity-workspace__layout {
  height: 100%;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: auto minmax(0, 1fr);
}

.identity-workspace__layout.is-single {
  grid-template-rows: minmax(0, 1fr);
}

.identity-workspace__tabs {
  display: flex;
  gap: 0.25rem;
  padding: 0.5rem 1rem 0;
  border-bottom: 1px solid var(--idws-border);
}

.identity-workspace__tab {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.5rem 0.85rem 0.6rem;
  border: 0;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  background: transparent;
  color: var(--idws-muted);
  font: inherit;
  font-size: 0.9rem;
  cursor: pointer;
  transition: color 0.15s ease, border-color 0.15s ease;
}

.identity-workspace__tab:hover {
  color: var(--idws-text);
}

.identity-workspace__tab.is-active {
  color: var(--idws-text);
  font-weight: 600;
  border-bottom-color: var(--idws-accent);
}

.identity-workspace__tab:focus-visible {
  outline: 2px solid var(--idws-accent);
  outline-offset: -2px;
  border-radius: 6px 6px 0 0;
}

.identity-workspace__tab-count {
  min-width: 1.25rem;
  padding: 0 0.35rem;
  border-radius: 999px;
  background: var(--sc-chip-bg, rgba(15, 23, 42, 0.04));
  font-size: 0.72rem;
  font-weight: 500;
  line-height: 1.25rem;
  text-align: center;
}

.identity-workspace__tab-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--idws-accent);
}

.identity-workspace__pane {
  display: none;
  min-height: 0;
  min-width: 0;
  flex-direction: column;
}

.identity-workspace__layout.is-tab-profile .identity-workspace__pane--profile,
.identity-workspace__layout.is-tab-variants .identity-workspace__pane--variants,
.identity-workspace__layout.is-single .identity-workspace__pane--profile {
  display: flex;
}

.identity-workspace__pane--profile {
  background: var(--idws-pane);
}

.identity-workspace__layout.is-single .identity-workspace__pane--profile {
  background: transparent;
}

/* 宽工作区：双栏并排，差分区域需要同时容纳列表、详情与规则，因此获得更多空间。 */
@container identity-workspace (min-width: 860px) {
  .identity-workspace__layout:not(.is-single) {
    grid-template-columns: minmax(360px, 5fr) minmax(0, 8fr);
    grid-template-rows: minmax(0, 1fr);
  }

  .identity-workspace__tabs {
    display: none;
  }

  .identity-workspace__layout:not(.is-single) .identity-workspace__pane {
    display: flex;
  }

  .identity-workspace__pane--profile {
    border-right: 1px solid var(--idws-border);
    border-bottom-left-radius: 16px;
  }
}

@container identity-workspace (min-width: 700px) {
  .identity-workspace__layout.is-single .identity-workspace__pane--profile {
    width: 100%;
    max-width: 640px;
    justify-self: center;
  }
}

@media (max-width: 640px) {
  .identity-workspace {
    width: 100vw;
    height: 100vh;
    height: 100dvh;
    border: 0;
    border-radius: 0;
    box-shadow: none;
  }

  .identity-workspace__header {
    padding: 0.6rem 0.5rem 0.6rem 0.85rem;
  }

  .identity-workspace__tabs {
    padding: 0.35rem 0.6rem 0;
  }

  .identity-workspace__tab {
    flex: 1 1 0;
    justify-content: center;
  }
}
</style>
