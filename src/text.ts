/**
 * 文本规范化、排版测量与搜索打分。
 *
 * 这个文件里有两类东西，请分清：
 *  ① 纯函数（norm / clampText / ellipseFromMeasurement / scoreMatch）—— 可在 Node 里直接测
 *  ② 依赖 DOM 的函数（measureText / radiusOf）—— 需要 canvas，只能在浏览器里跑
 * 刻意这样切分，是为了让最需要回归测试的排版数学不依赖浏览器环境。
 */

import { MAX_TEXT } from './types';

/**
 * 🔴 全项目字体的唯一真相来源。
 *
 * canvas 测量和 CSS 渲染必须共用这一个字符串 —— 任何地方再写第二份字体栈
 * 字面量，测量结果就会和实际渲染对不上，椭圆的宽高就全错了。
 * CSS 侧通过 `styles.css` 里的 `--font-stack` 引用同一个值。
 *
 * 🔴 刻意不使用自定义 webfont：字体加载失败时浏览器会 fallback 到别的字体，
 *    度量随之改变，所有已缓存的尺寸立刻失效（表现是"刷新一次排版就变样"）。
 *    宁可牺牲一点排版品味，也要保证测量永远准确。
 */
export const FONT_STACK =
  '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Source Han Sans SC", "Noto Sans CJK SC", system-ui, -apple-system, "Segoe UI", sans-serif';

/** 泡泡内文字的基础字号（CSS px）。 */
export const FONT_SIZE = 13;

/** 行高比例。中文需要比西文宽松一些才不显拥挤。 */
const LINE_HEIGHT_RATIO = 1.45;

/** 椭圆尺寸的上下限（指 rx，横向半径）。 */
export const MIN_RADIUS = 26;
export const MAX_RADIUS = 78;

/** 椭圆内文字与边缘的留白。 */
const PAD_X = 22;
const PAD_Y = 18;

/** 单行排版的绝对下限，防止收敛时把宽度压到无法阅读。 */
const MIN_LINE_CAP = 56;

/** 比例约束：1:1（正圆）~ 2:1（扁椭圆）。 */
const MIN_ASPECT = 1;
const MAX_ASPECT = 2;

/** 单行可用宽度上限 —— 由 MAX_RADIUS 反推，保证文字永不超出椭圆。 */
const CAP_MAX = 2 * (MAX_RADIUS - PAD_X);

/** 行高（px）。 */
export function lineHeight(): number {
  return Math.round(FONT_SIZE * LINE_HEIGHT_RATIO);
}

// ─────────────────────────────────────────────────────────────
// ① 纯函数
// ─────────────────────────────────────────────────────────────

/**
 * 规范化用户输入：统一换行符、去掉行尾空白、压缩连续空行、去首尾空白。
 * 注意这里不做长度限制，长度交给 clampText。
 */
export function norm(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 按上限截断。
 *
 * 返回 clipped 标记，让调用方能提示"已截断"，而不是默默吃掉用户的字。
 * 长度按 UTF-16 code unit 计（中文常用字 1 个、emoji 2 个）。
 */
export function clampText(s: string, max: number = MAX_TEXT): { text: string; clipped: boolean } {
  if (s.length <= max) return { text: s, clipped: false };

  let cut = s.slice(0, Math.max(0, max - 1));
  // 🔴 防止把代理对（emoji 等）从中间劈开，留下一个孤立的高代理字符
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);

  return { text: cut.trimEnd() + '…', clipped: true };
}

/** 排版测量结果。 */
export interface Measured {
  /** 最宽一行的宽度。 */
  w: number;
  /** 全部行加起来的高度。 */
  h: number;
  /** 逐行内容，用于调试与测试。 */
  lines: string[];
}

/** 椭圆尺寸。rx === ry 时就是正圆。 */
export interface EllipseSize {
  rx: number;
  ry: number;
}

/**
 * 由「测量结果」推导椭圆尺寸。**纯函数，是排版数学的核心，重点测这个。**
 *
 * 🔴 为什么是椭圆不是正圆：正圆里塞中文短文本是排版灾难 —— 圆内某一行的
 *    可用宽度随纵向位置急剧收缩，三行字就把圆填满，上半部分全是空白，
 *    而且字还会有被圆边切掉的风险。椭圆能让文字横向铺开、纵向收紧，一眼能扫。
 *
 * 形状规则（结果永远是一个椭圆，"正圆"只是比例为 1:1 的特例）：
 *  - 比例被夹在 1:1 ~ 2:1 之间：太扁就缩宽，太高就压成圆
 *  - 尺寸被夹在 [MIN_RADIUS, MAX_RADIUS]
 */
