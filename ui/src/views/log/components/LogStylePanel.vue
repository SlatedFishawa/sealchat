<script setup lang="ts">
// 样式与模板：内置/私有样式选择、设计变量、规则查看、源码编辑（fork → 校验 → 本地预览 → 保存新版本 → 绑定）、ZIP 导入导出。
// 保存版本与绑定工程是两步：版本保存成功不等于工程已切换。
import { computed, onMounted, ref, shallowRef, watch } from 'vue';
import { useMessage } from 'naive-ui';
import {
  describeLogError,
  exportLogStyleZip,
  fetchLogStylePackage,
  fetchLogStyles,
  forkLogStyle,
  importLogStyleZip,
  isLogError,
  saveLogStyleVersion,
} from '@/services/log/logApi';
import { checkStyleSource } from '@/services/log/logTemplateCompiler';
import { inspectStyleZip, type StyleZipSummary } from '@/services/log/logStyleZip';
import { uploadImageAttachment } from '@/views/chat/composables/useAttachmentUploader';
import type { LogDraft, LogStyleAsset, LogStylePackage, LogStyleRule, LogStyleSummary, LogTokenValue } from '@/types/log';
import { rebindStyle, type StyleBindProblem } from '../logDraftOps';
import { builtinStyleInfo, builtinStyleOrder } from '../logStyleCatalog';
import LogStyleSketch from './LogStyleSketch.vue';

const props = defineProps<{
  draft: LogDraft;
  update: (mutate: (d: LogDraft) => void) => boolean;
  stylePackage: LogStylePackage | null;
  canEdit: boolean;
}>();
const emit = defineEmits<{ (e: 'preview', pkg: LogStylePackage | null): void }>();

const toast = useMessage();
const HEX = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;

// ---- 样式列表 ----
const styles = ref<LogStyleSummary[]>([]);
const stylesCursor = ref<string | null>(null);
const stylesLoading = ref(false);
const stylesError = ref('');
const loadStyles = async (more = false) => {
  stylesLoading.value = true;
  stylesError.value = '';
  try {
    const r = await fetchLogStyles(more ? stylesCursor.value : null, 50);
    styles.value = more ? [...styles.value, ...r.items] : r.items;
    stylesCursor.value = r.nextCursor || null;
  } catch (error) {
    stylesError.value = describeLogError(error, '读取样式列表失败');
  } finally {
    stylesLoading.value = false;
  }
};
onMounted(() => void loadStyles());

const owned = computed(() => !!props.stylePackage && styles.value.some((s) => s.id === props.stylePackage!.id && !s.builtin));
const latestOf = (id: string) => styles.value.find((s) => s.id === id)?.version || '';

// 内置样式按目录顺序展示为卡片；私有样式单独成列表。
const builtinStyles = computed(() => styles.value.filter((s) => s.builtin).slice().sort((a, b) => builtinStyleOrder(a.id) - builtinStyleOrder(b.id)));
const ownStyles = computed(() => styles.value.filter((s) => !s.builtin));
const currentInfo = computed(() => (props.stylePackage ? builtinStyleInfo(props.stylePackage.id) : null));
const currentLatest = computed(() => {
  const pkg = props.stylePackage;
  if (!pkg) return null;
  const s = styles.value.find((x) => x.id === pkg.id);
  return s && s.version !== pkg.version ? s : null;
});
// 已从样式库下线的旧内置样式：仍可读取、复制与导出，但不再出现在列表里。
const currentRetired = computed(() => {
  const pkg = props.stylePackage;
  return !!pkg && !stylesLoading.value && !stylesError.value && !stylesCursor.value && pkg.id.startsWith('sealchat-') && !styles.value.some((s) => s.id === pkg.id);
});
const isCurrent = (s: LogStyleSummary) => props.stylePackage?.id === s.id && props.stylePackage?.version === s.version;
const useLabel = (s: LogStyleSummary) => (isCurrent(s) ? '使用中' : props.stylePackage?.id === s.id ? `更新到 ${s.version}` : '使用');

