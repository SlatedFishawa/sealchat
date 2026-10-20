<script setup lang="ts">
// 页面设计：先在本地校验几何范围（与服务端规则一致），合法后才写入草稿并触发重排。
import { computed, onMounted, ref, watch } from 'vue';
import type { LogDraft, LogPageSettings, LogStylePackage } from '@/types/log';
import { listPlatformFonts } from '@/services/font/platformFontApi';
import type { PlatformFontAsset } from '@/services/font/platformFontTypes';
import { cloneJson, packageFontAssets, packageImageAssets } from '../logDraftOps';

const props = defineProps<{
  draft: LogDraft;
  update: (mutate: (d: LogDraft) => void) => boolean;
  stylePackage: LogStylePackage | null;
  canEdit: boolean;
}>();

const PRESETS: Record<'a4' | 'a5', { w: number; h: number }> = { a4: { w: 210, h: 297 }, a5: { w: 148, h: 210 } };
const HEX = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;

const local = ref<LogPageSettings>(cloneJson(props.draft.page));
const platformFonts = ref<PlatformFontAsset[]>([]);
const loadingPlatformFonts = ref(false);
watch(() => props.draft.page, (p) => {
  local.value = cloneJson(p);
});

const validate = (p: LogPageSettings): string => {
  const m = p.marginsMm;
  const nums = [p.widthMm, p.heightMm, m.top, m.right, m.bottom, m.left, p.gutterMm, p.fontSizePt, p.lineHeight];
  if (nums.some((n) => typeof n !== 'number' || !Number.isFinite(n) || n < 0)) return '数值必须是非负数';
  if (p.widthMm < 50 || p.widthMm > 1000 || p.heightMm < 50 || p.heightMm > 1000) return '纸张宽高须在 50～1000mm';
  if (m.top + m.bottom >= p.heightMm) return '上下边距之和必须小于纸张高度';
  if (m.left + m.right + p.gutterMm >= p.widthMm) return '左右边距与装订线之和必须小于纸张宽度';
  if (p.fontSizePt < 6 || p.fontSizePt > 72) return '字号须在 6～72pt';
  if (p.lineHeight < 1 || p.lineHeight > 3) return '行高须在 1～3';
  if (!HEX.test(p.backgroundColor)) return '背景色须为 #RRGGBB 或 #RRGGBBAA';
  return '';
};
const error = computed(() => validate(local.value));

const commit = () => {
  if (error.value) return;
  const next = cloneJson(local.value);
  props.update((d) => {
    d.page = next;
  });
};

const set = <K extends keyof LogPageSettings>(key: K, value: LogPageSettings[K]) => {
  local.value = { ...local.value, [key]: value };
  commit();
};
const setMargin = (key: 'top' | 'right' | 'bottom' | 'left', value: number | null) => {
  if (value === null) return;
  local.value = { ...local.value, marginsMm: { ...local.value.marginsMm, [key]: value } };
  commit();
};
const setNum = (key: 'widthMm' | 'heightMm' | 'gutterMm' | 'fontSizePt' | 'lineHeight', value: number | null) => {
  if (value === null) return;
  const next = { ...local.value, [key]: value };
  if (key === 'widthMm' || key === 'heightMm') next.preset = 'custom';
  local.value = next;
  commit();
};
const setPreset = (preset: 'a4' | 'a5' | 'custom') => {
  const next = { ...local.value, preset };
  if (preset !== 'custom') {
    next.widthMm = PRESETS[preset].w;
    next.heightMm = PRESETS[preset].h;
  }
  local.value = next;
  commit();
};

const templateOptions = computed(() => Object.keys(props.stylePackage?.templates || {}).map((id) => ({ label: id, value: id })));
const backgroundOptions = computed(() => packageImageAssets(props.stylePackage).map((a) => ({ label: a.path, value: a.id })));
const fontOptions = computed(() => [
  { label: '无衬线（系统）', value: 'sans-serif' },
  { label: '衬线/宋体（系统）', value: 'serif' },
  { label: '等宽（系统）', value: 'monospace' },
  ...platformFonts.value.map((font) => ({ label: `平台字体：${font.displayName || font.family}`, value: `platform:${font.id}` })),
  ...packageFontAssets(props.stylePackage).map((a) => ({ label: `样式包字体：${a.path}`, value: a.id })),
]);

const refreshPlatformFonts = async () => {
  loadingPlatformFonts.value = true;
  try {
    platformFonts.value = await listPlatformFonts();
  } catch {
    platformFonts.value = [];
  } finally {
    loadingPlatformFonts.value = false;
  }
};

onMounted(() => { void refreshPlatformFonts(); });
</script>

