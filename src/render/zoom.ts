/**
 * 点击放大到屏幕中央（FLIP）。
 *
 * FLIP 四步：First 记录当前 rect → Last 算目标 rect → Invert 施加反向变换
 * → Play 用 WAAPI 过渡到 identity。
 *
 * 🔴 为什么必须"目标框与源框长宽比一致"（对应需求"放大态形状必须和源同档"）：
 *    FLIP 的精髓是**用一个均匀缩放把源框映射到目标框**。如果两者长宽比不同，
 *    就只剩两条路：非等比缩放（文字会被压扁拉长，很丑），或者逐帧改 width/height
 *    （违反项目的"动画只准动 transform"规矩）。
 *    所以这里把目标框定义成"源框乘以同一个倍数"，长宽比天然相同 ——
 *    等比缩放于是**精确**成立，形状不可能歪。
 *    "圆 vs 卡片"的区别只体现在圆角与是否放开文字行数，不体现在长宽比。
 *
 * 🔴 为什么用克隆体而不是直接动画真泡泡：
 *    真泡泡住在被 translate+scale 变换过的 #world 里，把它拿出来做 FLIP 会先
 *    经历一次坐标系跳变；而且它每帧被力导向写 transform。克隆到 body 下的固定图层
 *    里动画，真泡泡只需暂时隐藏，收回时原地复活，位置分毫不动。
 */

import { FONT_SIZE, shapeOf } from '../text';
import type { Rect, Vec } from '../types';

/** 放大动画时长（ms）。 */
export const ZOOM_IN_MS = 320;
export const ZOOM_OUT_MS = 220;

/** 放大后允许占用的最大尺寸（视口 px / 比例）。 */
export const ZOOM_MAX_W = 620;
export const ZOOM_MAX_H = 0.62;

/** 一个很小的泡泡最多放大多少倍 —— 否则"水"一个字会被放到糊满屏幕。 */
export const ZOOM_MAX_SCALE = 3.4;

/** 放大态字号的上下限。 */
export const ZOOM_MAX_FONT = FONT_SIZE * ZOOM_MAX_SCALE;
export const ZOOM_MIN_FONT = 13;

/** 中文正文的行高比例，和 styles.css 的 .bubble-inner 保持一致。 */
const LINE_HEIGHT_RATIO = 1.45;

const ZOOM_ID = 'nebula-zoom';

// ─────────────────────────────────────────────────────────────
// 纯函数（可脱离浏览器测试）
// ─────────────────────────────────────────────────────────────

export interface ZoomFit {
  maxW: number;
  maxH: number;
  maxScale: number;
}

/** 放大倍数：刚好塞进可用区域，但不小于 1、不超过 maxScale。 */
export function zoomScaleFor(src: Rect, fit: ZoomFit): number {
  if (src.w <= 0 || src.h <= 0) return 1;
  const byFit = Math.min(fit.maxW / src.w, fit.maxH / src.h);
  return Math.max(1, Math.min(fit.maxScale, byFit));
}

/** 目标框：与源框**同一个倍数**放大后居中。长宽比因此必然一致。 */
export function zoomTargetRect(src: Rect, scale: number, viewport: { w: number; h: number }): Rect {
  const w = src.w * scale;
  const h = src.h * scale;
  return { x: (viewport.w - w) / 2, y: (viewport.h - h) / 2, w, h };
}

export interface ZoomTransform {
  /** 克隆体本地的 transform-origin（px，相对克隆体左上角）。 */
  origin: Vec;
  /** 起始 transform 的位移部分（px）。 */
  start: Vec;
  /** 起始缩放倍数（< 1）。 */
  k: number;
  /** 起始 transform 的完整字符串。 */
  startTransform: string;
}

/**
 * 算出 FLIP 的 Invert 步骤。
 *
 * 目标：起始状态下克隆体**与源泡泡完全重合**，并且缩放的锚点落在
 * "指针点击的位置"上 —— 这样放大看起来是"朝你手指的方向撑开"。
 *
 * 数学（transform-origin 为 O、transform 为 translate(T) scale(k) 时，
 * 本地点 p 映射到 T0 + O + T + k·(p − O)，T0 是克隆体左上角）：
 *   · 让本地点 O 映射到指针 ⇒ T = pointer − T0 − O·(1−k)
 *   · 让克隆体盒子映射回源框 ⇒ k = srcW / targetW
 *   · 让 O 对应源框上被点的那个点 ⇒ O = (pointer − src.topLeft) / k
 * 三条合起来就是下面这几行。
 */