// ---- 预览与绑定 ----
const previewing = shallowRef<LogStylePackage | null>(null);
const bindProblems = ref<StyleBindProblem[]>([]);
const bindTarget = shallowRef<LogStylePackage | null>(null);

const previewStyle = async (s: LogStyleSummary) => {
  try {
    const pkg = await fetchLogStylePackage(s.id, s.version);
    previewing.value = pkg;
    emit('preview', pkg);
  } catch (error) {
    toast.error(describeLogError(error, '读取样式失败'));
  }
};
const cancelPreview = () => {
  previewing.value = null;
  emit('preview', null);
};

const prepareBind = (pkg: LogStylePackage) => {
  const { problems } = rebindStyle(props.draft, pkg);
  bindTarget.value = pkg;
  bindProblems.value = problems;
  if (!problems.length) confirmBind();
};
const confirmBind = () => {
  const pkg = bindTarget.value;
  if (!pkg) return;
  const { next, problems } = rebindStyle(props.draft, pkg);
  if (problems.some((p) => !p.fixable)) return;
  props.update((d) => {
    Object.assign(d, next);
  });
  bindTarget.value = null;
  bindProblems.value = [];
  previewing.value = null;
  emit('preview', null);
  if (savedUnbound.value && savedUnbound.value.id === pkg.id && savedUnbound.value.version === pkg.version) savedUnbound.value = null;
  toast.success(`已切换到 ${pkg.name} ${pkg.version}（草稿保存后生效）`);
};
const useStyle = async (s: LogStyleSummary) => {
  try {
    const pkg = await fetchLogStylePackage(s.id, s.version);
    prepareBind(pkg);
  } catch (error) {
    toast.error(describeLogError(error, '读取样式失败'));
  }
};

// ---- 设计变量 ----
const tokenEntries = computed(() => Object.entries(props.stylePackage?.tokens || {}));
const tokenValue = (k: string, base: LogTokenValue) => (k in props.draft.themeTokens ? props.draft.themeTokens[k] : base);
const setToken = (k: string, v: LogTokenValue | null) => props.update((d) => {
  if (v === null || v === undefined || (typeof v === 'string' && /[;{}\\<>@()]/.test(v))) return;
  d.themeTokens = { ...d.themeTokens, [k]: v };
});
const resetToken = (k: string) => props.update((d) => {
  const next = { ...d.themeTokens };
  delete next[k];
  d.themeTokens = next;
});

const ruleText = (r: LogStyleRule) => [r.messageType && `类型=${r.messageType}`, r.identityKey && `角色=${r.identityKey}`, r.variantKey && `差分=${r.variantKey}`].filter(Boolean).join('，') || '任意消息';

// ---- 源码编辑 ----
interface SourceState {
  base: LogStylePackage;
  name: string;
  license: string;
  templates: Record<string, string>;
  css: string;
  tokensJson: string;
  rulesJson: string;
  schemaJson: string;
  assets: LogStyleAsset[];
}
const source = ref<SourceState | null>(null);
const activeTemplate = ref('');
const sourceIssues = ref<string[]>([]);
const sourceBusy = ref(false);
const savedUnbound = shallowRef<LogStylePackage | null>(null);
const newTemplateId = ref('');

const openSource = (pkg: LogStylePackage) => {
  source.value = {
    base: pkg,
    name: pkg.name,
    license: pkg.license,
    templates: { ...pkg.templates },
    css: pkg.css,
    tokensJson: JSON.stringify(pkg.tokens, null, 2),
    rulesJson: JSON.stringify(pkg.rules, null, 2),
    schemaJson: JSON.stringify(pkg.settingsSchema, null, 2),
    assets: pkg.assets.slice(),
  };
  activeTemplate.value = Object.keys(pkg.templates)[0] || '';
  sourceIssues.value = [];
};

