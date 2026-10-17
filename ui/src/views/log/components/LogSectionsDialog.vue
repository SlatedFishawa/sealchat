<script setup lang="ts">
// 章节与来源：管理者可增删章节、改来源频道/时间范围/OOC/归档/角色筛选；成员只读来源，可改章节标题与顺序。
import { computed, ref, watch } from 'vue';
import { useDialog } from 'naive-ui';
import { describeLogError, fetchChannelIdentitiesForLog, type LogIdentityOption } from '@/services/log/logApi';
import { listWorldChannels, type LogWorldChannel } from '@/services/log/logMessageCommands';
import type { LogDraft, LogSection } from '@/types/log';
import { newSection } from '../logDraftOps';

const props = defineProps<{
  show: boolean;
  draft: LogDraft;
  update: (mutate: (d: LogDraft) => void) => boolean;
  worldId: string;
  canManage: boolean;
}>();
const emit = defineEmits<{
  (e: 'update:show', v: boolean): void;
  (e: 'select', id: string): void;
}>();

const dialog = useDialog();
const channels = ref<LogWorldChannel[]>([]);
const channelError = ref('');
const loadingChannels = ref(false);
const identityCache = ref<Record<string, LogIdentityOption[]>>({});
const newChannelId = ref<string | null>(null);

const sections = computed(() => props.draft.sections.slice().sort((a, b) => a.order - b.order));
const channelName = (id: string) => channels.value.find((c) => c.id === id)?.name || id;
const channelOptions = computed(() => channels.value.map((c) => ({ label: c.name, value: c.id })));

watch(() => props.show, async (open) => {
  if (!open || channels.value.length || loadingChannels.value) return;
  loadingChannels.value = true;
  channelError.value = '';
  try {
    channels.value = await listWorldChannels(props.worldId);
  } catch (error) {
    channelError.value = describeLogError(error, '读取频道失败');
  } finally {
    loadingChannels.value = false;
  }
  for (const s of sections.value) void loadIdentities(s.source.channelId);
});

const loadIdentities = async (channelId: string) => {
  if (!channelId || identityCache.value[channelId]) return;
  try {
    const res = await fetchChannelIdentitiesForLog(channelId);
    identityCache.value = { ...identityCache.value, [channelId]: res.identities };
  } catch {
    identityCache.value = { ...identityCache.value, [channelId]: [] };
  }
};

const identityOptions = (s: LogSection) => {
  const known = identityCache.value[s.source.channelId] || [];
  const opts = known.map((i) => ({ label: i.displayName || i.id, value: i.id }));
  for (const id of s.source.identityIds) if (!opts.some((o) => o.value === id)) opts.push({ label: id, value: id });
  return opts;
};

const mutateSection = (id: string, fn: (s: LogSection) => void) => props.update((d) => {
  const s = d.sections.find((x) => x.id === id);
  if (s) fn(s);
});

const toMs = (iso: string | null) => (iso ? Date.parse(iso) : null);
const fromMs = (ms: number | null) => (ms === null || !Number.isFinite(ms) ? null : new Date(ms).toISOString());

const addSection = () => {
  if (!newChannelId.value) return;
  const ch = newChannelId.value;
  let created = '';
  props.update((d) => {
    const order = d.sections.reduce((m, s) => Math.max(m, s.order), -1) + 1;
    const s = newSection(ch, channelName(ch), order);
    d.sections.push(s);
    created = s.id;
  });
  newChannelId.value = null;
  void loadIdentities(ch);
  if (created) emit('select', created);
};

const removeSection = (s: LogSection) => {
  const count = props.draft.elements.filter((e) => e.anchor.sectionId === s.id).length;
  dialog.warning({
    title: '删除章节',
    content: `删除章节“${s.title}”只影响 LOG，不会删除聊天消息${count ? `；章节内的 ${count} 个 LOG 元素会一并删除` : ''}。`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: () => {
      props.update((d) => {
        d.sections = d.sections.filter((x) => x.id !== s.id);
        d.elements = d.elements.filter((e) => e.anchor.sectionId !== s.id);
      });
    },
  });
};

const moveSection = (s: LogSection, dir: -1 | 1) => {
  const list = sections.value;
  const i = list.findIndex((x) => x.id === s.id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  const a = list[i].id;
  const b = list[j].id;
  props.update((d) => {
    const sa = d.sections.find((x) => x.id === a);
    const sb = d.sections.find((x) => x.id === b);
    if (!sa || !sb) return;
    const t = sa.order;
    sa.order = sb.order;
    sb.order = t;
    if (sa.order === sb.order) sb.order += dir;
  });
};

const formatTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '最早');
</script>