export function ellipseFromMeasurement(
  m: Measured,
  textLength: number,
  minR: number = MIN_RADIUS,
  maxR: number = MAX_RADIUS,
): EllipseSize {
  // 外接矩形 → 半径
  let rx = m.w / 2 + PAD_X;
  let ry = m.h / 2 + PAD_Y;

  // 椭圆上下两端是尖的，横向有效宽度小于外接矩形，所以横向收一点，
  // 让文字不顶着椭圆的边。
  rx *= 0.96;
  ry *= 0.98;

  // 先夹比例：保证形状不会扁成一条线、也不会竖成一根柱
  let aspect = rx / ry;
  if (aspect > MAX_ASPECT) aspect = MAX_ASPECT;
  else if (aspect < MIN_ASPECT) aspect = MIN_ASPECT;

  // 以 rx 为尺度基准，再按比例还原 ry —— 这样夹尺寸不会破坏比例
  let w = clampNumber(rx, minR, maxR);
  let h = w / aspect;
  if (h > maxR) {
    h = maxR;
    w = h * aspect;
  }
  if (h < minR * 0.7) {
    h = minR * 0.7;
    w = h * aspect;
  }

  // 很短的单行文本（≤4 字）强制正圆，视觉上更像"一颗珠子"
  if (m.lines.length <= 1 && textLength <= 4) {
    const r = clampNumber(Math.max(w, h), minR, maxR);
    return { rx: r, ry: r };
  }

  return { rx: w, ry: h };
}

function clampNumber(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ─────────────────────────────────────────────────────────────
// ② 依赖 DOM 的函数
// ─────────────────────────────────────────────────────────────

/** 离屏测量上下文。整个模块只创建一次，重复 getContext 没有必要。 */
let measureCtx: CanvasRenderingContext2D | null = null;

function getMeasureCtx(): CanvasRenderingContext2D {
  if (measureCtx) return measureCtx;

  if (typeof document === 'undefined') {
    throw new Error('measureText 需要 canvas（浏览器环境）。Node 里请直接测 ellipseFromMeasurement。');
  }

  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const got = canvas.getContext('2d');
  if (!got) throw new Error('无法创建 canvas 2d 上下文');
  got.font = `${FONT_SIZE}px ${FONT_STACK}`;
  measureCtx = got;
  return got;
}

/**
 * 按给定宽度上限测量文本。
 *
 * 🔴 自己逐字换行，不用 canvas 的自动换行：中文没有空格，而 canvas 的
 *    fillText 不做断行。逐字累加宽度是最贴近真实排版的做法。
 *    西文单词会被从中间断掉 —— 这是为中文场景做的取舍，可接受。
 */
function measureWithCap(text: string, cap: number): Measured {
  const ctx = getMeasureCtx();
  const lh = lineHeight();
  const lines: string[] = [];

  for (const paragraph of text.split('\n')) {
    if (paragraph === '') {
      lines.push('');
      continue;
    }
    let cur = '';
    for (const ch of paragraph) {
      const test = cur + ch;
      if (cur !== '' && ctx.measureText(test).width > cap) {
        lines.push(cur);
        cur = ch;
      } else {
        cur = test;
      }
    }
    if (cur !== '') lines.push(cur);
  }

  let w = 1;
  for (const line of lines) {
    const lineW = ctx.measureText(line).width;
    if (lineW > w) w = lineW;
  }

  return { w, h: Math.max(1, lines.length) * lh, lines };
}

/** 按默认宽度上限测量文本。 */
export function measureText(text: string): Measured {
  return measureWithCap(text, CAP_MAX);
}

/**
 * 由文本推导泡泡的椭圆尺寸。
 *
 * 这里有一个真实的循环依赖：椭圆的横向可用宽度由 rx 决定，而 rx 又由
 * "按某个宽度上限换行后的最宽行"决定。所以做两轮：
 *   第一轮用 CAP_MAX 测量 → 得到 rx
 *   第二轮让 rx 反过来决定可用宽度 → 重新测量
 *
 * 🔴 安全前提（关键）：第二轮的可用宽度**不得小于上一轮最宽的那一行**。
 *    否则会因为"凭空多出一个换行"把泡泡越撑越高，文字被挤成竖条 ——
 *    这是这类迭代最容易踩的坑。加上这个下界后，换行结果必然不变，
 *    迭代在第二轮就收敛（不是靠运气，是可证明的）。
 */
export function radiusOf(
  text: string,
  minR: number = MIN_RADIUS,
  maxR: number = MAX_RADIUS,
): EllipseSize {
  const safe = text.length === 0 ? ' ' : text;

  let cap = CAP_MAX;
  let m = measureWithCap(safe, cap);
  let size = ellipseFromMeasurement(m, safe.length, minR, maxR);

  for (let pass = 0; pass < 2; pass++) {
    const implied = 2 * (size.rx - PAD_X);
    const lowerBound = Math.max(m.w, MIN_LINE_CAP); // 🔴 安全下界，见上
    const nextCap = clampNumber(implied, lowerBound, CAP_MAX);

    if (Math.abs(nextCap - cap) < 4) break; // 已收敛

    cap = nextCap;
    m = measureWithCap(safe, cap);
    size = ellipseFromMeasurement(m, safe.length, minR, maxR);
  }

  return size;
}

/** 尺寸缓存。同一段文本永远得到同一尺寸，避免每帧重排。 */
const sizeCache = new Map<string, EllipseSize>();
const SIZE_CACHE_MAX = 2000;

export function radiusOfCached(text: string): EllipseSize {
  const hit = sizeCache.get(text);
  if (hit) return hit;

  const v = radiusOf(text);
  if (sizeCache.size >= SIZE_CACHE_MAX) {
    // 简单 FIFO：丢掉最早插入的一个。命中率本身就很高，不需要 LRU。
    const oldest = sizeCache.keys().next();
    if (!oldest.done) sizeCache.delete(oldest.value);
  }
  sizeCache.set(text, v);
  return v;
}

export function clearSizeCache(): void {
  sizeCache.clear();
}

/** 字体真正加载完成后调用，重置测量上下文。 */
export function remeasureFont(): void {
  if (measureCtx) measureCtx.font = `${FONT_SIZE}px ${FONT_STACK}`;
}

/**
 * 把 FONT_STACK / FONT_SIZE 注入成 CSS 变量。
 *
 * 🔴 这是"唯一真相来源"的落地方式：字体栈字面量只存在于本文件，
 *    CSS 里用 `font-family: var(--font-stack)` 引用。启动时由 main.ts 调用一次。
 *    若改成在 styles.css 里再写一遍字体栈，两份迟早漂移，
 *    而漂移的表现是"排版偶尔不对"——极难排查。
 */
export function installFontStackVar(): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.style.setProperty('--font-stack', FONT_STACK);
  root.style.setProperty('--font-size', `${FONT_SIZE}px`);
  // CSS 变量注入后测量上下文里的字体可能已变，需要重新校准
  remeasureFont();
}