const forkCurrent = async () => {
  const pkg = props.stylePackage;
  if (!pkg) return;
  sourceBusy.value = true;
  try {
    const forked = await forkLogStyle(pkg.id, pkg.version, `${pkg.name}（我的副本）`.slice(0, 200));
    await loadStyles();
    openSource(forked);
    prepareBind(forked);
    toast.success('已复制为私有样式');
  } catch (error) {
    toast.error(describeLogError(error, '复制失败'));
  } finally {
    sourceBusy.value = false;
  }
};

const bumpPatch = (v: string) => {
  const [a, b, c] = v.split('.').map((x) => Number.parseInt(x, 10) || 0);
  return `${a}.${b}.${c + 1}`;
};

/** 从源码状态组装包；JSON 语法错误返回 null 并记录问题。 */
const assemble = (): LogStylePackage | null => {
  const s = source.value;
  if (!s) return null;
  const issues: string[] = [];
  const parse = <T>(label: string, text: string, check: (v: unknown) => boolean): T | null => {
    try {
      const v = JSON.parse(text);
      if (!check(v)) {
        issues.push(`${label} 结构不正确`);
        return null;
      }
      return v as T;
    } catch (error) {
      issues.push(`${label} JSON 语法错误：${error instanceof Error ? error.message : ''}`);
      return null;
    }
  };
  const isObj = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v);
  const tokens = parse<Record<string, LogTokenValue>>('设计变量', s.tokensJson, isObj);
  const rules = parse<LogStyleRule[]>('规则', s.rulesJson, Array.isArray);
  const schema = parse<Record<string, unknown>>('参数 Schema', s.schemaJson, isObj);
  if (!s.name.trim()) issues.push('名称不能为空');
  if (!Object.keys(s.templates).length) issues.push('至少需要一个模板');
  if (!tokens || !rules || !schema || issues.length) {
    sourceIssues.value = issues;
    return null;
  }
  const pkg: LogStylePackage = {
    schemaVersion: 1,
    id: s.base.id,
    version: s.base.version,
    name: s.name.trim(),
    license: s.license,
    minRendererVersion: s.base.minRendererVersion,
    tokens,
    templates: { ...s.templates },
    css: s.css,
    rules,
    settingsSchema: schema,
    assets: s.assets.slice(),
  };
  const checked = checkStyleSource(pkg);
  sourceIssues.value = checked.issues.map((i) => `${i.templateId ? `[${i.templateId}] ` : ''}${i.message}`);
  return pkg;
};

/** 校验通过才更新本地预览；有错误时保留源码并继续显示上次成功的预览。 */
const checkAndPreview = () => {
  const pkg = assemble();
  if (!pkg) return;
  if (sourceIssues.value.length) {
    toast.warning('存在问题，预览保持上次成功的结果');
    return;
  }
  emit('preview', pkg);
  toast.success('本地预览已更新（尚未保存）');
};

const saveVersion = async () => {
  const s = source.value;
  const pkg = assemble();
  if (!s || !pkg || sourceIssues.value.length) {
    toast.error('请先修正问题再保存');
    return;
  }
  const baseVersion = latestOf(s.base.id) || s.base.version;
  pkg.version = bumpPatch(baseVersion);
  sourceBusy.value = true;
  try {
    const saved = await saveLogStyleVersion(s.base.id, baseVersion, pkg);
    savedUnbound.value = saved;
    openSource(saved);
    await loadStyles();
    emit('preview', saved);
    toast.success(`已保存版本 ${saved.version}，尚未绑定到本工程`);
  } catch (error) {
    if (isLogError(error, 'VERSION_CONFLICT')) toast.error('该样式已有更新版本，请重新打开源码后合并修改');
    else if (isLogError(error, 'PERMISSION_DENIED')) toast.error('只能保存自己的样式；请先复制为私有样式');
    else toast.error(describeLogError(error, '保存失败（服务端校验未通过）'));
  } finally {
    sourceBusy.value = false;
  }
};

