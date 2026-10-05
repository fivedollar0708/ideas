/**
 * flyIn.ts / zoom.ts 的纯函数测试。
 *
 * 只测能脱离浏览器跑的部分（弧线几何、path 字符串、keyframes、FLIP 换算、字号）。
 * 真正跑动画的那部分（WAAPI、offsetPath、图层）由 `npm run smoke` 用真 Chrome 验。
 *
 * 为什么这两组数学值得单独钉住：
 *  · `path()` 的坐标是"视口绝对坐标"这件事，写错的表现是弧线整体偏移，
 *    而它偏得很"像对的"，肉眼很难判断；
 *  · FLIP 的 transform-origin 换算错了，放大动画会从错误的方向撑开，
 *    而且不会报错。这两件事都是纯数学，必须用断言钉住。
 */

import { close, eq, ok, section } from './assert';
import {
  ARC_LIFT_MAX,
  ARC_LIFT_MIN,
  arcControlPoint,
  loadPopKeyframes,
  pathDataFor,
  POP_OVERSHOOT,
  POP_START,
  popKeyframes,
  rippleKeyframes,
} from '../src/render/flyIn';
import {
  computeZoomTransform,
  planZoom,
  zoomFontSize,
  zoomScaleFor,
  zoomTargetRect,
  ZOOM_MAX_FONT,
  ZOOM_MIN_FONT,
  type ZoomTransform,
} from '../src/render/zoom';
import { FONT_SIZE } from '../src/text';
import type { Rect, Vec } from '../src/types';

/**
 * 把 computeZoomTransform 的结果施加到克隆体本地的某一点上，算出它在视口的位置。
 *
 * 这正是浏览器实际做的事情：transform-origin 为 O、transform 为
 * `translate(Tr) scale(k)` 时，本地点 p 映射到 `T0 + O + Tr + k·(p − O)`。
 * 测试靠它来验证"起始状态的克隆体与源泡泡完全重合"。
 */
function project(z: ZoomTransform, target: Rect, local: Vec): Vec {
  const originScreen = { x: target.x + z.origin.x, y: target.y + z.origin.y };
  return {
    x: originScreen.x + z.start.x + z.k * (local.x - z.origin.x),
    y: originScreen.y + z.start.y + z.k * (local.y - z.origin.y),
  };
}