<template>
  <n-form class="log-page" size="small" label-placement="left" label-width="72" :disabled="!canEdit">
    <n-alert v-if="error" type="error" :show-icon="false" class="log-page__err">{{ error }}（未应用）</n-alert>
    <div class="log-page__title is-first">纸张</div>
    <n-form-item label="尺寸">
      <n-radio-group :value="local.preset" @update:value="setPreset">
        <n-radio-button value="a5">A5</n-radio-button>
        <n-radio-button value="a4">A4</n-radio-button>
        <n-radio-button value="custom">自定义</n-radio-button>
      </n-radio-group>
    </n-form-item>
    <n-form-item label="宽 × 高">
      <n-space size="small" :wrap="false">
        <n-input-number :value="local.widthMm" :min="50" :max="1000" :step="1" style="width: 96px" @update:value="(v: number | null) => setNum('widthMm', v)"><template #suffix>mm</template></n-input-number>
        <n-input-number :value="local.heightMm" :min="50" :max="1000" :step="1" style="width: 96px" @update:value="(v: number | null) => setNum('heightMm', v)"><template #suffix>mm</template></n-input-number>
      </n-space>
    </n-form-item>
    <n-form-item label="边距">
      <div class="log-page__margins">
        <n-input-number v-for="k in (['top', 'right', 'bottom', 'left'] as const)" :key="k" :value="local.marginsMm[k]" :min="0" :max="500" size="small" :aria-label="`${{ top: '上', right: '右', bottom: '下', left: '左' }[k]}边距`" @update:value="(v: number | null) => setMargin(k, v)">
          <template #prefix>{{ { top: '上', right: '右', bottom: '下', left: '左' }[k] }}</template>
        </n-input-number>
      </div>
    </n-form-item>
    <n-form-item label="装订线">
      <n-input-number :value="local.gutterMm" :min="0" :max="100" @update:value="(v: number | null) => setNum('gutterMm', v)"><template #suffix>mm</template></n-input-number>
    </n-form-item>
    <n-form-item label="分栏">
      <n-radio-group :value="local.columns" @update:value="(v: 1 | 2) => set('columns', v)">
        <n-radio-button :value="1">单栏</n-radio-button>
        <n-radio-button :value="2">双栏</n-radio-button>
      </n-radio-group>
    </n-form-item>

    <div class="log-page__title">背景与文字</div>
    <n-form-item label="背景色">
      <n-color-picker :value="local.backgroundColor" :modes="['hex']" :show-alpha="true" @update:value="(v: string) => set('backgroundColor', v)" />
    </n-form-item>
    <n-form-item label="背景图">
      <n-select :value="local.backgroundAssetId" clearable :options="backgroundOptions" :placeholder="backgroundOptions.length ? '无' : '当前样式包没有图片资源'" @update:value="(v: string | null) => set('backgroundAssetId', v)" />
    </n-form-item>
    <n-form-item label="字体">
      <n-select :value="local.fontFamily" :options="fontOptions" :loading="loadingPlatformFonts" filterable @update:value="(v: string) => set('fontFamily', v)" />
    </n-form-item>
    <n-form-item label="字号">
      <n-input-number :value="local.fontSizePt" :min="6" :max="72" :step="0.5" @update:value="(v: number | null) => setNum('fontSizePt', v)"><template #suffix>pt</template></n-input-number>
    </n-form-item>
    <n-form-item label="行高">
      <n-input-number :value="local.lineHeight" :min="1" :max="3" :step="0.05" @update:value="(v: number | null) => setNum('lineHeight', v)" />
    </n-form-item>

    <div class="log-page__title">页眉页脚</div>
    <n-form-item label="页眉">
      <n-select :value="local.headerTemplateId" clearable :options="templateOptions" placeholder="无" @update:value="(v: string | null) => set('headerTemplateId', v)" />
    </n-form-item>
    <n-form-item label="页脚">
      <n-select :value="local.footerTemplateId" clearable :options="templateOptions" placeholder="默认（仅页码）" @update:value="(v: string | null) => set('footerTemplateId', v)" />
    </n-form-item>
    <n-form-item label="页码">
      <n-switch :value="local.showPageNumbers" @update:value="(v: boolean) => set('showPageNumbers', v)" />
    </n-form-item>
    <n-form-item label="合并消息">
      <n-space vertical size="small">
        <n-switch :value="local.mergeNeighbors" @update:value="(v: boolean) => set('mergeNeighbors', v)" />
        <span class="log-page__hint">同一角色、同一差分、同一类型的相邻消息合并显示（仅显示效果，仍可单条选择）。</span>
      </n-space>
    </n-form-item>
  </n-form>
</template>

<style scoped>
.log-page {
  padding: 8px 0 16px;
}

.log-page__title {
  font-weight: 600;
  font-size: 12px;
  letter-spacing: 0.02em;
  color: var(--sc-text-secondary, #666);
  margin: 14px 0 10px;
  padding-top: 14px;
  border-top: 1px solid var(--sc-border-mute, #e5e5e5);
}

.log-page__title.is-first {
  margin-top: 4px;
  padding-top: 0;
  border-top: 0;
}

.log-page__err {
  margin-bottom: 8px;
}

.log-page__margins {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px;
}

.log-page__hint {
  font-size: 12px;
  color: var(--sc-text-secondary, #666);
}
</style>