const addTemplate = () => {
  const id = newTemplateId.value.trim();
  if (!source.value || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(id) || id in source.value.templates) {
    toast.warning('模板 ID 须为字母开头的字母数字/下划线/连字符，且不能重复');
    return;
  }
  source.value.templates = { ...source.value.templates, [id]: '<div class="log-' + id + '"></div>' };
  activeTemplate.value = id;
  newTemplateId.value = '';
};
const removeTemplate = () => {
  if (!source.value || !activeTemplate.value) return;
  const next = { ...source.value.templates };
  delete next[activeTemplate.value];
  source.value.templates = next;
  activeTemplate.value = Object.keys(next)[0] || '';
};
const templateModel = computed({
  get: () => (source.value && activeTemplate.value ? source.value.templates[activeTemplate.value] || '' : ''),
  set: (v: string) => {
    if (source.value && activeTemplate.value) source.value.templates = { ...source.value.templates, [activeTemplate.value]: v };
  },
});

// 资源：上传为自己的附件后登记到包，服务端按字节校验 MIME 与哈希。
const assetInput = ref<HTMLInputElement | null>(null);
const assetUploading = ref(false);
const MIME_BY_EXT: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', ttf: 'font/ttf', otf: 'font/otf' };
const onAssetFile = async (event: Event) => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file || !source.value) return;
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) {
    toast.error('只支持 PNG/JPEG/WebP 图片和 TTF/OTF 字体');
    return;
  }
  const base = file.name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'asset';
  let path = `assets/${base}.${ext}`;
  let n = 1;
  while (source.value.assets.some((a) => a.path === path)) path = `assets/${base}-${n++}.${ext}`;
  assetUploading.value = true;
  try {
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())), (b) => b.toString(16).padStart(2, '0')).join('');
    const { attachmentId } = await uploadImageAttachment(file, { channelId: null, skipCompression: true });
    const id = attachmentId.replace(/^id:/, '');
    source.value.assets = [...source.value.assets, { id, path, mime, sha256: hash }];
    toast.success(`已添加 ${path}，CSS 中用 url(${path}) 引用`);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '上传失败');
  } finally {
    assetUploading.value = false;
  }
};
const removeAsset = (id: string) => {
  if (source.value) source.value.assets = source.value.assets.filter((a) => a.id !== id);
};

