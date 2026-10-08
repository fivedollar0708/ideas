/**
 * 拖拽控制器。
 *
 * 只负责"指针语义"（按下 / 移动 / 松手 / 判定点击还是拖拽 / 估甩出速度），
 * 不碰物理：`onDragStart` 与 `onDrop` 由上层接进力场。
 * 唯一直接改的物理状态是 `body.dragging` —— 因为"谁在拖"只有这里知道，
 * 而且放在这里能保证它**永远被清掉**（松手、取消、异常都在同一条路径上）。
 *
 * 🔴 刻意不使用 `setPointerCapture`：
 *    指针被捕获后，后续的 click / dblclick 兼容事件会被重定向到捕获元素，
 *    于是"双击泡泡锁定"永远收不到事件。改用 window 级 pointermove/pointerup
 *    监听，效果一样（指针移出画布也不丢），但不干扰 click 的目标。
 *
 * 🔴 拖拽开始后必须立刻让引擎停止写这个泡泡的坐标，否则会出现
 *    "压着泡泡一边拖一边抖"。这条由上层的 `body.dragging = true` +
 *    force.ts 的 `isImmovable()` 保证。
 */

import type { Body } from '../physics/force';

/** 一次指针采样。坐标已换算到 world。 */
export interface Sample {
  x: number;
  y: number;
  /** performance.now() */
  t: number;
}

/** 位移阈值（world 单位）。低于它不当作拖拽，避免手抖变成拖动。 */
export const DRAG_THRESHOLD_PX = 8;

/** 点击时长上限（ms）。 */
export const TAP_MAX_MS = 300;

/** 估算甩出速度时只取最近这么久的采样。 */
export const VELOCITY_WINDOW_MS = 90;

/** 保留的采样条数上限。 */
const MAX_SAMPLES = 24;

export type Gesture = 'tap' | 'drag';

/**
 * 纯函数：由采样序列判定这次交互是"点击"还是"拖拽"。
 *
 * 🔴 两个阈值都要看：位移超过 8px，或按住超过 300ms，就不算点击。
 *    前者的意义是"手抖不算拖"，后者的意义是"长按不是点击"。
 *
 * ⚠️ 副作用提示：按这个规则，**一次缓慢的点击（按住 ≥300ms 且几乎没移动）
 *    既不是点击也不是拖拽**，什么都不会发生。阶段 4 要做"点击放大"时，
 *    如果发现"慢慢点一下放大不了"，就是这里 —— 那时把 tapMaxMs 去掉即可。
 */
export function classifyGesture(
  samples: readonly Sample[],
  thresholdPx: number = DRAG_THRESHOLD_PX,
  tapMaxMs: number = TAP_MAX_MS,
): Gesture {
  if (samples.length < 2) return 'tap';

  const first = samples[0];
  const last = samples[samples.length - 1];
  const moved = Math.hypot(last.x - first.x, last.y - first.y);
  const elapsed = last.t - first.t;

  return moved > thresholdPx || elapsed > tapMaxMs ? 'drag' : 'tap';
}

/**
 * 纯函数：由最近一段采样估算甩出速度（world 单位 / 秒）。
 *
 * 🔴 取"最近 90ms"而不是整段历史：用户可能先慢慢拖了很久、最后猛一甩，
 *    用整段算会把速度摊平，甩不出去。只取尾段才能反映"松手那一刻的手速"。
 */
export function velocityFromSamples(
  samples: readonly Sample[],
  windowMs: number = VELOCITY_WINDOW_MS,
): { x: number; y: number } {
  if (samples.length < 2) return { x: 0, y: 0 };

  const last = samples[samples.length - 1];
  let first = last;

  for (let i = samples.length - 1; i >= 0; i--) {
    if (last.t - samples[i].t > windowMs) break;
    first = samples[i];
  }

  const dt = last.t - first.t;
  if (dt <= 0) return { x: 0, y: 0 };

  return { x: ((last.x - first.x) / dt) * 1000, y: ((last.y - first.y) / dt) * 1000 };
}

