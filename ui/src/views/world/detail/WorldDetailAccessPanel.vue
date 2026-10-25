<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Book, Eye, Robot } from '@vicons/tabler';
import WorldInviteList from '../WorldInviteList.vue';
import WorldObserverLinkCard from '../WorldObserverLinkCard.vue';
import WorldAgentAccessLinkCard from '../WorldAgentAccessLinkCard.vue';
import WorldLogLayoutCard from '../WorldLogLayoutCard.vue';

type AccessDrawerKind = 'observer' | 'agent' | 'log';

// Only owner/admin reach this section; the embedded cards and the backend still enforce it.
const props = defineProps<{
  worldId: string;
  canManage: boolean;
  openKind?: AccessDrawerKind | null;
}>();

const drawerVisible = ref(false);
const drawerKind = ref<AccessDrawerKind>('observer');
const drawerTitle = computed(() => ({ observer: 'OB 旁观链接', agent: 'AI Agent 访问链接', log: 'LOG 排版与发布' }[drawerKind.value]));

const openDrawer = (kind: AccessDrawerKind) => {
  drawerKind.value = kind;
  drawerVisible.value = true;
};

watch(() => props.openKind, (kind) => {
  if (kind && props.canManage) {
    openDrawer(kind);
  }
}, { immediate: true });

watch(() => props.worldId, () => {
  drawerVisible.value = false;
});

const externalEntries: Array<{ kind: AccessDrawerKind; title: string; desc: string; icon: typeof Eye }> = [
  {
    kind: 'observer',
    title: 'OB 旁观链接',
    desc: '外部用户可免登录进入旁观模式，并可生成可抓取的频道打印链接。',
    icon: Eye,
  },
  {
    kind: 'agent',
    title: 'AI Agent 访问链接',
    desc: '为外部 Agent 生成只读访问令牌，用于读取频道消息与计数。',
    icon: Robot,
  },
  {
    kind: 'log',
    title: 'LOG 排版与发布',
    desc: '把跑团记录排版成书页，发布为可匿名阅读的固定版本；管理设计与展示链接。',
    icon: Book,
  },
];
</script>

<template>
  <div class="world-access">
    <section class="world-console-panel world-access__invites">
      <WorldInviteList :key="worldId" :world-id="worldId" />
    </section>

    <section class="world-console-panel">
      <header class="world-console-section-head">
        <h2 class="world-console-section-title">外部访问</h2>
        <p class="world-console-section-desc">面向未登录旁观者与外部 AI Agent 的链接，详细配置在侧边面板中完成。</p>
      </header>
      <div class="world-console-list">
        <div v-for="entry in externalEntries" :key="entry.kind" class="world-console-row">
          <n-icon class="world-console-row__icon" size="20"><component :is="entry.icon" /></n-icon>
          <div class="world-console-row__text">
            <div class="world-console-row__title">{{ entry.title }}</div>
            <div class="world-console-row__desc">{{ entry.desc }}</div>
          </div>
          <n-button v-if="canManage" size="small" secondary @click="openDrawer(entry.kind)">配置</n-button>
          <span v-else class="world-console-row__hint">仅管理员可配置</span>
        </div>
      </div>
    </section>

    <n-drawer v-model:show="drawerVisible" width="min(560px, 100vw)" placement="right">
      <n-drawer-content :title="drawerTitle" closable :native-scrollbar="false">
        <WorldObserverLinkCard v-if="drawerKind === 'observer'" :world-id="worldId" :can-manage="canManage" />
        <WorldAgentAccessLinkCard v-else-if="drawerKind === 'agent'" :world-id="worldId" :can-manage="canManage" />
        <WorldLogLayoutCard v-else :world-id="worldId" :can-manage="canManage" />
      </n-drawer-content>
    </n-drawer>
  </div>
</template>

<style scoped>
.world-access {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* WorldInviteList exposes these hooks for its inner cards; feed them global semantic tokens. */
.world-access__invites {
  --sc-invite-surface: color-mix(in srgb, var(--sc-text-primary) 3%, transparent);
  --sc-invite-border: var(--sc-border-mute);
  --sc-invite-muted: var(--sc-text-secondary);
  --sc-invite-text: var(--sc-text-primary);
  padding: 16px 20px 20px;
  color: var(--sc-text-primary);
}

@media (max-width: 640px) {
  .world-access__invites {
    padding: 12px 14px 14px;
  }
}
</style>