export function computeZoomTransform(src: Rect, target: Rect, pointer: Vec): ZoomTransform {
  const k = target.w > 0 ? src.w / target.w : 1;

  const ox = (pointer.x - src.x) / k;
  const oy = (pointer.y - src.y) / k;

  const tx = src.x - target.x - ox * (1 - k);
  const ty = src.y - target.y - oy * (1 - k);

  return {
    origin: { x: ox, y: oy },
    start: { x: tx, y: ty },
    k,
    startTransform: `translate(${round(tx)}px, ${round(ty)}px) scale(${round(k, 5)})`,
  };
}

function round(n: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** 放大态的圆角：圆档用 50%，卡片档用圆角矩形。 */
export function zoomRadiusFor(shape: 'circle' | 'card', target: Rect): string {
  return shape === 'circle' ? '50%' : `${Math.round(Math.min(target.w, target.h) * 0.12)}px`;
}

/**
 * 放大态的字号。三条约束同时成立，取最紧的那个：
 *
 *  ① **不超过按比例放大的字号** `FONT_SIZE × scale` ——
 *     短文本（圆档）时它恰好取到这个值，于是克隆体起始渲染出来的字
 *     和源泡泡**逐像素一致**，交接不闪。
 *  ② **不超过上限** —— 否则"水"一个字会被放大成糊满屏幕的巨字。
 *  ③ **保证全文塞得进目标框**。
 *
 * 🔴 ③ 的做法是**枚举行数**而不是用面积反推。
 *    一开始我写的是 `字号 ≈ √(框面积 / (1.45 × 字数))`（把正文当成一个铺满的矩形），
 *    实测发现它偏大：中文换行是逐字断的，最后一行的留白被完全忽略了 ——
 *    40 个字排出来需要 396px 高，而框只有 252px 可用。
 *    改成"对每个可能的行数 L，算出让 L 行同时满足宽与高的最大字号，取其中最大者"，
 *    结果是精确的（L 行 × 每行 ceil(字数/L) 个字，宽度和高度两个约束都能验算）。
 */
export function zoomFontSize(text: string, target: Rect, scale: number): number {
  const len = Math.max(1, text.replace(/\n/g, '').length);
  const usableW = Math.max(8, target.w - 20 * scale);
  const usableH = Math.max(8, target.h - 16 * scale);

  let best = ZOOM_MIN_FONT;
  // 64 行足够覆盖 280 字在最小框里的极端情况；再多的行数只会让字号更小，不影响取最大
  for (let lines = 1; lines <= 64; lines++) {
    const perLine = Math.ceil(len / lines);
    const byWidth = usableW / perLine;
    const byHeight = usableH / (lines * LINE_HEIGHT_RATIO);
    const font = Math.min(byWidth, byHeight);
    if (font > best) best = font;
  }

  const byScale = FONT_SIZE * scale;
  const chosen = Math.min(best, byScale);
  return Math.max(ZOOM_MIN_FONT, Math.min(ZOOM_MAX_FONT, chosen));
}

/** 一次放大的几何记录，供自动化测试核对（尤其"形状没有歪"）。 */
export interface ZoomRecord {
  src: Rect;
  target: Rect;
  pointer: Vec;
  transform: ZoomTransform;
  shape: 'circle' | 'card';
  scale: number;
}

let lastZoom: ZoomRecord | null = null;

export function getLastZoom(): ZoomRecord | null {
  return lastZoom;
}

/** 算好一次放大需要的全部几何，但不碰 DOM。测试直接调它。 */
export function planZoom(
  src: Rect,
  pointer: Vec,
  viewport: { w: number; h: number },
  text: string,
): ZoomRecord {
  const shape = shapeOf(text);
  const scale = zoomScaleFor(src, {
    maxW: Math.min(ZOOM_MAX_W, viewport.w - 64),
    maxH: viewport.h * ZOOM_MAX_H,
    maxScale: ZOOM_MAX_SCALE,
  });
  const target = zoomTargetRect(src, scale, viewport);
  return { src, target, pointer, transform: computeZoomTransform(src, target, pointer), shape, scale };
}

// ─────────────────────────────────────────────────────────────
// DOM
// ─────────────────────────────────────────────────────────────

export interface OpenZoomOptions {
  text: string;
  /** 源泡泡当前的视口矩形。 */
  srcRect: Rect;
  /** 点击位置（视口坐标）。 */
  pointer: Vec;
  /** 收回时回调（调用方用它把真泡泡显示回来）。 */
  onClose?: () => void;
}

export interface ZoomHandle {
  close(): void;
  readonly isOpen: boolean;
}

function ensureZoomLayer(): HTMLElement {
  const existing = document.getElementById(ZOOM_ID);
  if (existing) return existing;

  const layer = document.createElement('div');
  layer.id = ZOOM_ID;
  layer.className = 'zoom-layer';
  layer.hidden = true;
  document.body.appendChild(layer);
  return layer;
}

/**
 * 造放大态的克隆体。
 *
 * 🔴 内部所有 px 都要乘以 scale：因为起始时整个克隆体被 `scale(k)` 缩小，
 *    只有把字号/内边距也放大 scale 倍，起始渲染出来的观感才和源泡泡**逐像素一致**
 *    （数学上：font·scale·k = font·scale·(srcW/targetW) = font，因为 targetW = srcW·scale）。
 *    漏了这一步，放大动画一开始会"跳一下"（字突然变小再长大）。
 */
function buildClone(text: string, target: Rect, record: ZoomRecord): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'bubble bubble--idea bubble--zoom';
  el.style.left = `${target.x}px`;
  el.style.top = `${target.y}px`;
  el.style.width = `${target.w}px`;
  el.style.height = `${target.h}px`;
  el.style.transformOrigin = `${record.transform.origin.x}px ${record.transform.origin.y}px`;

  const scale = document.createElement('div');
  scale.className = 'bubble-scale';

  const inner = document.createElement('div');
  inner.className = 'bubble-inner';
  inner.style.borderRadius = zoomRadiusFor(record.shape, target);
  inner.style.padding = `${8 * record.scale}px ${10 * record.scale}px`;
  // 放大态就该看到全文，所以放开行数限制
  inner.style.setProperty('--lines', '99');

  const label = document.createElement('div');
  label.className = 'bubble-label';
  label.textContent = text;
  label.style.fontSize = `${zoomFontSize(text, target, record.scale)}px`;

  inner.appendChild(label);
  scale.appendChild(inner);
  el.appendChild(scale);
  return el;
}

