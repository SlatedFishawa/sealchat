export interface GeneratedAvatarThemeSeed {
  palette?: 'day' | 'night';
  customThemeEnabled?: boolean;
  activeCustomThemeId?: string | null;
}

// a: 实色块；b: 柔和色调；c: 对称图案叠字
export type GeneratedAvatarStyle = 'a' | 'b' | 'c';
export type GeneratedAvatarTone = 'day' | 'night';

export const GENERATED_AVATAR_STYLES: GeneratedAvatarStyle[] = ['a', 'b', 'c'];
export const DEFAULT_GENERATED_AVATAR_STYLE: GeneratedAvatarStyle = 'a';

export interface GeneratedAvatarImageOptions {
  displayName?: string;
  accentColor?: string;
  size?: number;
  style?: GeneratedAvatarStyle;
  themeSeed?: GeneratedAvatarThemeSeed;
}

export const normalizeGeneratedAvatarStyle = (value?: string | null): GeneratedAvatarStyle => {
  return GENERATED_AVATAR_STYLES.includes(value as GeneratedAvatarStyle)
    ? value as GeneratedAvatarStyle
    : DEFAULT_GENERATED_AVATAR_STYLE;
};

// 拉丁名取首字母大写（多词取前两个词的首字母），其他文字取首字。
const normalizeDisplayText = (value?: string) => {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return '匿';
  }
  const first = Array.from(trimmed)[0];
  if (/^[A-Za-z0-9]$/.test(first)) {
    const words = trimmed.split(/[\s_\-.·]+/).filter(Boolean);
    const second = words.length > 1 ? Array.from(words[1])[0] : '';
    return (/^[A-Za-z0-9]$/.test(second) ? first + second : first).toUpperCase();
  }
  return first;
};

const hashText = (value: string) => {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.codePointAt(0) || 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

const readCssVar = (name: string) => {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return '';
  }
  return window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
};

const parseCssColor = (value: string): [number, number, number] | null => {
  const text = value.trim();
  const hex = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6})(?:[0-9a-f]{2})?$/i);
  if (hex) {
    const raw = hex[1].length === 3 ? hex[1].split('').map(ch => ch + ch).join('') : hex[1];
    return [0, 2, 4].map(offset => parseInt(raw.slice(offset, offset + 2), 16)) as [number, number, number];
  }
  const rgb = text.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  if (rgb) {
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  }
  return null;
};

const hueFromRgb = ([r, g, b]: [number, number, number]) => {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (!delta) {
    return null;
  }
  let hue = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  hue *= 60;
  return Math.round(hue + 360) % 360;
};

// 以页面实际背景色的亮度判断深浅，兼容自定义主题；读不到时回退到日夜设置。
export const resolveGeneratedAvatarTone = (themeSeed?: GeneratedAvatarThemeSeed): GeneratedAvatarTone => {
  const background = parseCssColor(readCssVar('--sc-bg-surface'))
    || parseCssColor(readCssVar('--sc-bg-elevated'));
  if (background) {
    const [r, g, b] = background.map(channel => channel / 255);
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return luminance < 0.5 ? 'night' : 'day';
  }
  return themeSeed?.palette === 'day' ? 'day' : 'night';
};

const resolveHue = (displayName: string, accentColor?: string) => {
  const parsed = accentColor ? parseCssColor(accentColor) : null;
  const hue = parsed ? hueFromRgb(parsed) : null;
  return hue ?? hashText(displayName) % 360;
};

// 黄绿色区间感知亮度高，压低明度以保证白字可读。
const isBrightHue = (hue: number) => hue >= 40 && hue <= 190;

interface StyleColors {
  background: string;
  text: string;
  pattern?: string;
  textShadow?: string;
}