export interface DragHooks {
  blocked?(): boolean;
  /** 从事件目标找到要拖的 body。返回 null 表示点在空白处（交给画布平移）。 */
  hitTest(target: EventTarget | null): Body | null;
  /** 屏幕客户端坐标 → world 坐标。 */
  toWorld(clientX: number, clientY: number): { x: number; y: number };
  onDragStart(body: Body): void;
  onDragMove(body: Body): void;
  /** 松手。velocity 是甩出速度（world/秒），已由最近采样算出。 */
  onDrop(body: Body, velocity: { x: number; y: number }): void;
  /** 判定为点击。`at` 是点击位置（视口坐标），放大动画需要它来定缩放锚点。 */
  onTap(body: Body, at: { x: number; y: number }): void;
}

export interface DragHandle {
  cancel(): void;
  destroy(): void;
  /** 当前是否有拖拽在进行（自动化测试用）。 */
  readonly isDragging: boolean;
}

export function mountDrag(stage: HTMLElement, hooks: DragHooks): DragHandle {
  /** 当前被按住的 body。null = 没有进行中的手势。 */
  let active: Body | null = null;
  /** 是否已经越过了阈值、正式进入拖拽。 */
  let dragging = false;
  let activePointerId = -1;
  /** 按下点与泡泡中心的偏移，避免泡泡"跳"到指针下面。 */
  let grabDx = 0;
  let grabDy = 0;

  let samples: Sample[] = [];

  const pushSample = (e: PointerEvent): Sample => {
    const w = hooks.toWorld(e.clientX, e.clientY);
    const s: Sample = { x: w.x, y: w.y, t: performance.now() };
    samples.push(s);
    if (samples.length > MAX_SAMPLES) samples.shift();
    return s;
  };

  const onPointerDown = (e: PointerEvent): void => {
    if (hooks.blocked?.()) return;
    if (active) return; // 已经有一个手势在进行（例如多指）
    // 鼠标只响应主键；触屏/笔的 button 恒为 0
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    const hit = hooks.hitTest(e.target);
    if (!hit) return;
    // 🔴 心泡泡永远不能拖 —— 拖走它等于把整片星云的锚点拔了
    if (hit.fixed) return;

    active = hit;
    dragging = false;
    activePointerId = e.pointerId;
    samples = [];

    const w = pushSample(e);
    grabDx = hit.x - w.x;
    grabDy = hit.y - w.y;
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (!active || e.pointerId !== activePointerId) return;
    if (e.pointerType === 'touch' && e.cancelable) e.preventDefault();

    const w = pushSample(e);

    if (!dragging) {
      const first = samples[0];
      if (Math.hypot(w.x - first.x, w.y - first.y) <= DRAG_THRESHOLD_PX) return;
      dragging = true;
      // 🔴 这一行是"压着拖动不抖"的全部原因
      active.dragging = true;
      hooks.onDragStart(active);
    }

    // 位置由指针直接决定。引擎这一步不会碰它（isImmovable）
    active.x = w.x + grabDx;
    active.y = w.y + grabDy;
    hooks.onDragMove(active);
  };

  const finish = (e: PointerEvent, cancelled: boolean): void => {
    if (!active || e.pointerId !== activePointerId) return;

    const target = active;
    const wasDragging = dragging;

    active = null;
    dragging = false;
    activePointerId = -1;

    if (wasDragging) {
      // 🔴 不是硬停：把松手那一刻的手速交给引擎，让它自然滑一段再被力场拉住。
      //    这就是用户说的"松手后会飘一点，让人有拖拽的感觉"。
      target.dragging = false;
      const velocity = cancelled ? { x: 0, y: 0 } : velocityFromSamples(samples);
      hooks.onDrop(target, velocity);
      return;
    }

    if (!cancelled && classifyGesture(samples) === 'tap') {
      hooks.onTap(target, { x: e.clientX, y: e.clientY });
    }
  };

  const onPointerUp = (e: PointerEvent): void => finish(e, false);
  const onPointerCancel = (e: PointerEvent): void => finish(e, true);

  stage.addEventListener('pointerdown', onPointerDown);
  // 🔴 挂在 window 而不是 stage：指针滑出画布（拖到输入框上、拖出窗口）也不丢事件
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerCancel);

  return {
    cancel: () => {
      if (active) finish({ pointerId: activePointerId } as PointerEvent, true);
    },
    get isDragging(): boolean {
      return dragging;
    },
    destroy: () => {
      stage.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
    },
  };
}
