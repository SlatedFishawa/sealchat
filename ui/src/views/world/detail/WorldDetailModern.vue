<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useDialog, useMessage } from 'naive-ui';
import { Bell, DoorExit, History, Settings, Share, Users } from '@vicons/tabler';
import { useChatStore } from '@/stores/chat';
import WorldManager from '../WorldManager.vue';
import WorldMemberManager from '../WorldMemberManager.vue';
import EmailNotificationManager from '@/views/split/components/EmailNotificationManager.vue';
import { getInviteStatusInfo, pickLatestInviteByRole } from '../worldInviteStatus';
import WorldDetailHero from './WorldDetailHero.vue';
import WorldDetailAccessPanel from './WorldDetailAccessPanel.vue';

const props = defineProps<{ worldId: string }>();
const emit = defineEmits<{ (e: 'switch-variant'): void }>();

const chat = useChatStore();
const router = useRouter();
const message = useMessage();
const dialog = useDialog();

type SectionKey = 'overview' | 'access' | 'notify' | 'manage' | 'more';

const detail = ref<any>(null);
const loading = ref(false);
const loadFailed = ref(false);
const entering = ref(false);
const joining = ref(false);
const activeSection = ref<SectionKey>('overview');
const worldManagerVisible = ref(false);
const memberManagerVisible = ref(false);
const inviteMap = ref<Record<string, any>>({});

// Every async result is dropped unless it still belongs to the latest load of the current world.
let loadSeq = 0;
let inviteSeq = 0;

const world = computed(() => detail.value?.world || null);
const isMember = computed(() => !!detail.value?.isMember);
const memberRole = computed(() => detail.value?.memberRole || '');
const roleLabel = computed(() => {
  switch (memberRole.value) {
    case 'owner':
      return '拥有者';
    case 'admin':
      return '管理员';
    case 'spectator':
      return '旁观者';
    case 'member':
      return '成员';
    default:
      return '';
  }
});
const canManageWorld = computed(() => memberRole.value === 'owner' || memberRole.value === 'admin');
const canLeaveWorld = computed(() => isMember.value && memberRole.value !== 'owner');
const isSpectator = computed(() => memberRole.value === 'spectator');
const memberCount = computed(() => Number(detail.value?.memberCount) || 0);
const ownerName = computed(() => String(detail.value?.ownerNickname || ''));
const admins = computed<Array<{ userId: string; displayName: string; role: string }>>(() =>
  Array.isArray(detail.value?.admins) ? detail.value.admins : [],
);

const sections = computed(() => {
  const items: Array<{ key: SectionKey; label: string }> = [{ key: 'overview', label: '概览' }];
  if (canManageWorld.value) {
    items.push(
      { key: 'access', label: '访问与共享' },
      { key: 'notify', label: '通知' },
      { key: 'manage', label: '管理' },
    );
  }
  items.push({ key: 'more', label: '更多' });
  return items;
});

watch(sections, (items) => {
  if (!items.some((item) => item.key === activeSection.value)) {
    activeSection.value = 'overview';
  }
});

const inviteSummary = computed(() => [
  { role: 'member', title: '成员邀请', status: getInviteStatusInfo(inviteMap.value.member) },
  { role: 'spectator', title: '旁观邀请', status: getInviteStatusInfo(inviteMap.value.spectator) },
]);

const loadInviteSummary = async () => {
  const id = props.worldId;
  const seq = ++inviteSeq;
  if (!id || !canManageWorld.value) {
    inviteMap.value = {};
    return;
  }
  try {
    const resp = await chat.loadWorldSections(id, ['invites']);
    if (seq !== inviteSeq || id !== props.worldId) return;
    inviteMap.value = pickLatestInviteByRole(resp?.invites);
  } catch {
    // Summary only: the access section shows its own load error.
  }
};