// ---- 导入导出 ----
const importInput = ref<HTMLInputElement | null>(null);
const importFile = shallowRef<File | null>(null);
const importSummary = ref<StyleZipSummary | null>(null);
const importError = ref('');
const importBusy = ref(false);
const onImportFile = async (event: Event) => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  importFile.value = file;
  importSummary.value = null;
  importError.value = '';
  try {
    importSummary.value = await inspectStyleZip(file);
  } catch (error) {
    importError.value = error instanceof Error ? error.message : '无法读取 ZIP';
  }
};
const confirmImport = async () => {
  if (!importFile.value) return;
  importBusy.value = true;
  try {
    const r = await importLogStyleZip(importFile.value);
    await loadStyles();
    toast.success(`已导入 ${r.stylePackageId}@${r.version}${r.warnings?.length ? `（${r.warnings.length} 条警告）` : ''}`);
    if (r.warnings?.length) importError.value = r.warnings.join('；');
    importFile.value = null;
    importSummary.value = null;
  } catch (error) {
    importError.value = describeLogError(error, '导入失败（服务端校验未通过）');
  } finally {
    importBusy.value = false;
  }
};
const exportCurrent = async () => {
  const pkg = props.stylePackage;
  if (!pkg) return;
  try {
    const blob = await exportLogStyleZip(pkg.id, pkg.version);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${pkg.id}-${pkg.version}.zip`;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    toast.error(describeLogError(error, '导出失败'));
  }
};

watch(() => props.stylePackage?.id, () => {
  if (source.value && source.value.base.id !== props.stylePackage?.id && !savedUnbound.value) source.value = null;
});
</script>

<template>
  <div class="log-style">
    <section>
      <div class="log-style__title">当前样式</div>
      <div v-if="stylePackage" class="log-style__current">
        <div class="log-style__current-head">
          <LogStyleSketch :kind="currentInfo?.sketch || 'generic'" />
          <div class="log-style__current-text">
            <div><strong>{{ stylePackage.name }}</strong><span v-if="currentInfo" class="log-style__cat">{{ currentInfo.category }}</span></div>
            <span class="log-style__meta">{{ stylePackage.id }} @ {{ stylePackage.version }} · {{ stylePackage.license || '未声明许可' }}</span>
            <p v-if="currentInfo" class="log-style__summary">{{ currentInfo.summary }}</p>
          </div>
        </div>
        <div v-if="currentLatest" class="log-style__notice">
          样式库中已有 {{ currentLatest.version }}；当前工程仍固定使用 {{ stylePackage.version }}。
          <n-button size="tiny" text type="primary" :disabled="!canEdit" @click="useStyle(currentLatest)">更新</n-button>
          <n-button size="tiny" text @click="previewStyle(currentLatest)">先预览</n-button>
        </div>
        <div v-else-if="currentRetired" class="log-style__notice">
          这是已从样式库下线的旧版内置样式，可以继续使用、复制或导出，也可以从下方挑选新的排版。
        </div>
        <n-space size="small">
          <n-button size="tiny" @click="exportCurrent">导出 ZIP</n-button>
          <n-button v-if="owned" size="tiny" :disabled="!canEdit" @click="openSource(stylePackage)">编辑源码</n-button>
          <n-button v-else size="tiny" :loading="sourceBusy" :disabled="!canEdit" @click="forkCurrent">复制为我的样式并编辑</n-button>
        </n-space>
      </div>
      <n-spin v-else size="small" />
    </section>

    <n-alert v-if="previewing" type="info" :show-icon="false">
      正在预览：{{ previewing.name }} {{ previewing.version }}（未应用）
      <n-space size="small" style="margin-top: 6px">
        <n-button size="tiny" type="primary" :disabled="!canEdit" @click="prepareBind(previewing)">应用到本工程</n-button>
        <n-button size="tiny" @click="cancelPreview">取消预览</n-button>
      </n-space>
    </n-alert>

    <n-alert v-if="savedUnbound" type="warning" :show-icon="false">
      已保存 {{ savedUnbound.name }} {{ savedUnbound.version }}，但尚未绑定到本工程。
      <n-button size="tiny" type="primary" style="margin-left: 6px" :disabled="!canEdit" @click="prepareBind(savedUnbound)">绑定到本工程</n-button>
    </n-alert>

    <n-alert v-if="bindTarget && bindProblems.length" :type="bindProblems.some((p) => !p.fixable) ? 'error' : 'warning'" title="切换样式需要调整草稿">
      <ul class="log-style__list">
        <li v-for="(p, i) in bindProblems" :key="i">{{ p.message }}</li>
      </ul>
      <n-space size="small">
        <n-button size="tiny" type="primary" :disabled="bindProblems.some((p) => !p.fixable)" @click="confirmBind">按上述调整并切换</n-button>
        <n-button size="tiny" @click="bindTarget = null; bindProblems = []">取消</n-button>
      </n-space>
    </n-alert>

    <section v-if="tokenEntries.length">
      <div class="log-style__title">设计变量</div>
      <div v-for="[k, base] in tokenEntries" :key="k" class="log-style__token">
        <label :for="`tok-${k}`">{{ k }}</label>
        <n-switch v-if="typeof base === 'boolean'" :value="tokenValue(k, base) === true" :disabled="!canEdit" @update:value="(v: boolean) => setToken(k, v)" />
        <n-input-number v-else-if="typeof base === 'number'" :input-props="{ id: `tok-${k}` }" size="small" :value="tokenValue(k, base) as number" :disabled="!canEdit" @update:value="(v: number | null) => setToken(k, v)" />
        <n-color-picker v-else-if="HEX.test(String(base))" size="small" :modes="['hex']" :value="String(tokenValue(k, base))" :disabled="!canEdit" @update:value="(v: string) => setToken(k, v)" />
        <n-input v-else :input-props="{ id: `tok-${k}` }" size="small" :value="String(tokenValue(k, base))" maxlength="200" :disabled="!canEdit" @update:value="(v: string) => setToken(k, v)" />
        <n-button size="tiny" quaternary :disabled="!canEdit || !(k in draft.themeTokens)" @click="resetToken(k)">还原</n-button>
      </div>
    </section>

    <section>
      <div class="log-style__title">消息模板规则（按顺序首个匹配）</div>
      <ol class="log-style__rules">
        <li v-for="(r, i) in stylePackage?.rules || []" :key="i">{{ ruleText(r) }} → <code>{{ r.templateId }}</code></li>
      </ol>
      <p class="log-style__hint">“LOG 显示规则”只影响排版，不写原消息；要修改规则请编辑样式源码。</p>
    </section>

    <section>
      <div class="log-style__title">样式库 · 内置排版</div>
      <p class="log-style__hint log-style__hint--lead">每套内置样式是一种不同的版面结构；配色、字体、间距等细节在上方“设计变量”里调整。</p>
      <n-alert v-if="stylesError" type="error" :show-icon="false">{{ stylesError }}</n-alert>
      <div class="log-style__lib">
        <article
          v-for="s in builtinStyles"
          :key="s.id"
          class="log-style__card"
          :class="{ 'is-current': stylePackage?.id === s.id, 'is-previewing': previewing?.id === s.id && previewing?.version === s.version }"
        >
          <LogStyleSketch :kind="builtinStyleInfo(s.id)?.sketch || 'generic'" />
          <div class="log-style__card-body">
            <div class="log-style__card-head">
              <strong>{{ s.name }}</strong>
              <span class="log-style__cat">{{ builtinStyleInfo(s.id)?.category || '内置' }}</span>
            </div>
            <p v-if="builtinStyleInfo(s.id)" class="log-style__summary">{{ builtinStyleInfo(s.id)!.summary }}</p>
            <div v-if="builtinStyleInfo(s.id)" class="log-style__scenes">适合：{{ builtinStyleInfo(s.id)!.scenes.join(' · ') }}</div>
            <div class="log-style__card-foot">
              <span class="log-style__meta">v{{ s.version }}</span>
              <n-space size="small">
                <n-button size="tiny" @click="previewStyle(s)">预览</n-button>
                <n-button size="tiny" :type="isCurrent(s) ? 'default' : 'primary'" secondary :disabled="!canEdit || isCurrent(s)" @click="useStyle(s)">{{ useLabel(s) }}</n-button>
              </n-space>
            </div>
          </div>
        </article>
      </div>
      <template v-if="ownStyles.length">
        <div class="log-style__subtitle">我的样式</div>
        <div v-for="s in ownStyles" :key="s.id" class="log-style__row" :class="{ 'is-current': stylePackage?.id === s.id }">
          <div class="log-style__row-name">
            {{ s.name }}
            <span class="log-style__meta">{{ s.version }}</span>
          </div>
          <n-space size="small">
            <n-button size="tiny" @click="previewStyle(s)">预览</n-button>
            <n-button size="tiny" :disabled="!canEdit || isCurrent(s)" @click="useStyle(s)">{{ useLabel(s) }}</n-button>
          </n-space>
        </div>
      </template>
      <n-button v-if="stylesCursor" size="tiny" :loading="stylesLoading" @click="loadStyles(true)">更多</n-button>
    </section>

    <section>
      <div class="log-style__title">导入 ZIP</div>
      <n-button size="small" @click="importInput?.click()">选择 ZIP…</n-button>
      <input ref="importInput" type="file" accept=".zip,application/zip" hidden @change="onImportFile">
      <div v-if="importFile" class="log-style__import">
        <div>{{ importFile.name }}（{{ Math.ceil(importFile.size / 1024) }} KB）</div>
        <template v-if="importSummary">
          <div v-if="importSummary.manifest" class="log-style__meta">
            {{ String(importSummary.manifest.name || '') }} · {{ String(importSummary.manifest.id || '') }} @ {{ String(importSummary.manifest.version || '') }}
            · 许可 {{ String(importSummary.manifest.license || '未声明') }} · 渲染器 ≥ {{ String(importSummary.manifest.minRendererVersion || '?') }}
          </div>
          <div class="log-style__meta">模板 {{ importSummary.templates.length }} 个，文件 {{ importSummary.entries.length }} 个</div>
          <ul v-if="importSummary.warnings.length" class="log-style__list is-warn">
            <li v-for="w in importSummary.warnings" :key="w">{{ w }}</li>
          </ul>
        </template>
        <n-space size="small">
          <n-button size="tiny" type="primary" :loading="importBusy" @click="confirmImport">提交服务器校验并导入</n-button>
          <n-button size="tiny" @click="importFile = null; importSummary = null">取消</n-button>
        </n-space>
      </div>
      <n-alert v-if="importError" type="warning" :show-icon="false" style="margin-top: 6px">{{ importError }}</n-alert>
    </section>

    <section v-if="source" class="log-style__source">
      <div class="log-style__title">源码：{{ source.base.id }}（基于 {{ source.base.version }}）</div>
      <n-form size="small" label-placement="left" label-width="56">
        <n-form-item label="名称"><n-input v-model:value="source.name" maxlength="200" /></n-form-item>
        <n-form-item label="许可"><n-input v-model:value="source.license" maxlength="200" placeholder="如 MIT、CC-BY-4.0" /></n-form-item>
      </n-form>
      <div class="log-style__subtitle">模板</div>
      <n-space size="small" align="center">
        <n-select v-model:value="activeTemplate" size="small" style="width: 160px" :options="Object.keys(source.templates).map((id) => ({ label: id, value: id }))" />
        <n-input v-model:value="newTemplateId" size="small" style="width: 110px" placeholder="新模板 ID" />
        <n-button size="tiny" @click="addTemplate">添加</n-button>
        <n-popconfirm @positive-click="removeTemplate">
          <template #trigger><n-button size="tiny" quaternary type="error" :disabled="!activeTemplate">删除</n-button></template>
          删除模板 {{ activeTemplate }}？
        </n-popconfirm>
      </n-space>
      <n-input v-model:value="templateModel" type="textarea" class="log-style__code" :autosize="{ minRows: 6, maxRows: 16 }" spellcheck="false" aria-label="模板 HTML" />
      <div class="log-style__subtitle">CSS</div>
      <n-input v-model:value="source.css" type="textarea" class="log-style__code" :autosize="{ minRows: 8, maxRows: 24 }" spellcheck="false" aria-label="样式 CSS" />
      <div class="log-style__subtitle">设计变量（JSON）</div>
      <n-input v-model:value="source.tokensJson" type="textarea" class="log-style__code" :autosize="{ minRows: 3, maxRows: 12 }" spellcheck="false" />
      <div class="log-style__subtitle">消息规则（JSON 数组）</div>
      <n-input v-model:value="source.rulesJson" type="textarea" class="log-style__code" :autosize="{ minRows: 3, maxRows: 12 }" spellcheck="false" />
      <div class="log-style__subtitle">参数 Schema（JSON，按模板 ID）</div>
      <n-input v-model:value="source.schemaJson" type="textarea" class="log-style__code" :autosize="{ minRows: 3, maxRows: 12 }" spellcheck="false" />
      <div class="log-style__subtitle">资源</div>
      <div v-for="a in source.assets" :key="a.id" class="log-style__asset">
        <code>{{ a.path }}</code><span class="log-style__meta">{{ a.mime }}</span>
        <n-button size="tiny" quaternary type="error" @click="removeAsset(a.id)">移除</n-button>
      </div>
      <n-button size="tiny" :loading="assetUploading" @click="assetInput?.click()">添加图片/字体…</n-button>
      <input ref="assetInput" type="file" accept=".png,.jpg,.jpeg,.webp,.ttf,.otf" hidden @change="onAssetFile">
      <ul v-if="sourceIssues.length" class="log-style__list is-error">
        <li v-for="(m, i) in sourceIssues" :key="i">{{ m }}</li>
      </ul>
      <n-space size="small" style="margin-top: 8px">
        <n-button size="small" @click="checkAndPreview">校验并预览</n-button>
        <n-button size="small" type="primary" :loading="sourceBusy" :disabled="!canEdit" @click="saveVersion">保存为新版本</n-button>
        <n-button size="small" quaternary @click="source = null; emit('preview', null)">关闭</n-button>
      </n-space>
    </section>
  </div>
</template>

<style scoped>
.log-style {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 8px 0 16px;
}

.log-style > section + section {
  padding-top: 14px;
  border-top: 1px solid var(--sc-border-mute, #e5e5e5);
}

.log-style__title {
  font-weight: 600;
  font-size: 12px;
  letter-spacing: 0.02em;
  color: var(--sc-text-secondary, #666);
  margin-bottom: 8px;
}

.log-style__subtitle {
  font-weight: 600;
  font-size: 12px;
  margin: 8px 0 4px;
}

.log-style__current {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--sc-border-strong, #e5e5e5);
  border-radius: 8px;
  background: var(--sc-chip-bg, rgba(15, 23, 42, 0.04));
}

.log-style__meta {
  font-size: 12px;
  color: var(--sc-text-secondary, #666);
  margin-left: 4px;
}

.log-style__hint {
  font-size: 12px;
  color: var(--sc-text-secondary, #666);
}

.log-style__token {
  display: grid;
  grid-template-columns: 110px 1fr auto;
  gap: 6px;
  align-items: center;
  margin-bottom: 4px;
  font-size: 12px;
}

.log-style__token label {
  overflow: hidden;
  text-overflow: ellipsis;
}

.log-style__rules {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
}

.log-style__current-head {
  display: flex;
  gap: 10px;
  align-items: flex-start;
}

.log-style__current-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.log-style__current-text .log-style__meta {
  margin-left: 0;
  overflow-wrap: anywhere;
}

.log-style__notice {
  font-size: 12px;
  line-height: 1.5;
  color: var(--sc-text-secondary, #666);
}

.log-style__cat {
  display: inline-block;
  margin-left: 6px;
  padding: 0 6px;
  border-radius: 999px;
  font-size: 11px;
  line-height: 18px;
  color: var(--sc-text-secondary, #666);
  background: var(--sc-chip-bg, rgba(15, 23, 42, 0.06));
  vertical-align: 1px;
}

.log-style__summary {
  margin: 2px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--sc-text-primary, inherit);
}

.log-style__hint--lead {
  margin: -4px 0 8px;
}

.log-style__lib {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.log-style__card {
  display: flex;
  gap: 10px;
  padding: 10px;
  border: 1px solid var(--sc-border-mute, #e5e5e5);
  border-radius: 8px;
  transition: border-color 0.15s ease, background-color 0.15s ease;
}

.log-style__card:hover {
  border-color: var(--sc-border-strong, #cfcfcf);
}

.log-style__card.is-previewing {
  border-color: #2f6fde;
  border-style: dashed;
}

.log-style__card.is-current {
  border-color: #2f6fde;
  background: rgba(47, 111, 222, 0.06);
}

.log-style__card-body {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.log-style__card-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 2px 0;
  font-size: 13px;
}

.log-style__scenes {
  font-size: 11px;
  line-height: 1.5;
  color: var(--sc-text-secondary, #666);
}

.log-style__card-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  margin-top: 4px;
}

.log-style__card-foot .log-style__meta {
  margin-left: 0;
}

.log-style__row.is-current {
  font-weight: 600;
}

.log-style__row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
  border-bottom: 1px solid var(--sc-border-mute, #eee);
  font-size: 13px;
}

.log-style__list {
  margin: 4px 0 8px;
  padding-left: 18px;
  font-size: 12px;
}

.log-style__list.is-error,
.log-style__list.is-warn {
  color: #b7791f;
}

.log-style__import {
  margin-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
}

.log-style__code :deep(textarea) {
  font-family: "SFMono-Regular", Consolas, monospace;
  font-size: 12px;
}

.log-style__asset {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}
</style>