/**
 * 打开放大态。返回一个句柄，调用方负责在合适的时候 close()。
 *
 * 收回的三种触发（需求 7）：再点这个放大后的泡泡 / 点空白 / 按 Esc。
 */
export function openZoom(opts: OpenZoomOptions): ZoomHandle {
  const layer = ensureZoomLayer();
  const rect = layer.getBoundingClientRect();
  const viewport = { w: rect.width || window.innerWidth, h: rect.height || window.innerHeight };

  const record = planZoom(opts.srcRect, opts.pointer, viewport, opts.text);
  lastZoom = record;

  const backdrop = document.createElement('div');
  backdrop.className = 'zoom-backdrop';

  const clone = buildClone(opts.text, record.target, record);

  layer.replaceChildren(backdrop, clone);
  layer.hidden = false;
  layer.classList.add('zoom-layer--visible');

  let closed = false;

  /*
   * 🔴 起始状态**不能**写成 `clone.style.transform = 起始值`。
   *    那样这个内联值就成了元素的基础样式，动画（默认 fill: none）一结束，
   *    属性立刻回到它 —— 表现是克隆体永远停在缩小状态、放大根本不会发生
   *    （实测踩过：transform 一直是 matrix(0.294…)，居中偏差 380px）。
   *    正确做法是用 `fill: 'backwards'` 让第一帧在动画开始前就生效，
   *    动画结束后一切交还给基础样式（无 transform = 已放大到目标）。
   */
  const anim = clone.animate(
    [{ transform: record.transform.startTransform }, { transform: 'none' }],
    {
      duration: ZOOM_IN_MS,
      easing: 'cubic-bezier(.2,.85,.3,1.02)',
      fill: 'backwards',
    },
  );
  backdrop.animate([{ opacity: '0' }, { opacity: '1' }], {
    duration: ZOOM_IN_MS,
    easing: 'ease-out',
  }).finished.catch(() => undefined);

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
  };

  function close(): void {
    if (closed) return;
    closed = true;

    document.removeEventListener('keydown', onKeyDown, true);

    const fade = clone.animate(
      [{ transform: 'none' }, { transform: record.transform.startTransform }],
      {
        duration: ZOOM_OUT_MS,
        easing: 'cubic-bezier(.4,0,.7,.4)',
        // 收回时用 'forwards'：动画结束到元素被移除之间有几十毫秒，
        // 不加的话会先弹回全尺寸再消失（闪一下）。
        fill: 'forwards',
      },
    );
    backdrop.animate([{ opacity: '1' }, { opacity: '0' }], {
      duration: ZOOM_OUT_MS,
      easing: 'ease-in',
    });

    fade.finished
      .catch(() => undefined)
      .then(() => {
        layer.classList.remove('zoom-layer--visible');
        layer.hidden = true;
        layer.replaceChildren();
        opts.onClose?.();
      });
  }

  // 再点放大后的泡泡 → 收回（需求 7）
  clone.addEventListener('click', (e) => {
    e.stopPropagation();
    close();
  });
  // 点空白 → 收回
  backdrop.addEventListener('click', close);
  document.addEventListener('keydown', onKeyDown, true);

  anim.finished.catch(() => undefined);

  void anim;

  return {
    close,
    get isOpen() {
      return !closed;
    },
  };
}