<template>
  <n-modal :show="show" preset="card" :title="canManage ? '章节与来源' : '章节与来源（只读来源）'" style="width: min(720px, 96vw)" @update:show="(v: boolean) => emit('update:show', v)">
    <n-alert v-if="channelError" type="error" :show-icon="false">{{ channelError }}</n-alert>
    <p class="log-sec__hint">
      时间范围只决定哪些消息属于本章，显示顺序仍以聊天中的消息顺序为准。
      {{ canManage ? '来源修改保存后，预览会按新范围重新加载。' : '只有世界管理者可以修改来源范围；你可以修改章节标题和顺序。' }}
    </p>
    <n-empty v-if="!sections.length" description="尚无章节" />
    <div v-for="(s, i) in sections" :key="s.id" class="log-sec__item">
      <div class="log-sec__row">
        <n-input
          :value="s.title"
          size="small"
          maxlength="200"
          placeholder="章节标题"
          :aria-label="`第 ${i + 1} 章标题`"
          @update:value="(v: string) => mutateSection(s.id, (x) => (x.title = v))"
        />
        <n-button size="small" :disabled="i === 0" @click="moveSection(s, -1)">上移</n-button>
        <n-button size="small" :disabled="i === sections.length - 1" @click="moveSection(s, 1)">下移</n-button>
        <n-button size="small" @click="emit('select', s.id); emit('update:show', false)">打开</n-button>
        <n-button v-if="canManage" size="small" type="error" secondary @click="removeSection(s)">删除</n-button>
      </div>
      <template v-if="canManage">
        <div class="log-sec__grid">
          <label>来源频道</label>
          <n-select
            :value="s.source.channelId"
            size="small"
            :options="channelOptions"
            :loading="loadingChannels"
            filterable
            @update:value="(v: string) => { mutateSection(s.id, (x) => { x.source.channelId = v; x.source.identityIds = []; }); void loadIdentities(v); }"
          />
          <label>开始时间</label>
          <n-date-picker
            :value="toMs(s.source.fromTime)"
            type="datetime"
            size="small"
            clearable
            placeholder="不限（从最早）"
            @update:value="(v: number | null) => mutateSection(s.id, (x) => (x.source.fromTime = fromMs(v)))"
          />
          <label>结束时间</label>
          <n-date-picker
            :value="toMs(s.source.toTime)"
            type="datetime"
            size="small"
            @update:value="(v: number | null) => v !== null && mutateSection(s.id, (x) => (x.source.toTime = fromMs(v) || x.source.toTime))"
          />
          <label>包含</label>
          <n-space size="small">
            <n-checkbox :checked="s.source.includeOoc" @update:checked="(v: boolean) => mutateSection(s.id, (x) => (x.source.includeOoc = v))">场外 (OOC)</n-checkbox>
            <n-checkbox :checked="s.source.includeArchived" @update:checked="(v: boolean) => mutateSection(s.id, (x) => (x.source.includeArchived = v))">已归档</n-checkbox>
          </n-space>
          <label>只看角色</label>
          <n-select
            :value="s.source.identityIds"
            size="small"
            multiple
            filterable
            clearable
            placeholder="不筛选（全部角色）"
            :options="identityOptions(s)"
            @update:value="(v: string[]) => mutateSection(s.id, (x) => (x.source.identityIds = v.slice(0, 200)))"
          />
        </div>
      </template>
      <div v-else class="log-sec__readonly">
        频道：{{ channelName(s.source.channelId) }} ｜ {{ formatTime(s.source.fromTime) }} — {{ formatTime(s.source.toTime) }}
        ｜ {{ s.source.includeOoc ? '含' : '不含' }} OOC ｜ {{ s.source.includeArchived ? '含' : '不含' }}已归档
        ｜ {{ s.source.identityIds.length ? `只看 ${s.source.identityIds.length} 个角色` : '全部角色' }}
      </div>
    </div>
    <div v-if="canManage" class="log-sec__add">
      <n-select v-model:value="newChannelId" size="small" :options="channelOptions" :loading="loadingChannels" filterable placeholder="选择来源频道（仅公开且可读的频道）" />
      <n-button size="small" type="primary" :disabled="!newChannelId" @click="addSection">添加章节</n-button>
    </div>
  </n-modal>
</template>

<style scoped>
.log-sec__hint {
  font-size: 12px;
  color: var(--sc-text-secondary, #666);
  margin: 0 0 10px;
}

.log-sec__item {
  padding: 10px 0;
  border-bottom: 1px solid var(--sc-border-mute, #eee);
}

.log-sec__row {
  display: flex;
  gap: 6px;
  align-items: center;
}

.log-sec__grid {
  display: grid;
  grid-template-columns: 80px 1fr;
  gap: 6px 10px;
  align-items: center;
  margin-top: 8px;
  font-size: 12px;
}

.log-sec__readonly {
  margin-top: 6px;
  font-size: 12px;
  color: var(--sc-text-secondary, #666);
}

.log-sec__add {
  display: flex;
  gap: 6px;
  margin-top: 12px;
}
</style>
