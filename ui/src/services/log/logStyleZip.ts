// 导入前的本地预检：只读取 ZIP 中央目录与 manifest.json，向用户展示包信息与明显问题。
// 权威校验仍由服务端完成；这里不解析模板/CSS，不执行任何内容。
import { LOG_RENDERER_VERSION } from './logTemplateCompiler';
import { inflateRaw } from '@/services/zip/zipCompression';

export interface StyleZipSummary {
  manifest: Record<string, unknown> | null;
  entries: string[];
  templates: string[];
  hasTokens: boolean;
  hasSchema: boolean;
  hasCss: boolean;
  warnings: string[];
}

const MAX_ZIP = 20 * 1024 * 1024;
const MAX_MANIFEST = 1024 * 1024;

const semverGt = (a: string, b: string) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
};

export const inspectStyleZip = async (file: File): Promise<StyleZipSummary> => {
  const warnings: string[] = [];
  if (file.size > MAX_ZIP) throw new Error('ZIP 超过 20MB');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // 查找 End of Central Directory（最多回溯 64KB 注释）。
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件');
  const count = view.getUint16(eocd + 10, true);
  let ptr = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const entries: string[] = [];
  let manifestEntry: { method: number; size: number; uncompressedSize: number; offset: number } | null = null;
  for (let n = 0; n < count && n < 1000; n += 1) {
    if (ptr + 46 > bytes.length || view.getUint32(ptr, true) !== 0x02014b50) throw new Error('ZIP 目录损坏');
    const method = view.getUint16(ptr + 10, true);
    const compSize = view.getUint32(ptr + 20, true);
    const uncompressedSize = view.getUint32(ptr + 24, true);
    const nameLen = view.getUint16(ptr + 28, true);
    const extraLen = view.getUint16(ptr + 30, true);
    const commentLen = view.getUint16(ptr + 32, true);
    const localOffset = view.getUint32(ptr + 42, true);
    const name = decoder.decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen));
    entries.push(name);
    if (name === 'manifest.json') manifestEntry = { method, size: compSize, uncompressedSize, offset: localOffset };
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  let manifest: Record<string, unknown> | null = null;
  if (!manifestEntry) {
    warnings.push('缺少 manifest.json');
  } else if (manifestEntry.uncompressedSize > MAX_MANIFEST) {
    warnings.push('manifest.json 过大');
  } else {
    const lo = manifestEntry.offset;
    if (view.getUint32(lo, true) !== 0x04034b50) throw new Error('manifest.json 头损坏');
    const start = lo + 30 + view.getUint16(lo + 26, true) + view.getUint16(lo + 28, true);
    const raw = bytes.subarray(start, start + manifestEntry.size);
    try {
      const data = manifestEntry.method === 0
        ? raw
        : manifestEntry.method === 8
          ? await inflateRaw(raw, manifestEntry.uncompressedSize)
          : null;
      if (!data) warnings.push('manifest.json 使用了不支持的压缩方式，跳过本地预检');
      else if (data.byteLength > MAX_MANIFEST) warnings.push('manifest.json 过大');
      else manifest = JSON.parse(decoder.decode(data));
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : 'manifest.json 无法解析');
    }
  }
  const templates = entries.filter((e) => /^templates\/[^/]+\.html$/.test(e)).map((e) => e.slice(10, -5));
  const hasTokens = entries.includes('tokens.json');
  const hasSchema = entries.includes('settings.schema.json');
  const hasCss = entries.includes('styles/main.css');
  if (!templates.length) warnings.push('没有 templates/*.html');
  if (!hasCss) warnings.push('缺少 styles/main.css');
  if (!hasTokens) warnings.push('缺少 tokens.json');
  if (!hasSchema) warnings.push('缺少 settings.schema.json');
  if (entries.some((e) => e.includes('..') || e.startsWith('/') || e.includes('\\'))) warnings.push('包含可疑路径，服务端将拒绝');
  const minVer = typeof manifest?.minRendererVersion === 'string' ? manifest.minRendererVersion : '';
  if (minVer && semverGt(minVer, LOG_RENDERER_VERSION)) warnings.push(`需要渲染器 ${minVer}，当前为 ${LOG_RENDERER_VERSION}`);
  return { manifest, entries, templates, hasTokens, hasSchema, hasCss, warnings };
};
