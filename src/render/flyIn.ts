/**
 * 录入的飞入动画。
 *
 * 🔴 为什么要"影子交接"而不是直接动画真泡泡：
 *    真泡泡住在 #world 里，那个容器已经被 `translate(tx,ty) scale(scale)` 变换过，
 *    而力导向每帧还在写它自己的 `translate3d(x,y,0)`。再给它叠一条 offsetPath，
 *    路径会被这两层变换二次扭曲 —— 弧线会变形，位置也对不上。
 *    做法是：在 body 下的固定图层里造一个**像素一致的影子**，让它走弧线，
 *    走完销毁影子，再在 #world 里建真泡泡并播落定动画。
 *
 * 🔴 为什么用 WAAPI 而不是 requestAnimationFrame：
 *    WAAPI 的动画跑在**合成线程**，主线程此时可以继续跑力导向 —— 而力导向正在
 *    为"新泡泡要落在哪"做几十次迭代。用 rAF 手动插值会跟力导向抢主线程，
 *    结果是飞入过程掉帧。这是本文件选 WAAPI 的全部理由。
 *
 * 🔴 `offset-path` 的 path() 坐标是**视口绝对坐标**（配合 left/top: 0），
 *    不是相对元素的位移。第一次写必然会以为它是相对的，然后发现整条弧线
 *    偏移了一个屏幕的距离。见 test/anim.ts 里对 path 字符串的断言。
 */

import { lineHeight, radiusOfCached } from '../text';
import type { Vec } from '../types';

/** 飞入总时长（ms）。见底部"时长依据"注释。 */
export const FLY_MS = 540;

/** 落定"啵"的时长（ms）。 */
export const POP_MS = 240;

/** 弧线的抬升高度范围（视口 px）。 */
export const ARC_LIFT_MIN = 60;
export const ARC_LIFT_MAX = 120;

/** 涟漪扩散到多大。 */
export const RIPPLE_SCALE = 2.2;

/** 落定动画的停靠点。改这几个数就能调全身手感，别散落到别处。 */
export const POP_START = 0.15;
export const POP_OVERSHOOT = 1.22;
export const POP_UNDERSHOOT = 0.92;
export const POP_SETTLE = 1.05;

/** 首屏装配时用的"轻"落定：不制造"刚记下"的错觉，但要有一点生命感。 */
export const POP_LOAD_START = 0.72;

const FX_ID = 'nebula-fx';

// ─────────────────────────────────────────────────────────────
// 纯函数（可脱离浏览器测试）
// ─────────────────────────────────────────────────────────────

/**
 * 二次贝塞尔的控制点：起终点中点，再朝上抬 `lift` px。
 *
 * 🔴 屏幕上 y 向下增大，所以"向上抬"是**减去** lift。这里写反了弧线就会往下兜。
 */
export function arcControlPoint(from: Vec, to: Vec, lift: number): Vec {
  return {
    x: (from.x + to.x) / 2,
    y: (from.y + to.y) / 2 - lift,
  };
}

/** 生成 offset-path 用的 path() 字符串。坐标是视口绝对坐标。 */
export function pathDataFor(from: Vec, control: Vec, to: Vec): string {
  const r = (n: number): number => Math.round(n * 100) / 100;
  return `path("M ${r(from.x)} ${r(from.y)} Q ${r(control.x)} ${r(control.y)} ${r(to.x)} ${r(to.y)}")`;
}

/** 落定"啵"的 keyframes。多停靠点才能做出两次过冲，单靠 easing 做不到。 */
export function popKeyframes(
  start = POP_START,
  overshoot = POP_OVERSHOOT,
  undershoot = POP_UNDERSHOOT,
  settle = POP_SETTLE,
): Keyframe[] {
  const scale = (s: number): Keyframe => ({ transform: `scale(${s})` });
  return [
    { ...scale(start), offset: 0 },
    { ...scale(overshoot), offset: 0.42 },
    { ...scale(undershoot), offset: 0.68 },
    { ...scale(settle), offset: 0.86 },
    { ...scale(1), offset: 1 },
  ];
}

/** 首屏装配用的轻落定。 */
export function loadPopKeyframes(): Keyframe[] {
  return [
    { transform: `scale(${POP_LOAD_START})`, opacity: '0', offset: 0 },
    { transform: 'scale(1.04)', opacity: '1', offset: 0.7 },
    { transform: 'scale(1)', opacity: '1', offset: 1 },
  ];
}

