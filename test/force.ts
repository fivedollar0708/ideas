/**
 * force.ts 的测试。
 *
 * 重点是**空间隔离**：这是用户明确点名"最容易写错"的地方。
 * 这里从两个角度验：
 *  ① 行为上 —— 模拟空间 A 时，空间 B 的泡泡一动不动
 *  ② 结构上 —— neighborsOf() 的结果里不存在别的空间的泡泡
 */

import { between, eq, eqJson, ok, section } from './assert';
import { ForceField, type Body } from '../src/physics/force';
import { makeRng } from '../src/rng';

function body(
  id: string,
  spaceId: string,
  x: number,
  y: number,
  rx = 20,
  ry = 20,
  extra: Partial<Body> = {},
): Body {
  return { id, spaceId, x, y, vx: 0, vy: 0, rx, ry, fixed: false, pinned: false, ...extra };
}

function snapshot(bodies: readonly Body[]): Array<{ x: number; y: number }> {
  return bodies.map((b) => ({ x: b.x, y: b.y }));
}

export function runForceTests(): void {
  section('force · 空间隔离（行为）');

  {
    const field = new ForceField();
    const A = [body('a1', 'A', 0, 0, 20, 20), body('a2', 'A', 16, 0, 20, 20)];
    const B = [body('b1', 'B', 0, 0, 20, 20), body('b2', 'B', 16, 0, 20, 20)];

    field.setSpaceBodies('A', A);
    field.setSpaceBodies('B', B);
    field.setActiveSpace('A');
    field.wake(1);

    const beforeA = snapshot(A);
    const beforeB = snapshot(B);

    for (let i = 0; i < 60; i++) field.step();

    const aMoved = A.some((b, i) => Math.abs(b.x - beforeA[i].x) > 1e-6);
    ok(aMoved, '活动空间的泡泡确实被力推动了');

    eqJson(snapshot(B), beforeB, '非活动空间的泡泡坐标完全没变');
  }

  section('force · 空间隔离（结构）');

  {
    const field = new ForceField();
    // 故意把两个空间的泡泡摆在完全相同的坐标上 —— 如果隔离漏了，它们必然互相影响
    const A = [body('a1', 'A', 0, 0, 20, 20), body('a2', 'A', 10, 0, 20, 20)];
    const B = [body('b1', 'B', 0, 0, 20, 20), body('b2', 'B', 10, 0, 20, 20)];

    field.setSpaceBodies('A', A);
    field.setSpaceBodies('B', B);

    // 两个空间都重建了网格，此时逐个查邻居
    for (const group of [A, B]) {
      for (const b of group) {
        const neigh = field.neighborsOf(b);
        ok(
          neigh.every((n) => n.spaceId === b.spaceId),
          `neighborsOf(${b.id}) 只返回同空间泡泡（返回 ${neigh.length} 个）`,
        );
      }
    }

    // 即使两个空间的泡泡坐标完全相同，邻居数也必须只算自己空间的
    ok(field.neighborsOf(A[0]).length === 1, 'A 空间那个泡泡只看到 1 个同空间邻居');
  }

  section('force · 碰撞与推开');

  {
    const field = new ForceField();
    const a = body('c1', 'S', 0, 0, 20, 20);
    const b = body('c2', 'S', 6, 0, 20, 20);
    field.setSpaceBodies('S', [a, b]);
    field.setActiveSpace('S');
    field.wake(1);

    const d0 = Math.hypot(b.x - a.x, b.y - a.y);
    for (let i = 0; i < 60; i++) field.step();
    const d1 = Math.hypot(b.x - a.x, b.y - a.y);

    ok(d1 > d0, `重叠的泡泡被推开（${d0.toFixed(1)} → ${d1.toFixed(1)}）`);
    ok(d1 >= 39, `推开后基本不重叠（距离 ${d1.toFixed(1)}，半径和 40）`);
  }

  {
    // 完全重合的极端情况：不能出现 NaN
    const field = new ForceField();
    const a = body('z1', 'S', 5, 5, 20, 20);
    const b = body('z2', 'S', 5, 5, 20, 20);
    field.setSpaceBodies('S', [a, b]);
    field.setActiveSpace('S');
    field.wake(1);
    for (let i = 0; i < 60; i++) field.step();

    ok(
      Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(b.x) && Number.isFinite(b.y),
      '完全重合时坐标不会变成 NaN（1/d² 发散已被处理）',
    );
    ok(Math.hypot(b.x - a.x, b.y - a.y) > 1, '完全重合的两个泡泡被分开了');
  }

  section('force · 钉住与锁定');

  {
    const field = new ForceField();
    const heart = body('h', 'S', 0, 0, 60, 60, { fixed: true });
    const locked = body('p', 'S', 80, 0, 20, 20, { pinned: true });
    const free = body('f', 'S', 20, 0, 20, 20);
    field.setSpaceBodies('S', [heart, locked, free]);
    field.setActiveSpace('S');
    field.wake(1);

    for (let i = 0; i < 60; i++) field.step();

    eqJson({ x: heart.x, y: heart.y }, { x: 0, y: 0 }, '心泡泡（fixed）纹丝不动');
    eqJson({ x: locked.x, y: locked.y }, { x: 80, y: 0 }, '锁定（pinned）的泡泡不被推走');
    ok(Math.hypot(free.x - 20, free.y) > 1, '自由泡泡被心泡泡推开了');
  }

  section('force · alpha 三档降频');

  {
    const field = new ForceField();
    field.setSpaceBodies('S', [body('x', 'S', 50, 0)]);
    field.setActiveSpace('S');

    ok(field.alpha === 0, '初始 alpha 为 0');
    ok(field.tier() === 'asleep', '初始就是 asleep 档');

    field.wake(1);
    ok(field.tier() === 'full', 'wake 之后进入 full 档');

    let steps = 0;
    const seenTiers = new Set<string>();
    while (field.tier() !== 'asleep' && steps < 5000) {
      seenTiers.add(field.tier());
      field.step();
      steps++;
    }

    ok(field.tier() === 'asleep', '最终收敛到 asleep（此时 rAF 会停掉，CPU 归零）');
    between(steps, 1, 1000, `收敛步数有限（${steps} 步 ≈ ${(steps / 60).toFixed(1)} 秒）`);
    ok(seenTiers.has('eco'), '中途经过了 eco 档');

    // wake 不会把已经归零的 alpha 降下来
    field.wake(0.1);
    ok(field.alpha === 0.1, 'wake(0.1) 之后 alpha 为 0.1');
    field.wake(0.05);
    ok(field.alpha === 0.1, 'wake 只升不降');
  }

  section('force · 确定性');

  {
    const build = (): Body[] => [
      body('d1', 'S', 10, 0, 20, 20),
      body('d2', 'S', 25, 5, 20, 20),
      body('d3', 'S', -30, 12, 20, 20),
    ];

    const run = (): Array<{ x: number; y: number }> => {
      const field = new ForceField();
      const bodies = build();
      field.setSpaceBodies('S', bodies);
      field.setActiveSpace('S');
      field.wake(0.8);
      for (let i = 0; i < 120; i++) field.step();
      return snapshot(bodies);
    };

    eqJson(run(), run(), '相同初始条件跑两次，结果逐位一致');

    // 换掉其中一个 id ⇒ 重合时的确定性哈希方向会变，但不应崩溃
    const runDifferent = (): Array<{ x: number; y: number }> => {
      const field = new ForceField();
      const bodies = [body('e1', 'S', 0, 0), body('e2', 'S', 0, 0)];
      field.setSpaceBodies('S', bodies);
      field.setActiveSpace('S');
      field.wake(0.8);
      for (let i = 0; i < 30; i++) field.step();
      return snapshot(bodies);
    };
    const p1 = runDifferent();
    const p2 = runDifferent();
    eqJson(p1, p2, '重合点的散开方向也是确定的（不依赖 Math.random）');
  }

  section('force · 网格分桶与暴力计算一致');

  {
    const RADIUS = 100;
    const field = new ForceField({ interactionRadius: RADIUS });
    const rng = makeRng('grid-test');
    const bodies: Body[] = [];
    for (let i = 0; i < 60; i++) {
      const p = rng.inDisc(260);
      bodies.push(body(`g${i}`, 'S', p.x, p.y, 10, 10));
    }

    field.setSpaceBodies('S', bodies);
    field.setActiveSpace('S');

    let mismatches = 0;
    let checked = 0;

    for (const b of bodies) {
      const viaGrid = new Set(field.neighborsOf(b).map((n) => n.id));
      const viaBrute = new Set(
        bodies
          .filter((o) => o !== b && Math.hypot(o.x - b.x, o.y - b.y) <= RADIUS)
          .map((o) => o.id),
      );

      checked++;
      if (viaGrid.size !== viaBrute.size) mismatches++;
      else {
        for (const id of viaBrute) {
          if (!viaGrid.has(id)) mismatches++;
        }
      }
    }

    eq(mismatches, 0, `网格分桶结果与暴力计算完全一致（检查了 ${checked} 个泡泡）`);

    // 顺带确认网格确实省了计算：邻居数应远小于总数
    const avgNeighbors =
      bodies.reduce((sum, b) => sum + field.neighborsOf(b).length, 0) / bodies.length;
    ok(avgNeighbors < bodies.length / 2, `平均邻居数 ${avgNeighbors.toFixed(1)} 远小于总数 ${bodies.length}`);
  }

  section('force · 空空间与边界');

  {
    const field = new ForceField();
    ok(field.activeBodies.length === 0, '没有活动空间时 activeBodies 为空');
    field.step(); // 不应抛错
    ok(true, '没有活动空间时 step() 不抛错');

    field.setSpaceBodies('S', []);
    field.setActiveSpace('S');
    field.wake(1);
    field.step();
    ok(true, '空空间 step() 不抛错');

    field.setActiveSpace('不存在的空间');
    field.step();
    ok(true, '活动空间不存在时 step() 不抛错');

    field.removeSpace('S');
    ok(field.spaceIds.length === 0, 'removeSpace 之后空间被清掉');

    // 距离原点很远的泡泡，应该被向心力拉回来
    const f2 = new ForceField();
    const far = body('far', 'S', 5000, 0, 20, 20);
    f2.setSpaceBodies('S', [far]);
    f2.setActiveSpace('S');
    f2.wake(0.5);
    for (let i = 0; i < 400; i++) f2.step();
    ok(Number.isFinite(far.x), '远处泡泡的坐标仍是有限数');
    ok(far.x < 5000, `向心力把远处的泡泡拉近了（5000 → ${far.x.toFixed(0)}）`);
  }
}
