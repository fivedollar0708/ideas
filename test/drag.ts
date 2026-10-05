/**
 * drag.ts 的纯函数测试。
 *
 * 只测能脱离浏览器跑的部分：手势判定阈值、松手速度估算。
 * 真正的指针事件链路（pointerdown → move → up、与画布平移的分工、
 * 与力场的配合）由 `npm run smoke` 用真 Chrome 验。
 *
 * 为什么这两条要单独测：
 *  - 阈值算错的症状是"手抖就变成拖动"或"想拖却变成点击"，都很难复现难以定位；
 *  - 速度估算算错的症状是"甩不出去"或"甩飞了"，而它们是纯数学，值得有断言钉住。
 */

import { close, eqJson, ok, section } from './assert';
import {
  classifyGesture,
  DRAG_THRESHOLD_PX,
  TAP_MAX_MS,
  velocityFromSamples,
  VELOCITY_WINDOW_MS,
  type Sample,
} from '../src/interact/drag';

/** 造一段采样：从 (0,0) 匀速直线走到 (dx, dy)，耗时 durationMs。 */
function linear(dx: number, dy: number, durationMs: number, steps = 5): Sample[] {
  const out: Sample[] = [];
  for (let i = 0; i <= steps; i++) {
    const k = i / steps;
    out.push({ x: dx * k, y: dy * k, t: durationMs * k });
  }
  return out;
}

export function runDragTests(): void {
  section('drag · 阈值常量');

  close(DRAG_THRESHOLD_PX, 8, 0, '位移阈值是 8px');
  close(TAP_MAX_MS, 300, 0, '点击时长上限是 300ms');
  close(VELOCITY_WINDOW_MS, 90, 0, '速度取样窗口是最近 90ms');

  section('drag · 手势判定');

  eqJson(classifyGesture([]), 'tap', '没有采样 → 当成点击（不会误判成拖拽）');
  eqJson(classifyGesture([{ x: 0, y: 0, t: 0 }]), 'tap', '只有一次采样 → 点击');

  eqJson(classifyGesture(linear(0, 0, 120)), 'tap', '完全没动、120ms → 点击');
  eqJson(classifyGesture(linear(5, 0, 100)), 'tap', '移动 5px（< 8）→ 点击');
  eqJson(classifyGesture(linear(8, 0, 100)), 'tap', '恰好 8px → 仍是点击（阈值是"超过"）');
  eqJson(classifyGesture(linear(9, 0, 100)), 'drag', '移动 9px（> 8）→ 拖拽');
  eqJson(classifyGesture(linear(0, 0, 350)), 'drag', '没动但按住 350ms（> 300）→ 拖拽（长按不算点击）');
  eqJson(classifyGesture(linear(3, 4, 100)), 'tap', '斜向移动 5px（勾股）→ 点击');
  eqJson(classifyGesture(linear(3, 0, 100, 1)), 'tap', '只有起点终点两个采样也能判');
  eqJson(classifyGesture(linear(100, 0, 40)), 'drag', '快速大幅移动 → 拖拽');

  // 判定只看首尾，不管中间抖了多少 —— 手抖来回不应该被误判
  const jitter: Sample[] = [
    { x: 0, y: 0, t: 0 },
    { x: 20, y: 0, t: 50 },
    { x: -20, y: 0, t: 100 },
    { x: 3, y: 0, t: 150 },
  ];
  eqJson(classifyGesture(jitter), 'tap', '中途抖了 40px 但首尾只差 3px → 点击');

  section('drag · 松手速度估算');

  eqJson(velocityFromSamples([]), { x: 0, y: 0 }, '没有采样 → 速度 0');
  eqJson(velocityFromSamples([{ x: 5, y: 5, t: 0 }]), { x: 0, y: 0 }, '只有一次采样 → 速度 0');

  // 匀速 100 world 单位 / 100ms ⇒ 1000 单位/秒
  const steady = velocityFromSamples(linear(100, 0, 100));
  close(steady.x, 1000, 1, '匀速直线 → 1000 单位/秒');
  close(steady.y, 0, 1e-9, 'y 方向没有速度');

  // 完全静止 → 0
  const still: Sample[] = [
    { x: 7, y: 7, t: 0 },
    { x: 7, y: 7, t: 50 },
    { x: 7, y: 7, t: 100 },
  ];
  eqJson(velocityFromSamples(still), { x: 0, y: 0 }, '一直没动 → 速度 0');

  // 同一时刻的两条采样（dt = 0）不能除零
  const sameTime: Sample[] = [
    { x: 0, y: 0, t: 100 },
    { x: 50, y: 0, t: 100 },
  ];
  eqJson(velocityFromSamples(sameTime), { x: 0, y: 0 }, 'dt 为 0 时不产生 Infinity');

  // 🔴 只取尾段：先慢慢挪、最后猛一甩，估出来的应该是"甩"的手速，不是平均速度
  const flick: Sample[] = [
    { x: 0, y: 0, t: 0 },
    { x: 10, y: 0, t: 100 },
    { x: 60, y: 0, t: 150 },
    { x: 160, y: 0, t: 200 },
  ];
  const flickV = velocityFromSamples(flick);
  close(flickV.x, 2000, 1, '先慢后快 → 取尾段得 2000 单位/秒');
  ok(flickV.x > (160 / 200) * 1000, '明显快于"用整段历史算出来的平均速度"（800）');

  // 反方向也要认
  const back = velocityFromSamples(linear(-100, 0, 100));
  close(back.x, -1000, 1, '反向甩出 → 速度为负');

  // 斜向
  const diag = velocityFromSamples([
    { x: 0, y: 0, t: 0 },
    { x: 30, y: 40, t: 50 },
  ]);
  close(diag.x, 600, 1, '斜向甩出：x 分量正确');
  close(diag.y, 800, 1, '斜向甩出：y 分量正确');
}
