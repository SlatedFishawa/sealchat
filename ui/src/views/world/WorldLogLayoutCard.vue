<script setup lang="ts">
// 世界管理入口：LOG 排版与发布。启用开关、设计/展示两个入口名（slug）、随机分配、复制链接。
// slug 唯一性以服务端为准；冲突时保留用户输入。设计 slug 不是编辑密码，服务端每次重新判定权限。
import { computed, ref, watch } from 'vue';
import { useDialog, useMessage } from 'naive-ui';
import { useRouter } from 'vue-router';
import { describeLogError, fetchWorldLogProject, isLogError, updateWorldLogProject } from '@/services/log/logApi';
import type { LogProjectContext } from '@/types/log';

const props = defineProps<{ worldId: string; canManage: boolean }>();

const toast = useMessage();
const dialog = useDialog();
const router = useRouter();
const SLUG = /^[a-z0-9]{4,64}$/;

const loading = ref(false);
const saving = ref(false);
const error = ref('');
const ctx = ref<LogProjectContext | null>(null);
const layoutInput = ref('');
const viewInput = ref('');

const load = async () => {
  if (!props.canManage) return;
  loading.value = true;
  error.value = '';
  try {
    ctx.value = await fetchWorldLogProject(props.worldId);
    layoutInput.value = ctx.value?.management?.layoutSlug || '';
    viewInput.value = ctx.value?.management?.viewSlug || '';
  } catch (err) {
    error.value = describeLogError(err, '读取失败');
  } finally {
    loading.value = false;
  }
};
watch(() => props.worldId, () => void load(), { immediate: true });

const base = `${location.origin}${location.pathname}#`;
const layoutUrl = computed(() => (ctx.value?.management?.layoutSlug ? `${base}/log/layout/${ctx.value.management.layoutSlug}` : ''));
const viewUrl = computed(() => (ctx.value?.management?.viewSlug ? `${base}/log/views/${ctx.value.management.viewSlug}` : ''));
const slugHint = (v: string) => (v && !SLUG.test(v) ? '只能使用 4～64 位小写字母或数字' : '');

const save = async (patch: { enabled?: boolean; layoutSlug?: string; viewSlug?: string }) => {
  saving.value = true;
  error.value = '';
  try {
    const next = await updateWorldLogProject(props.worldId, {
      expectedVersion: ctx.value ? ctx.value.draftVersion : null,
      enabled: patch.enabled ?? ctx.value?.enabled ?? true,
      ...(patch.layoutSlug !== undefined ? { layoutSlug: patch.layoutSlug } : {}),
      ...(patch.viewSlug !== undefined ? { viewSlug: patch.viewSlug } : {}),
    });
    ctx.value = next;
    if (patch.layoutSlug !== undefined || !layoutInput.value) layoutInput.value = next.management?.layoutSlug || '';
    if (patch.viewSlug !== undefined || !viewInput.value) viewInput.value = next.management?.viewSlug || '';
    toast.success('已保存');
  } catch (err) {
    if (isLogError(err, 'SLUG_TAKEN')) error.value = '该入口名已被占用，请换一个';
    else if (isLogError(err, 'VERSION_CONFLICT')) {
      error.value = '排版工程已在别处更新，已刷新状态，请再提交一次';
      const keepLayout = layoutInput.value;
      const keepView = viewInput.value;
      await load();
      layoutInput.value = keepLayout;
      viewInput.value = keepView;
    } else error.value = describeLogError(err, '保存失败');
  } finally {
    saving.value = false;
  }
};

const setEnabled = (enabled: boolean) => void save({ enabled });
const saveLayout = (random = false) => {
  if (!random && !SLUG.test(layoutInput.value)) return;
  void save({ layoutSlug: random ? '' : layoutInput.value });
};
const saveView = (random = false) => {
  if (!random && !SLUG.test(viewInput.value)) return;
  const run = () => void save({ viewSlug: random ? '' : viewInput.value });
  if (!ctx.value?.management?.viewSlug) return run();
  dialog.warning({
    title: '更换展示链接',
    content: '更换后旧的展示链接立即失效，已分享出去的地址将无法访问。确定更换？',
    positiveText: '更换',
    negativeText: '取消',
    onPositiveClick: run,
  });
};