const loadDetail = async () => {
  const id = props.worldId;
  const seq = ++loadSeq;
  if (!id) {
    detail.value = null;
    return;
  }
  loading.value = true;
  try {
    // force: the cached entry can lose membership fields after a settings save.
    const next = await chat.worldDetail(id, { force: true });
    if (seq !== loadSeq) return;
    detail.value = next;
    loadFailed.value = !next?.world;
  } catch (error: any) {
    if (seq !== loadSeq) return;
    detail.value = null;
    loadFailed.value = true;
    message.error(error?.response?.data?.message || '加载世界失败');
  } finally {
    if (seq === loadSeq) {
      loading.value = false;
    }
  }
  if (seq === loadSeq) {
    void loadInviteSummary();
  }
};

watch(() => props.worldId, () => {
  detail.value = null;
  loadFailed.value = false;
  inviteMap.value = {};
  activeSection.value = 'overview';
  worldManagerVisible.value = false;
  memberManagerVisible.value = false;
  void loadDetail();
}, { immediate: true });

const selectSection = (key: SectionKey) => {
  activeSection.value = key;
  if (key === 'overview') {
    // Invites may have been created in the access section.
    void loadInviteSummary();
  }
};

// Settings may rename the world or change its cover; refresh on close unless it was deleted.
let deletedWorldId = '';
watch(worldManagerVisible, (visible, wasVisible) => {
  if (!visible && wasVisible && deletedWorldId !== props.worldId) {
    void loadDetail();
  }
});
watch(memberManagerVisible, (visible, wasVisible) => {
  if (!visible && wasVisible) {
    void loadDetail();
  }
});

const goWorldLobby = () => {
  router.push({ name: 'world-lobby' });
};

const handleWorldDeleted = () => {
  deletedWorldId = props.worldId;
  goWorldLobby();
};

const enterWorld = async () => {
  const id = props.worldId;
  if (!id || entering.value) return;
  entering.value = true;
  try {
    await chat.switchWorld(id, { force: true });
    if (id !== props.worldId) return;
    router.push({ name: 'home' });
  } catch (error: any) {
    message.error(error?.response?.data?.message || '进入世界失败');
  } finally {
    entering.value = false;
  }
};

const joinWorld = async () => {
  const id = props.worldId;
  if (!id || joining.value) return;
  joining.value = true;
  try {
    await chat.joinWorld(id);
    message.success('加入成功');
    if (id === props.worldId) {
      await loadDetail();
    }
  } catch (error: any) {
    message.error(error?.response?.data?.message || '加入失败');
  } finally {
    joining.value = false;
  }
};

const handleLeaveWorld = () => {
  if (!canLeaveWorld.value) {
    if (memberRole.value === 'owner') {
      message.warning('世界拥有者无法退出，请先转移所有权');
    }
    return;
  }
  const id = props.worldId;
  dialog.warning({
    title: '退出世界',
    content: '确定要退出该世界吗？退出后需要重新邀请才能加入。',
    positiveText: '确认退出',
    negativeText: '取消',
    maskClosable: false,
    onPositiveClick: async () => {
      try {
        await chat.leaveWorld(id);
        message.success('已退出世界');
        router.push({ name: 'world-lobby' });
      } catch (error: any) {
        message.error(error?.response?.data?.message || '退出失败');
      }
    },
  });
};
</script>

