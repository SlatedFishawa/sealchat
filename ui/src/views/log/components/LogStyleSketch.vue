<script setup lang="ts">
// 样式库缩略图：用色块示意每套内置样式的结构差异（名字位置、头像、分组方式），不是真实渲染。
import type { LogStyleSketchKind } from '../logStyleCatalog';

defineProps<{ kind: LogStyleSketchKind }>();
</script>

<template>
  <div class="sk" :class="`sk--${kind}`" aria-hidden="true">
    <template v-if="kind === 'bubble'">
      <div class="sk-chip" />
      <div v-for="i in 3" :key="i" class="sk-row">
        <span class="sk-av" :class="`c${i}`" />
        <span class="sk-col"><span class="sk-name" :class="`c${i}`" /><span class="sk-bub" :style="{ width: ['78%', '56%', '70%'][i - 1] }" /></span>
      </div>
      <div class="sk-pill" />
    </template>
    <template v-else-if="kind === 'compact'">
      <div class="sk-bar" />
      <div v-for="i in 7" :key="i" class="sk-line" :class="{ 'is-turn': i !== 3 && i !== 6 }">
        <span class="sk-av" :class="i !== 3 && i !== 6 ? `c${(i % 3) + 1}` : 'is-blank'" />
        <span v-if="i !== 3 && i !== 6" class="sk-name" :class="`c${(i % 3) + 1}`" />
        <span class="sk-text" />
      </div>
    </template>
    <template v-else-if="kind === 'script'">
      <div class="sk-title" />
      <div v-for="i in 4" :key="i" class="sk-row">
        <span class="sk-name" :class="`c${(i % 3) + 1}`" />
        <span class="sk-col"><span class="sk-text" /><span class="sk-text is-short" /></span>
      </div>
      <div class="sk-dir" />
    </template>
    <template v-else-if="kind === 'novel'">
      <div class="sk-orn" />
      <div v-for="i in 7" :key="i" class="sk-text" :class="{ 'is-indent': i === 1 || i === 4 || i === 6, 'is-short': i === 3 || i === 5 }" />
      <div class="sk-note" />
    </template>
    <template v-else-if="kind === 'dossier'">
      <div class="sk-stamp" />
      <div v-for="i in 2" :key="i" class="sk-rec">
        <span class="sk-photo" />
        <span class="sk-col"><span class="sk-head" /><span class="sk-text" /><span class="sk-text is-short" /></span>
      </div>
      <div class="sk-form" />
      <div class="sk-red" />
    </template>
    <template v-else-if="kind === 'terminal'">
      <div class="sk-hd" />
      <div v-for="i in 5" :key="i" class="sk-row">
        <span class="sk-time" />
        <span class="sk-dot" :class="`c${(i % 3) + 1}`" />
        <span class="sk-text" :class="{ 'is-short': i % 2 === 0 }" />
      </div>
    </template>
    <template v-else>
      <div v-for="i in 5" :key="i" class="sk-plain"><span class="sk-name" /><span class="sk-text" /></div>
    </template>
  </div>
</template>

<style scoped>
.sk {
  position: relative;
  flex: none;
  width: 56px;
  height: 74px;
  padding: 6px 5px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  overflow: hidden;
  border-radius: 3px;
  background: #ffffff;
  box-shadow: 0 0 0 1px rgba(15, 23, 42, 0.1), 0 1px 3px rgba(15, 23, 42, 0.12);
}

.sk span,
.sk div {
  display: block;
  flex: none;
}