export function runAnimTests(): void {
  section('flyIn · 弧线几何');

  // 🔴 屏幕坐标 y 向下增大 —— "向上抬"必须是减去 lift。写反了弧线会往下兜。
  const from: Vec = { x: 100, y: 700 };
  const to: Vec = { x: 500, y: 300 };

  const mid = arcControlPoint(from, to, 100);
  close(mid.x, 300, 1e-9, '控制点在起终点中点的 x 上');
  close(mid.y, 400, 1e-9, '控制点在中点上方 100px（y 更小）');
  ok(mid.y < (from.y + to.y) / 2, '控制点确实在"上方"（y 小于中点）');

  const low = arcControlPoint(from, to, ARC_LIFT_MIN);
  const high = arcControlPoint(from, to, ARC_LIFT_MAX);
  ok(high.y < low.y, `抬得越多控制点越高（${ARC_LIFT_MIN} → ${ARC_LIFT_MAX}）`);
  close((from.y + to.y) / 2 - low.y, ARC_LIFT_MIN, 1e-9, 'ARC_LIFT_MIN 生效');
  close((from.y + to.y) / 2 - high.y, ARC_LIFT_MAX, 1e-9, 'ARC_LIFT_MAX 生效');

  section('flyIn · path() 字符串');

  const d = pathDataFor(from, mid, to);
  ok(d.startsWith('path("M '), '以 path("M 开头');
  ok(d.endsWith('")'), '以 ") 结尾');
  ok(d.includes(' Q '), '是二次贝塞尔（Q）而不是三次（C）');
  ok(d.includes('100 700'), '起点用的是视口绝对坐标（100,700 原样出现）');
  ok(d.includes('500 300'), '终点用的是视口绝对坐标（500,300 原样出现）');

  // 坐标必须是绝对值而不是相对位移：换一个起点，前后两点的差值要跟着变
  const d2 = pathDataFor({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 20 });
  ok(d2.includes('0 0') && d2.includes('20 20'), '原点是原点、终点是终点（不是相对位移）');

  section('flyIn · 落定 keyframes');

  const pop = popKeyframes();
  eq(pop.length, 5, '五个停靠点（少一个就做不出两次过冲）');

  const scales = pop.map((f) => Number(String(f.transform).match(/scale\(([\d.]+)\)/)?.[1]));
  eq(scales[0], POP_START, `第一帧从 ${POP_START} 开始（几乎看不见，像"凭空冒出来"）`);
  close(scales[1], POP_OVERSHOOT, 1e-9, `第二帧过冲到 ${POP_OVERSHOOT}`);
  eq(scales[scales.length - 1], 1, '最后一帧回到 1');

  const offsets = pop.map((f) => Number(f.offset));
  ok(
    offsets.every((v, i) => i === 0 || v > offsets[i - 1]),
    'offset 严格递增（否则动画会倒着走）',
  );
  eq(offsets[0], 0, '第一个 offset 是 0');
  eq(offsets[offsets.length - 1], 1, '最后一个 offset 是 1');

  // "过冲两次"的判据：超过 1 的帧恰好有两个，并且中间夹着一个小于 1 的帧
  const overIdx = scales.map((s, i) => (s > 1 ? i : -1)).filter((i) => i >= 0);
  eq(overIdx.length, 2, '恰好两次过冲（1.22 与 1.05）');
  ok(scales[overIdx[1]] < scales[overIdx[0]], '第二次过冲比第一次小（回弹在收敛）');
  ok(scales[overIdx[0] - 1] < 1 || overIdx[0] === 0, '第一次过冲前是缩小状态');
  ok(
    scales.slice(overIdx[0], overIdx[1]).some((s) => s < 1),
    '两次过冲之间有一次回落（这就是"啵"的弹性）',
  );

  // 允许外部传入参数覆盖，方便调手感
  const soft = popKeyframes(0.4, 1.08, 0.98, 1.02);
  const softScales = soft.map((f) => Number(String(f.transform).match(/scale\(([\d.]+)\)/)?.[1]));
  eq(softScales[0], 0.4, '可以传入更保守的起始值（0.4）');
  close(softScales[1], 1.08, 1e-9, '可以传入更保守的过冲（1.08）');

  section('flyIn · 首屏装配与涟漪');

  const load = loadPopKeyframes();
  eq(load.length, 3, '首屏装配用三帧（轻一点，不要抢戏）');
  eq(load[0].opacity, '0', '从透明开始');
  eq(load[load.length - 1].opacity, '1', '结束时不透明');
  const loadFirst = Number(String(load[0].transform).match(/scale\(([\d.]+)\)/)?.[1]);
  ok(loadFirst > 0.5, `首帧不至于小到"弹出来"（${loadFirst}）`);

  const ripple = rippleKeyframes();
  eq(ripple.length, 2, '涟漪两帧');
  eq(ripple[0].opacity, '1', '涟漪从不透明开始');
  eq(ripple[1].opacity, '0', '涟漪扩散到消失');
  const r0 = Number(String(ripple[0].transform).match(/scale\(([\d.]+)\)/)?.[1]);
  const r1 = Number(String(ripple[1].transform).match(/scale\(([\d.]+)\)/)?.[1]);
  ok(r1 > r0, `涟漪在扩大（${r0} → ${r1}）`);

  section('zoom · 放大倍数');

  const square: Rect = { x: 400, y: 300, w: 140, h: 140 };
  const fit = { maxW: 620, maxH: 400, maxScale: 3.4 };

  close(zoomScaleFor(square, fit), 400 / 140, 1e-9, '受高度限制时按高度算');
  close(zoomScaleFor({ x: 0, y: 0, w: 10, h: 10 }, fit), 3.4, 1e-9, '极小的泡泡被 maxScale 封顶');
  eq(zoomScaleFor({ x: 0, y: 0, w: 4000, h: 100 }, fit), 1, '比屏幕还大的泡泡不缩小（倍数下限是 1）');
  eq(zoomScaleFor({ x: 0, y: 0, w: 0, h: 0 }, fit), 1, '退化的矩形不产生 Infinity');

  section('zoom · 目标框（形状不歪的关键）');

  const target = zoomTargetRect(square, 2, { w: 1024, h: 800 });
  close(target.w, 280, 1e-9, '宽度 = 源宽 × 倍数');
  close(target.h, 280, 1e-9, '高度 = 源高 × 倍数');
  close(target.x, (1024 - 280) / 2, 1e-9, '水平居中');
  close(target.y, (800 - 280) / 2, 1e-9, '垂直居中');

  // 🔴 这条是"放大态形状不会歪"的全部依据：目标框与源框长宽比必须完全一致
  const wide: Rect = { x: 10, y: 20, w: 200, h: 100 };
  const wideTarget = zoomTargetRect(wide, 2.5, { w: 1024, h: 800 });
  close(
    wideTarget.w / wideTarget.h,
    wide.w / wide.h,
    1e-12,
    '目标框与源框长宽比完全一致 ⇒ 等比缩放不会把形状拉歪',
  );

  section('zoom · FLIP 换算（最容易错的一处）');

  const src: Rect = { x: 100, y: 200, w: 140, h: 140 };
  const tgt = zoomTargetRect(src, 3, { w: 1024, h: 800 });
  const pointer: Vec = { x: 150, y: 220 };
  const z = computeZoomTransform(src, tgt, pointer);

  close(z.k, 1 / 3, 1e-9, 'k = 源宽 / 目标宽');

  // ① 起始状态的克隆体必须与源泡泡**完全重合**
  const startTopLeft = project(z, tgt, { x: 0, y: 0 });
  close(startTopLeft.x, src.x, 1e-6, '起始：克隆体左上角对齐源泡泡左上角（x）');
  close(startTopLeft.y, src.y, 1e-6, '起始：克隆体左上角对齐源泡泡左上角（y）');

  const startBottomRight = project(z, tgt, { x: tgt.w, y: tgt.h });
  close(startBottomRight.x, src.x + src.w, 1e-6, '起始：右下角也对齐（尺寸完全一致）');
  close(startBottomRight.y, src.y + src.h, 1e-6, '起始：右下角也对齐（y）');

  // ② 缩放锚点必须落在"指针点的那个位置"上 —— 这就是"朝你手指的方向撑开"
  const anchor = project(z, tgt, z.origin);
  close(anchor.x, pointer.x, 1e-6, '变换原点映射回指针位置（x）⇒ 放大是朝手指方向撑开');
  close(anchor.y, pointer.y, 1e-6, '变换原点映射回指针位置（y）');

  // ③ 原点必须落在目标框内部（否则 transform-origin 会跑出元素外）
  ok(
    z.origin.x >= 0 && z.origin.x <= tgt.w && z.origin.y >= 0 && z.origin.y <= tgt.h,
    `变换原点在克隆体内部（${z.origin.x.toFixed(1)}, ${z.origin.y.toFixed(1)}）`,
  );

  // ④ 点在别的位置 ⇒ 原点跟着变
  const z2 = computeZoomTransform(src, tgt, { x: 240, y: 340 });
  ok(
    z2.origin.x > z.origin.x && z2.origin.y > z.origin.y,
    '点右下角 ⇒ 原点也移到右下（气泡会朝右下撑开）',
  );
  const anchor2 = project(z2, tgt, z2.origin);
  close(anchor2.x, 240, 1e-6, '换一个点击位置，锚点跟着换（x）');
  close(anchor2.y, 340, 1e-6, '换一个点击位置，锚点跟着换（y）');

  section('zoom · planZoom 端到端（纯计算）');

  const plan = planZoom(src, pointer, { w: 1024, h: 800 }, '想法之间会互相点亮');
  close(plan.target.w / plan.target.h, 1, 1e-9, '9 字 → 卡片档，但长宽比仍等于源（源是正圆）');
  eq(plan.shape, 'card', '9 字归入卡片档');
  ok(plan.scale >= 1, `放大倍数不小于 1（${plan.scale.toFixed(2)}）`);
  ok(plan.scale <= 3.4, '放大倍数不超过上限');

  const circlePlan = planZoom(src, pointer, { w: 1024, h: 800 }, '凌晨三点');
  eq(circlePlan.shape, 'circle', '4 字归入圆档');

  section('zoom · 放大态字号');

  // 短文本：字号恰好等于"按比例放大"，于是起始渲染与源泡泡逐像素一致
  const smallTarget = zoomTargetRect({ x: 0, y: 0, w: 186, h: 186 }, 1, { w: 1024, h: 800 });
  close(
    zoomFontSize('水', smallTarget, 3.4),
    FONT_SIZE * 3.4,
    1e-6,
    '短文本字号 = FONT_SIZE × 倍数（交接时逐像素一致）',
  );

  // 长文本：受"塞得进框"约束，字号被压下来
  const bigTarget = zoomTargetRect({ x: 0, y: 0, w: 496, h: 496 }, 1, { w: 1024, h: 800 });
  const longFont = zoomFontSize('字'.repeat(280), bigTarget, 3.2);
  ok(longFont < FONT_SIZE * 3.2, `280 字的字号被面积约束压低（${longFont.toFixed(1)} < ${(FONT_SIZE * 3.2).toFixed(1)}）`);
  ok(longFont >= ZOOM_MIN_FONT, '不低于可读下限');
  ok(longFont <= ZOOM_MAX_FONT, '不超过上限');

  // 极端长文本 + 很小的框 ⇒ 被可读下限兜住，不会算出 0 或负数
  const tinyTarget = zoomTargetRect({ x: 0, y: 0, w: 60, h: 60 }, 1, { w: 1024, h: 800 });
  const extreme = zoomFontSize('字'.repeat(5000), tinyTarget, 1);
  ok(extreme >= ZOOM_MIN_FONT && Number.isFinite(extreme), `极端输入被下限兜住（${extreme}）`);

  // 面积约束的有效性：近似估算下，全文应当能塞进可用区域
  for (const [len, box] of [
    [40, 300],
    [120, 420],
    [280, 496],
  ] as const) {
    const boxTarget = zoomTargetRect({ x: 0, y: 0, w: box, h: box }, 1, { w: 1024, h: 800 });
    const scale = 3;
    const font = zoomFontSize('字'.repeat(len), boxTarget, scale);
    const usableW = box - 20 * scale;
    const usableH = box - 16 * scale;
    const perLine = Math.max(1, usableW / font);
    const lines = Math.ceil(len / perLine);
    const needed = lines * font * 1.45;
    // 一阶估算：真实的中文逐字换行有微小的宽度差异，留 12% 余量
    ok(
      needed <= usableH * 1.12,
      `${len} 字的正文能塞进 ${box}×${box} 的框（估算需要 ${needed.toFixed(0)}，可用 ${usableH.toFixed(0)}）`,
    );
  }
}
