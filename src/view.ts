/**
 * 视口变换：world（星云坐标）↔ screen（CSS 像素）。
 *
 * 为什么要有这一层：泡泡的位置必须存在一个与"当前怎么看"无关的坐标系里。
 * 你缩放、平移、换个屏幕，泡泡的 world 坐标都不该变 —— 否则"位置持久化"
 * 毫无意义。视口只是"从哪个角度看这片星云"。
 *
 * 实现方式：所有泡泡放在一个 #world 容器里，容器整体做
 * `translate(tx, ty) scale(scale)`，泡泡自己只写 world 坐标。
 * 好处是缩放平移只需要改一个元素的 transform，不用逐个改泡泡。
 */

import type { Rect, Vec, Viewport } from './types';
import { VIEW_SCALE_MAX, VIEW_SCALE_MIN } from './types';

export function identityViewport(): Viewport {
  return { scale: 1, tx: 0, ty: 0 };
}

/** world 坐标 → 屏幕坐标。 */
export function worldToScreen(vp: Viewport, p: Vec): Vec {
  return { x: p.x * vp.scale + vp.tx, y: p.y * vp.scale + vp.ty };
}

/** 屏幕坐标 → world 坐标。 */
export function screenToWorld(vp: Viewport, p: Vec): Vec {
  return { x: (p.x - vp.tx) / vp.scale, y: (p.y - vp.ty) / vp.scale };
}

/** 生成 #world 容器的 transform 字符串。 */
export function worldTransform(vp: Viewport): string {
  return `translate3d(${vp.tx}px, ${vp.ty}px, 0) scale(${vp.scale})`;
}

/**
 * 以某个屏幕点为锚点缩放。
 *
 * 🔴 锚点不变是关键手感：滚轮放在哪，那个位置的内容就该原地放大/缩小。
 *    如果只改 scale 不修 tx/ty，画面会朝左上角"跑"。
 */
export function zoomAt(vp: Viewport, anchorScreen: Vec, factor: number): Viewport {
  const scale = clampScale(vp.scale * factor);
  // 生效的倍率（可能被上下限夹住），用它反推平移，否则夹住时画面会漂
  const applied = scale / vp.scale;
  return {
    scale,
    tx: anchorScreen.x - (anchorScreen.x - vp.tx) * applied,
    ty: anchorScreen.y - (anchorScreen.y - vp.ty) * applied,
  };
}

export function clampScale(scale: number): number {
  return Math.min(VIEW_SCALE_MAX, Math.max(VIEW_SCALE_MIN, scale));
}

/**
 * 算出一个"刚好装下这些点"的视口。
 *
 * 双击空白处回全貌用它。
 */
export function fitToContent(
  points: Vec[],
  radiusPad: number,
  viewportSize: { w: number; h: number },
  padding = 64,
): Viewport {
  if (points.length === 0) {
    // 空星云就把原点放在屏幕中央
    return { scale: 1, tx: viewportSize.w / 2, ty: viewportSize.h / 2 };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const p of points) {
    if (p.x - radiusPad < minX) minX = p.x - radiusPad;
    if (p.y - radiusPad < minY) minY = p.y - radiusPad;
    if (p.x + radiusPad > maxX) maxX = p.x + radiusPad;
    if (p.y + radiusPad > maxY) maxY = p.y + radiusPad;
  }

  const contentW = Math.max(1, maxX - minX);
  const contentH = Math.max(1, maxY - minY);
  const availW = Math.max(1, viewportSize.w - padding * 2);
  const availH = Math.max(1, viewportSize.h - padding * 2);

  // 🔴 上限取 1，不取 VIEW_SCALE_MAX：内容很少时（比如刚开始只有一条想法）
  //    "刚好装下"会算出 5 倍甚至 8 倍的放大，泡泡会变成糊满屏幕的巨球。
  //    回全貌的正确语义是"缩到装得下"，不是"放大到装得下"。
  const fitted = Math.min(availW / contentW, availH / contentH);
  const scale = Math.max(VIEW_SCALE_MIN, Math.min(1, fitted));

  // 让内容包围盒居中
  const centerWorld = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  return {
    scale,
    tx: viewportSize.w / 2 - centerWorld.x * scale,
    ty: viewportSize.h / 2 - centerWorld.y * scale,
  };
}

/** 世界坐标下的包围盒。 */
export function boundsOf(points: Vec[], radiusPad: number): Rect {
  if (points.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x - radiusPad);
    minY = Math.min(minY, p.y - radiusPad);
    maxX = Math.max(maxX, p.x + radiusPad);
    maxY = Math.max(maxY, p.y + radiusPad);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