<template>
  <div class="world-console">
    <div class="world-console__inner">
      <template v-if="world">
        <WorldDetailHero
          :world="world"
          :role-label="roleLabel"
          :member-role="memberRole"
          :member-count="memberCount"
          :owner-name="ownerName"
          :is-member="isMember"
          :is-spectator="isSpectator"
          :can-manage="canManageWorld"
          :entering="entering"
          :joining="joining"
          @back="goWorldLobby"
          @enter="enterWorld"
          @join="joinWorld"
          @open-settings="worldManagerVisible = true"
          @open-members="memberManagerVisible = true"
          @open-invites="selectSection('access')"
          @switch-variant="emit('switch-variant')"
        >
          <template #nav>
            <nav class="world-console-nav" aria-label="世界功能">
              <n-tabs :value="activeSection" type="line" size="medium" @update:value="selectSection">
                <n-tab v-for="item in sections" :key="item.key" :name="item.key">{{ item.label }}</n-tab>
              </n-tabs>
            </nav>
          </template>
        </WorldDetailHero>

        <div v-if="activeSection === 'overview'" class="world-console-grid">
          <section class="world-console-panel world-console-card">
            <header class="world-console-card__head">
              <n-icon size="18"><Users /></n-icon>
              <h2 class="world-console-section-title">成员与身份</h2>
            </header>
            <dl class="world-console-facts">
              <div>
                <dt>成员数</dt>
                <dd>{{ memberCount }}</dd>
              </div>
              <div>
                <dt>我的身份</dt>
                <dd>{{ roleLabel || '未加入' }}</dd>
              </div>
            </dl>
            <div v-if="admins.length" class="world-console-card__block">
              <div class="world-console-card__label">管理团队</div>
              <div class="world-console-chips">
                <n-tag
                  v-for="admin in admins.slice(0, 8)"
                  :key="admin.userId"
                  size="small"
                  :bordered="false"
                  :type="admin.role === 'owner' ? 'warning' : 'default'"
                >
                  {{ admin.displayName }}
                </n-tag>
                <span v-if="admins.length > 8" class="world-console-muted">等 {{ admins.length }} 人</span>
              </div>
            </div>
            <footer v-if="canManageWorld" class="world-console-card__foot">
              <n-button size="small" secondary @click="memberManagerVisible = true">成员管理</n-button>
            </footer>
          </section>

          <section v-if="canManageWorld" class="world-console-panel world-console-card">
            <header class="world-console-card__head">
              <n-icon size="18"><Share /></n-icon>
              <h2 class="world-console-section-title">访问与共享</h2>
            </header>
            <ul class="world-console-status-list">
              <li v-for="item in inviteSummary" :key="item.role">
                <span>{{ item.title }}</span>
                <n-tag size="small" :bordered="false" :type="item.status.tagType">{{ item.status.text }}</n-tag>
              </li>
            </ul>
            <p class="world-console-section-desc">OB 旁观链接与 AI Agent 访问链接也在此处配置。</p>
            <footer class="world-console-card__foot">
              <n-button size="small" secondary @click="selectSection('access')">管理访问与共享</n-button>
            </footer>
          </section>

          <section v-if="canManageWorld" class="world-console-panel world-console-card">
            <header class="world-console-card__head">
              <n-icon size="18"><Bell /></n-icon>
              <h2 class="world-console-section-title">世界未读提醒</h2>
            </header>
            <p class="world-console-section-desc">按时间窗口汇总低活跃时段的未读消息，并通过邮件或 Webhook 推送摘要。</p>
            <footer class="world-console-card__foot">
              <n-button size="small" secondary @click="selectSection('notify')">配置提醒</n-button>
            </footer>
          </section>

          <section v-if="canManageWorld" class="world-console-panel world-console-card">
            <header class="world-console-card__head">
              <n-icon size="18"><Settings /></n-icon>
              <h2 class="world-console-section-title">基础设置</h2>
            </header>
            <p class="world-console-section-desc">名称、简介、封面、可见性、成员权限、默认掷骰与鼠标样式。</p>
            <footer class="world-console-card__foot">
              <n-button size="small" secondary @click="worldManagerVisible = true">打开设置</n-button>
            </footer>
          </section>
        </div>

        <WorldDetailAccessPanel
          v-else-if="activeSection === 'access' && canManageWorld"
          :world-id="worldId"
          :can-manage="canManageWorld"
        />

        <section v-else-if="activeSection === 'notify' && canManageWorld" class="world-console-panel world-console-embed">
          <EmailNotificationManager :key="worldId" scope-type="world" :scope-id="worldId" presentation="sections" />
        </section>

        <section v-else-if="activeSection === 'manage' && canManageWorld" class="world-console-panel">
          <header class="world-console-section-head">
            <h2 class="world-console-section-title">世界管理</h2>
            <p class="world-console-section-desc">详细配置在弹窗中完成；删除世界位于基础设置内。</p>
          </header>
          <div class="world-console-list">
            <div class="world-console-row">
              <n-icon class="world-console-row__icon" size="20"><Settings /></n-icon>
              <div class="world-console-row__text">
                <div class="world-console-row__title">基础设置</div>
                <div class="world-console-row__desc">名称、简介、封面、可见性、成员权限、默认掷骰与鼠标样式。</div>
              </div>
              <n-button size="small" secondary @click="worldManagerVisible = true">打开</n-button>
            </div>
            <div class="world-console-row">
              <n-icon class="world-console-row__icon" size="20"><Users /></n-icon>
              <div class="world-console-row__text">
                <div class="world-console-row__title">成员管理</div>
                <div class="world-console-row__desc">调整成员身份（管理员 / 成员 / 旁观者）或移除成员。</div>
              </div>
              <n-button size="small" secondary @click="memberManagerVisible = true">打开</n-button>
            </div>
          </div>
        </section>

        <section v-else-if="activeSection === 'more'" class="world-console-panel">
          <header class="world-console-section-head">
            <h2 class="world-console-section-title">更多</h2>
          </header>
          <div class="world-console-list">
            <div class="world-console-row">
              <n-icon class="world-console-row__icon" size="20"><History /></n-icon>
              <div class="world-console-row__text">
                <div class="world-console-row__title">界面版本</div>
                <div class="world-console-row__desc">当前为新版界面。切换偏好只保存在本浏览器，可随时返回。</div>
              </div>
              <n-button size="small" secondary @click="emit('switch-variant')">回到旧版</n-button>
            </div>
            <div v-if="isMember" class="world-console-row world-console-row--danger">
              <n-icon class="world-console-row__icon" size="20"><DoorExit /></n-icon>
              <div class="world-console-row__text">
                <div class="world-console-row__title">退出世界</div>
                <div class="world-console-row__desc">
                  {{ canLeaveWorld ? '退出后需要重新邀请才能加入。' : '世界拥有者无法退出，请先转移所有权。' }}
                </div>
              </div>
              <n-button v-if="canLeaveWorld" size="small" type="error" secondary @click="handleLeaveWorld">
                退出世界
              </n-button>
            </div>
          </div>
        </section>
      </template>

      <div v-else-if="loading" class="world-console-state">
        <n-spin size="medium" />
      </div>

      <div v-else-if="loadFailed || !worldId" class="world-console-panel world-console-state">
        <n-empty description="世界不存在或无权访问">
          <template #extra>
            <n-button size="small" @click="goWorldLobby">返回世界大厅</n-button>
          </template>
        </n-empty>
      </div>
    </div>

    <WorldManager
      v-if="canManageWorld"
      :world-id="worldId"
      v-model:visible="worldManagerVisible"
      @deleted="handleWorldDeleted"
    />
    <WorldMemberManager v-if="canManageWorld" :world-id="worldId" v-model:visible="memberManagerVisible" />
  </div>