const resolveStyleColors = (style: GeneratedAvatarStyle, tone: GeneratedAvatarTone, hue: number): StyleColors => {
  const bright = isBrightHue(hue);
  if (style === 'b') {
    return tone === 'night'
      ? { background: `hsl(${hue} 38% 22%)`, text: `hsl(${hue} 75% 78%)` }
      : { background: `hsl(${hue} 70% 91%)`, text: `hsl(${hue} 55% ${bright ? 26 : 34}%)` };
  }
  if (style === 'c') {
    return tone === 'night'
      ? { background: `hsl(${hue} 35% 20%)`, pattern: `hsla(${hue}, 55%, 52%, 0.38)`, text: '#ffffff', textShadow: 'rgba(0, 0, 0, 0.5)' }
      : { background: `hsl(${hue} 60% 90%)`, pattern: `hsla(${hue}, 55%, 55%, 0.32)`, text: `hsl(${hue} 50% ${bright ? 20 : 26}%)` };
  }
  return tone === 'night'
    ? { background: `hsl(${hue} 42% ${bright ? 34 : 40}%)`, text: `hsl(${hue} 60% 96%)` }
    : { background: `hsl(${hue} 55% ${bright ? 40 : 50}%)`, text: '#ffffff' };
};

const createCanvas = (size: number) => {
  if (typeof document === 'undefined') {
    return null;
  }
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas;
};

// 5x5 左右对称格子图案，由名字决定。
const drawPattern = (ctx: CanvasRenderingContext2D, size: number, seed: number, color: string) => {
  const cell = size / 5;
  ctx.fillStyle = color;
  for (let row = 0; row < 5; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      if (!((seed >>> (row * 3 + col)) & 1)) {
        continue;
      }
      ctx.fillRect(col * cell, row * cell, cell, cell);
      if (col < 2) {
        ctx.fillRect((4 - col) * cell, row * cell, cell, cell);
      }
    }
  }
};

const renderAvatarCanvas = (options: GeneratedAvatarImageOptions) => {
  const size = Math.max(64, Math.min(512, Math.round(options.size || 128)));
  const canvas = createCanvas(size);
  if (!canvas) {
    return null;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return null;
  }
  const displayName = String(options.displayName || '').trim();
  const style = normalizeGeneratedAvatarStyle(options.style);
  const tone = resolveGeneratedAvatarTone(options.themeSeed);
  const hue = resolveHue(displayName, String(options.accentColor || '').trim());
  const colors = resolveStyleColors(style, tone, hue);
  const text = normalizeDisplayText(displayName);

  // 铺满方形，圆角交给头像容器（用户可设置头像圆角）。
  ctx.fillStyle = colors.background;
  ctx.fillRect(0, 0, size, size);
  if (colors.pattern) {
    drawPattern(ctx, size, hashText(`${displayName}#pattern`), colors.pattern);
  }

  const fontFamily = readCssVar('--sc-font-family') || 'sans-serif';
  const fontSize = text.length > 1 ? size * 0.38 : size * 0.46;
  ctx.font = `600 ${fontSize}px ${fontFamily}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (colors.textShadow) {
    ctx.shadowColor = colors.textShadow;
    ctx.shadowBlur = size * 0.04;
    ctx.shadowOffsetY = size * 0.015;
  }
  ctx.fillStyle = colors.text;
  ctx.fillText(text, size / 2, size / 2 + size * 0.02);

  return canvas;
};

export const buildGeneratedAvatarDataUrl = (options: GeneratedAvatarImageOptions) => {
  const canvas = renderAvatarCanvas(options);
  return canvas ? canvas.toDataURL('image/png') : '';
};

export const buildGeneratedAvatarFile = async (options: GeneratedAvatarImageOptions, filename = 'generated-avatar.png') => {
  const canvas = renderAvatarCanvas(options);
  if (!canvas) {
    throw new Error('生成头像失败');
  }
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => {
      if (value) {
        resolve(value);
        return;
      }
      reject(new Error('生成头像失败'));
    }, 'image/png', 0.92);
  });
  return new File([blob], filename, { type: 'image/png' });
};