// ─────────────────────────────────────────────────────────────
// 搜索打分
// ─────────────────────────────────────────────────────────────

const SCORE_EXACT = 1000;
const SCORE_PREFIX = 500;
const SCORE_SUBSTRING = 200;
const SCORE_POSITION_PENALTY_MAX = 150;
const SCORE_CHARSET_MAX = 20;

/**
 * 搜索打分。0 表示不命中。
 *
 * 权重梯度：完全相等 > 前缀命中 > 子串命中 > 字符集重叠。
 *
 * 🔴 之所以要有"字符集重叠"这一档：用户想搜"凌晨三点"，可能只记得
 *    "三"和"凌"，打出来是"三凌"——顺序不对，indexOf 找不到。这时按
 *    字符集重叠给一个低分，仍然能把它捞出来。这正是这个项目"不想错过
 *    任何想法"在搜索上的体现。
 *
 * 刻意不建倒排索引：几百条纯短文本一次扫完 <0.1ms，索引换不回成本，
 * 反而引入"索引与原文不一致"一整类 bug。
 */
export function scoreMatch(text: string, query: string): number {
  if (query === '') return 0;

  const t = text.toLowerCase();
  const q = query.toLowerCase();

  if (t === q) return SCORE_EXACT;
  if (t.startsWith(q)) return SCORE_PREFIX;

  const at = t.indexOf(q);
  if (at >= 0) {
    // 越靠前分越高，但都低于前缀命中
    return SCORE_SUBSTRING - Math.min(SCORE_POSITION_PENALTY_MAX, at);
  }

  const chars = new Set<string>();
  for (const ch of q) chars.add(ch);
  if (chars.size === 0) return 0;

  let hit = 0;
  for (const ch of chars) {
    if (t.includes(ch)) hit++;
  }
  if (hit === 0) return 0;

  return (hit / chars.size) * SCORE_CHARSET_MAX;
}