/** 涟漪的 keyframes。 */
export function rippleKeyframes(): Keyframe[] {
  return [
    { transform: 'scale(0.6)', opacity: '1', offset: 0 },
    { transform: `scale(${RIPPLE_SCALE})`, opacity: '0', offset: 1 },
  ];
}

/** 尊重系统的"减少动态效果"。 */
export function prefersReducedMotion(): boolean {
  return (
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

// ─────────────────────────────────────────────────────────────
// DOM 部分
// ─────────────────────────────────────────────────────────────

/** 飞入用的固定图层（影子 + 涟漪）。挂在 body 下，不受 #world 的变换影响。 */
function ensureFxLayer(): HTMLElement {
  const existing = document.getElementById(FX_ID);
  if (existing) return existing;

  const layer = document.createElement('div');
  layer.id = FX_ID;
  layer.className = 'fx-layer';
  document.body.appendChild(layer);
  return layer;
}

/**
 * 造一个和真泡泡**像素一致**的影子。
 *
 * 复用完全相同的 class 与内联尺寸，所以 --accent 一类的主题变量、
 * 字号、圆角、描边全都自动一致 —— 交接时才不会"闪一下"。
 * 唯一不同的是定位方式：影子用 offset-path 走弧线。
 *
 * ⚠️ 因为它带着 `.bubble--idea` 类，**查询真泡泡时必须排除 `.bubble--shadow`**，
 *    否则会把飞行中的影子也数进去（冒烟测试上踩过一次）。
 */
function buildShadow(text: string, rx: number, ry: number): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'bubble bubble--idea bubble--shadow';
  el.dataset.role = 'shadow';
  el.style.width = `${rx * 2}px`;
  el.style.height = `${ry * 2}px`;

  const scale = document.createElement('div');
  scale.className = 'bubble-scale';

  const inner = document.createElement('div');
  inner.className = 'bubble-inner';
  // 行数限制和真泡泡一致（用同一个 lineHeight 计算），避免半路文字换行不一致
  const lines = Math.max(1, Math.floor((2 * ry - 12) / lineHeight()));
  inner.style.setProperty('--lines', String(lines));

  const label = document.createElement('div');
  label.className = 'bubble-label';
  // 🔴 一律 textContent
  label.textContent = text;

  inner.appendChild(label);
  scale.appendChild(inner);
  el.appendChild(scale);
  return el;
}

/** 起一个涟漪。 */
function spawnRipple(at: Vec): void {
  const layer = ensureFxLayer();
  const el = document.createElement('div');
  el.className = 'ripple';
  el.style.left = `${at.x}px`;
  el.style.top = `${at.y}px`;

  layer.appendChild(el);
  const anim = el.animate(rippleKeyframes(), {
    duration: 460,
    easing: 'cubic-bezier(.2,.7,.4,1)',
  });
  anim.finished
    .catch(() => undefined)
    .then(() => el.remove());
}

/** 一次飞行的几何记录，供自动化测试核对"影子落点 == 真泡泡落点"。 */
export interface FlightRecord {
  from: Vec;
  control: Vec;
  to: Vec;
  /** 影子走到终点时，它的中心实测在视口的哪个位置。 */
  shadowEnd: Vec | null;
  /**
   * 真泡泡被创建的那一刻，它在视口里的中心。
   *
   * 🔴 由调用方在创建完真泡泡后立刻填上。为什么非要"那一刻"：
   *    落定之后力场马上开始推它，隔哪怕 100ms 再测，位置就已经飘了十几像素 ——
   *    那样测出来的是"力场推了多远"，不是"交接有没有跳"。
   */
  landedAt: Vec | null;
}

let lastFlight: FlightRecord | null = null;

export function getLastFlight(): FlightRecord | null {
  return lastFlight;
}

export interface FlyInRequest {
  text: string;
  /** 起点：输入框中心（视口坐标）。 */
  from: Vec;
  /** 终点：这个泡泡最终会落在的屏幕位置（视口坐标）。 */
  to: Vec;
  /** 弧线抬升高度。不传则取 [ARC_LIFT_MIN, ARC_LIFT_MAX] 的中间值。 */
  lift?: number;
}

/**
 * 把一个泡泡"扔"进星云。
 *
 * 结束后**不**负责建真泡泡 —— 那是调用方的事（它才知道该往哪个空间、哪个 body 里放）。
 */
export async function flyIn(req: FlyInRequest): Promise<FlightRecord> {
  const { text, from, to } = req;
  const { rx, ry } = radiusOfCached(text);

  const lift =
    req.lift ?? ARC_LIFT_MIN + (ARC_LIFT_MAX - ARC_LIFT_MIN) * 0.5;
  const control = arcControlPoint(from, to, lift);

  const record: FlightRecord = { from, control, to, shadowEnd: null, landedAt: null };
  lastFlight = record;

  // 系统要求减少动态效果 ⇒ 不发弧线，只留涟漪
  if (prefersReducedMotion()) {
    spawnRipple(to);
    record.shadowEnd = { ...to };
    return record;
  }

  const layer = ensureFxLayer();
  const shadow = buildShadow(text, rx, ry);
  shadow.style.offsetPath = pathDataFor(from, control, to);
  layer.appendChild(shadow);

  const anim = shadow.animate(
    [{ offsetDistance: '0%' }, { offsetDistance: '100%' }],
    {
      duration: FLY_MS,
      easing: 'cubic-bezier(.3,.1,.35,1)',
      // 🔴 必须 fill: 'forwards'。默认的 'none' 会在动画一结束就把 offset-distance
      //    弹回基础值（0%），于是"影子已经飞到了"这件事在测量时根本看不到 ——
      //    实测表现为落点与终点差了整整一个飞行距离（694px）。
      //    这里加 fill 是安全的：影子下一行就被销毁，不存在"fill 压住 hover"的问题。
      fill: 'forwards',
    },
  );

  try {
    await anim.finished;
  } catch {
    // 动画被取消（例如页面切走）也要继续往下走，不能把泡泡丢了
  }

  // 记录影子最终落在哪 —— 自动化测试靠它验证"影子落点 == 真泡泡落点"
  const rect = shadow.getBoundingClientRect();
  record.shadowEnd = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };

  shadow.remove();
  spawnRipple(to);

  return record;
}