.sk-text { height: 2px; width: 100%; border-radius: 1px; background: #c9cdd4; }
.sk-text.is-short { width: 62%; }
.sk-name { height: 2px; width: 12px; border-radius: 1px; background: #4b5563; }
.c1 { background: #c0392b !important; }
.c2 { background: #2e86de !important; }
.c3 { background: #7d5fff !important; }
.sk-row { display: flex !important; align-items: flex-start; gap: 3px; }
.sk-col { display: flex !important; flex: 1 !important; flex-direction: column; gap: 2px; min-width: 0; }

/* 气泡：圆头像 + 名字 + 圆角气泡，底部通知胶囊 */
.sk--bubble .sk-av { width: 9px; height: 9px; border-radius: 50%; opacity: 0.85; }
.sk--bubble .sk-name { width: 10px; height: 2px; }
.sk--bubble .sk-bub { height: 7px; border-radius: 1px 4px 4px 4px; background: #eceef2; }
.sk--bubble .sk-chip { align-self: center; width: 22px; height: 4px; border-radius: 3px; background: #4f6ef7; margin-bottom: 1px; }
.sk--bubble .sk-pill { align-self: center; width: 28px; height: 4px; border-radius: 3px; background: #eceef2; margin-top: 1px; }

/* 紧凑：反白标题条 + 小方头像 + 行内署名 + 轮次细线 */
.sk--compact { gap: 2px; }
.sk--compact .sk-bar { height: 5px; background: #1d2129; margin-bottom: 1px; }
.sk--compact .sk-line { display: flex !important; gap: 2px; padding-top: 2px; }
.sk--compact .sk-line.is-turn { border-top: 1px solid #e5e7eb; }
.sk--compact .sk-name { width: 8px; }
.sk--compact .sk-line { align-items: center; }
.sk--compact .sk-av { width: 4px; height: 4px; border-radius: 1px; opacity: 0.8; }
.sk--compact .sk-av.is-blank { background: transparent; }

/* 剧本：右对齐名列 + 台词栏 + 舞台指示 */
.sk--script .sk-title { align-self: center; width: 30px; height: 3px; border-top: 1px solid #111; border-bottom: 1px solid #111; margin-bottom: 2px; }
.sk--script .sk-row { gap: 3px; }
.sk--script .sk-name { width: 9px; margin-left: 2px; }
.sk--script .sk-dir { margin-left: 15px; height: 7px; border-left: 1px solid #111; background: repeating-linear-gradient(#fff 0 2px, #e5e7eb 2px 3px); }

/* 小说：章节饰线 + 缩进段落 + 旁注 */
.sk--novel { background: #fffdf8; gap: 3px; }
.sk--novel .sk-orn { align-self: center; width: 16px; height: 3px; border-bottom: 1px solid #7a3b2e; margin: 2px 0 3px; }
.sk--novel .sk-text { background: #d6cfc6; }
.sk--novel .sk-text.is-indent { margin-left: 6px; width: calc(100% - 6px); }
.sk--novel .sk-note { margin: 1px 0 0 6px; height: 5px; border-left: 1px solid #d8cfc4; }

/* 档案：证件照 + 表头行 + 检定表格 + 红笔批注 + 印章 */
.sk--dossier { background: #f4efe2; gap: 3px; }
.sk--dossier .sk-stamp { position: absolute; top: 4px; right: 4px; width: 12px; height: 5px; border: 1px solid #a3261b; }
.sk--dossier .sk-rec { display: flex !important; gap: 3px; margin-top: 2px; }
.sk--dossier .sk-photo { width: 8px; height: 10px; border: 1px solid #26241f; background: #b9a58c; }
.sk--dossier .sk-head { height: 3px; border-bottom: 1px solid #26241f; }
.sk--dossier .sk-text { background: #bdb5a1; }
.sk--dossier .sk-form { margin-left: 11px; height: 6px; border: 1px solid #26241f; background: linear-gradient(90deg, rgba(0, 0, 0, 0.08) 35%, transparent 35%); }
.sk--dossier .sk-red { margin-left: 11px; height: 4px; border-left: 1px solid #a3261b; background: linear-gradient(#a3261b, #a3261b) 2px 1px / 60% 1px no-repeat; }

/* 舰桥日志：深色屏幕 + 时间栏 + 时间轴节点 */
.sk--terminal { background: #0b1511; gap: 4px; }
.sk--terminal .sk-hd { height: 4px; width: 70%; background: #5ef0a0; }
.sk--terminal .sk-row { align-items: center; gap: 2px; }
.sk--terminal .sk-time { width: 9px; height: 2px; background: #3f6b55; }
.sk--terminal .sk-dot { width: 4px; height: 4px; border-radius: 50%; box-shadow: 0 0 0 1px #0b1511; }
.sk--terminal .sk-text { flex: 1 !important; background: #6f9a83; }
.sk--terminal .sk-text.is-short { flex: 0 0 55% !important; }
.sk--terminal::before { content: ''; position: absolute; left: 18px; top: 13px; bottom: 6px; width: 1px; background: #25463a; }

/* 骨架 / 私有：最简行 */
.sk--starter .sk-plain,
.sk--generic .sk-plain { display: flex !important; flex-direction: column; gap: 2px; margin-bottom: 2px; }
.sk--generic { background: #f8fafc; }
</style>