</template>

<style src="./worldConsole.css"></style>

<style scoped>
.world-console {
  height: 100%;
  overflow-y: auto;
  color: var(--sc-text-primary);
  scrollbar-width: thin;
  scrollbar-color: var(--sc-scrollbar-thumb) transparent;
}

.world-console::-webkit-scrollbar {
  width: var(--sc-scrollbar-size, 6px);
}

.world-console::-webkit-scrollbar-track {
  background: transparent;
}

.world-console::-webkit-scrollbar-thumb {
  background-color: var(--sc-scrollbar-thumb);
  border-radius: 3px;
}

.world-console__inner {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 1120px;
  margin: 0 auto;
  padding: 20px 24px 32px;
}

.world-console-nav {
  padding: 0 20px;
  border-top: 1px solid var(--sc-border-mute);
}

.world-console-nav :deep(.n-tabs-nav) {
  margin-bottom: -1px;
}

.world-console-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 16px;
}

.world-console-embed {
  padding: 2px 20px 4px;
}

.world-console-state {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 240px;
  padding: 24px;
}

@media (max-width: 640px) {
  .world-console__inner {
    gap: 12px;
    padding: 12px 12px 24px;
  }

  .world-console-nav {
    padding: 0 6px;
  }

  .world-console-embed {
    padding: 0 14px 2px;
  }

  .world-console-grid {
    grid-template-columns: minmax(0, 1fr);
    gap: 12px;
  }
}
</style>