/**
 * 给某个泡泡播落定动画。
 *
 * 🔴 用 WAAPI 且**不加 fill**：动画结束后属性回到 CSS 的值，
 *    悬停的 `scale(1.04)` 才能自然生效。如果加了 fill: 'both'，
 *    动画的最终值会一直压住 hover（这个坑阶段 2 踩过一次）。
 */
export function playPop(scaleEl: HTMLElement, light = false, delay = 0): void {
  if (prefersReducedMotion()) return;
  const frames = light ? loadPopKeyframes() : popKeyframes();
  const anim = scaleEl.animate(frames, {
    duration: light ? 260 : POP_MS,
    delay,
    easing: 'linear',
    // 🔴 必须用 'backwards' 而不是 'both'：
    //    'both' 会连**结束值**也保留下来，于是动画结束后它一直压着 hover 的 transform，
    //    悬停就永久失效（阶段 2 踩过这个坑）。
    //    'backwards' 只在 delay 期间保留起始值（否则带 delay 的首屏装配会先闪一下全尺寸），
    //    结束后一切交还给 CSS。
    fill: 'backwards',
  });
  anim.finished.catch(() => undefined);
}

/*
 * ── 时长依据（回答"飞入总时长定多少、依据是什么"）──────────────
 *
 * FLY_MS = 540：
 *  · 60fps 下约 32 帧。弧线要有"抛出去"的读感，至少要二十几帧；低于 300ms
 *    弧线会变成一条直线，看不出是抛。
 *  · 加上落定的 POP_MS(240) 总感知约 780ms。体验研究里大致有这么条界线：
 *    轻量反馈动画超过 ~800ms 就会被感知成"在等它"。780 刚好压在下面。
 *  · 再长的代价是录制节奏：用户在"想到就记"的连续输入里，每条都要等接近一秒
 *    才看到它落定。
 *
 * RIPPLE 460ms：比落定稍长，让余韵盖住落定的尾巴，而不是同时结束。
 *
 * ⚠️ 这几个数是**由动效惯例推出来的起点，不是实测调好的值**。
 *    真正该由你眼睛定的是 FLY_MS 与 POP_OVERSHOOT 这两个。
 */
