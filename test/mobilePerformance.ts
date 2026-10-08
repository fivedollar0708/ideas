import { close, eq, ok, section } from './assert';
import { keyboardShift, pinchViewport } from '../src/interact/mobile';
import { renderedIds, renderPolicy } from '../src/render';
import { ForceField, type Body } from '../src/physics/force';

export function runMobilePerformanceTests(): void {
  section('mobile · keyboard compensation');
  eq(keyboardShift(800, 500, 0, 1), 300, '键盘遮住 300px 时抬升 300px');
  eq(keyboardShift(500, 500, 0, 1), 0, 'dvh 已收缩时不重复抬升');
  eq(keyboardShift(800, 500, 100, 1), 200, '考虑 Safari visualViewport 偏移');
  eq(keyboardShift(800, 500, 0, 2), 0, '浏览器页面缩放不被当作键盘');
  eq(keyboardShift(400, 500, 0, 1), 0, '可视区更大时不向下移动');
  section('mobile · pinch anchor and limits');
  const v = pinchViewport({scale: 1, tx: 10, ty: 20}, {x: 110, y: 120}, {x: 130, y: 140}, 2);
  close(v.scale, 2, 1e-9, '两指间距翻倍 ⇒ 缩放翻倍');
  close(100 * v.scale + v.tx, 130, 1e-9, '锚点 x 跟随两指中心');
  close(100 * v.scale + v.ty, 140, 1e-9, '锚点 y 跟随两指中心');
  eq(pinchViewport(v, {x:0,y:0}, {x:0,y:0}, 99).scale, 3, '捏合上限 3');
  eq(pinchViewport(v, {x:0,y:0}, {x:0,y:0}, 0.001).scale, 0.25, '捏合下限 .25');
  section('render · performance boundaries and complete search');
  eq(renderPolicy(300).tier, 'full', '300 保留全部效果');
  eq(renderPolicy(301).tier, 'light', '301 进入轻量档');
  eq(renderPolicy(800).culled, false, '800 仍渲染全部');
  eq(renderPolicy(801).tier, 'culled', '801 开始裁剪');
  eq(renderPolicy(301).ripple, false, '轻量档不播涟漪');
  eq(renderPolicy(301).glow, false, '轻量档关闭 glow');
  eq(renderPolicy(301).fontReduction, 1, '轻量档字号减 1');
  const bodies: Body[] = Array.from({length: 801}, (_, i) => ({
    id: String(i).padStart(4, '0'), spaceId: 'a', x: i, y: 0, vx: 0, vy: 0,
    rx: i + 1, ry: 10, fixed: false, pinned: false, dragging: false,
  }));
  const before = JSON.stringify(bodies);
  const base = renderedIds(bodies, new Set());
  eq(base.size, 300, '超限基础 DOM 为 300');
  ok(base.has('0800') && !base.has('0000'), '选最大面积的泡泡');
  const searched = renderedIds(bodies, new Set(['0000', '0800']));
  eq(searched.size, 301, '补上未渲染命中且不重复计数');
  ok([...base].every(id => searched.has(id)), '搜索保留整个基础版图');
  eq(JSON.stringify(bodies), before, 'DOM 选择不改变 body 顺序或坐标');
  eq(renderedIds(bodies.slice(0, 800), new Set()).size, 800, '800 不裁剪');
  const tied = bodies.map(b => ({ ...b, rx: 1 }));
  eq([...renderedIds(tied, new Set())].join(','), [...renderedIds([...tied].reverse(), new Set())].join(','), '同面积选择与输入顺序无关');
  section('force · reduced motion skips eco');
  const field = new ForceField();
  field.setSpaceBodies('a', bodies.slice(0, 2).map(b => ({ ...b })));
  field.setActiveSpace('a');
  field.setReducedMotion(true);
  field.wake(0.1);
  let eco = false;
  for (let n = 0; n < 300 && field.tier() !== 'asleep'; n++) {
    eco ||= field.tier() === 'eco';
    field.step();
  }
  eq(field.tier(), 'asleep', '减少动态效果时能停稳');
  eq(eco, false, '没有进入余温档');
  ok(field.activeBodies.every(b => b.vx === 0 && b.vy === 0), '停止时清掉残余速度');
  field.wake(0.01);
  eq(field.tier(), 'asleep', '减少动态效果时弱唤醒不会开启余温档');
  field.setReducedMotion(false);
  field.wake(0.01);
  eq(field.tier(), 'eco', '恢复正常偏好后保留原余温行为');
}