const copy = async (text: string) => {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast.success('已复制');
  } catch {
    toast.info(text);
  }
};

const enterDesign = () => {
  const slug = ctx.value?.management?.layoutSlug;
  if (slug) void router.push({ name: 'log-layout', params: { slug } });
};
</script>

<template>
  <div class="log-card">
    <p class="log-card__desc">
      把本世界的跑团记录排版成可打印、可公开阅读的 LOG。设计链接给参与排版的人（仍需登录且有权限），展示链接可匿名阅读已发布版本。
    </p>
    <n-alert v-if="!canManage" type="info" :show-icon="false">仅世界管理者可以配置。</n-alert>
    <n-spin v-else :show="loading">
      <n-alert v-if="error" type="error" :show-icon="false" class="log-card__err">{{ error }}</n-alert>
      <template v-if="!ctx">
        <n-button type="primary" :loading="saving" @click="setEnabled(true)">启用 LOG 排版器</n-button>
      </template>
      <template v-else>
        <div class="log-card__row">
          <span class="log-card__label">启用</span>
          <n-switch :value="ctx.enabled" :loading="saving" @update:value="setEnabled" />
          <n-tag size="small" :type="ctx.publishedReleaseId ? 'success' : 'default'">{{ ctx.publishedReleaseId ? '已发布' : '未发布' }}</n-tag>
        </div>

        <div class="log-card__field">
          <div class="log-card__label">设计链接</div>
          <n-input-group>
            <n-input-group-label>/log/layout/</n-input-group-label>
            <n-input v-model:value="layoutInput" maxlength="64" :status="slugHint(layoutInput) ? 'error' : undefined" aria-label="设计入口名" />
            <n-button :disabled="saving || !SLUG.test(layoutInput) || layoutInput === ctx.management?.layoutSlug" @click="saveLayout()">保存</n-button>
            <n-button :disabled="saving" @click="saveLayout(true)">随机</n-button>
          </n-input-group>
          <div class="log-card__hint">{{ slugHint(layoutInput) || '设计链接不是密码：进入后仍按世界权限判断能否编辑。' }}</div>
          <n-space size="small">
            <n-button size="small" :disabled="!layoutUrl" @click="copy(layoutUrl)">复制设计链接</n-button>
            <n-button size="small" type="primary" secondary :disabled="!ctx.enabled || !layoutUrl" @click="enterDesign">进入设计</n-button>
          </n-space>
        </div>

        <div class="log-card__field">
          <div class="log-card__label">展示链接</div>
          <n-input-group>
            <n-input-group-label>/log/views/</n-input-group-label>
            <n-input v-model:value="viewInput" maxlength="64" :status="slugHint(viewInput) ? 'error' : undefined" aria-label="展示入口名" />
            <n-button :disabled="saving || !SLUG.test(viewInput) || viewInput === ctx.management?.viewSlug" @click="saveView()">保存</n-button>
            <n-button :disabled="saving" @click="saveView(true)">随机</n-button>
          </n-input-group>
          <div class="log-card__hint">{{ slugHint(viewInput) || '更换展示链接会使旧链接失效。' }}</div>
          <n-space size="small">
            <n-button size="small" :disabled="!viewUrl" @click="copy(viewUrl)">复制展示链接</n-button>
            <n-button size="small" tag="a" :href="viewUrl || undefined" target="_blank" rel="noopener noreferrer" :disabled="!viewUrl || !ctx.publishedReleaseId">查看发布</n-button>
          </n-space>
        </div>
      </template>
    </n-spin>
  </div>
</template>

<style scoped>
.log-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.log-card__desc,
.log-card__hint {
  font-size: 12px;
  color: var(--sc-text-secondary, #666);
  margin: 0;
}

.log-card__hint {
  margin: 4px 0 6px;
}

.log-card__row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}

.log-card__field {
  margin-bottom: 14px;
}

.log-card__label {
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 4px;
}

.log-card__err {
  margin-bottom: 8px;
}
</style>
