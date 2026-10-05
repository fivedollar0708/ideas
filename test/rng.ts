/**
 * rng.ts 的测试。
 *
 * 重点验两件事：
 *  ① 确定性 —— 同种子必须给出同序列。这是"位置持久化"能成立的前提。
 *  ② 分布 —— 特别是 inDisc 的开方，写漏了会让新泡泡全挤在圆心。
 */

import { between, close, eq, ok, section } from './assert';
import { hashString, makeRng, mulberry32, newId } from '../src/rng';

function take(rng: () => number, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(rng());
  return out;
}

export function runRngTests(): void {
  section('rng · 确定性');

  eq(
    JSON.stringify(take(mulberry32(12345), 8)),
    JSON.stringify(take(mulberry32(12345), 8)),
    '同种子 → 序列完全一致',
  );

  ok(
    JSON.stringify(take(mulberry32(1), 8)) !== JSON.stringify(take(mulberry32(2), 8)),
    '不同种子 → 序列不同',
  );

  // 字符串种子必须稳定（空间 id / 想法 id 都是字符串）
  eq(
    JSON.stringify(take(makeRng('abc-def').next, 5)),
    JSON.stringify(take(makeRng('abc-def').next, 5)),
    '字符串种子 → 序列一致',
  );

  section('rng · 取值区间');

  const plain = take(mulberry32(7), 2000);
  ok(
    plain.every((v) => v >= 0 && v < 1),
    'next() 全部落在 [0, 1)',
  );

  const rng = makeRng(99);
  let rangeOk = true;
  let intOk = true;
  for (let i = 0; i < 2000; i++) {
    const r = rng.range(-5, 5);
    if (!(r >= -5 && r < 5)) rangeOk = false;

    const n = rng.int(3, 7);
    if (!Number.isInteger(n) || n < 3 || n > 7) intOk = false;
  }
  ok(rangeOk, 'range(lo, hi) 全部落在 [lo, hi)');
  ok(intOk, 'int(lo, hi) 全部是 [lo, hi] 内的整数');

  section('rng · inDisc 的分布（检验开方）');

  const RADIUS = 100;
  const samples = 20000;
  let insideCircle = true;
  let inInnerQuarter = 0;

  for (let i = 0; i < samples; i++) {
    const p = rng.inDisc(RADIUS);
    const d = Math.hypot(p.x, p.y);
    if (d > RADIUS + 1e-9) insideCircle = false;
    // 半径一半以内的点，面积应占 1/4
    if (d <= RADIUS / 2) inInnerQuarter++;
  }

  ok(insideCircle, 'inDisc 生成的点全部在圆内');

  const ratio = inInnerQuarter / samples;
  // 🔴 这条是 inDisc 开方的回归测试：若漏了 Math.sqrt，
  //    内圈面积占比会接近 0.5 而不是 0.25，表现是"新泡泡堆在圆心一小团里"。
  close(ratio, 0.25, 0.03, `内圈（半径一半内）占比约 25%（实测 ${(ratio * 100).toFixed(1)}%）`);

  section('rng · hashString');

  eq(hashString('hello'), hashString('hello'), '同字符串 → 同哈希');
  ok(hashString('hello') !== hashString('hellp'), '相邻字符串 → 哈希不同');

  let hashInRange = true;
  for (const s of ['', 'a', '想法星云', '凌晨三点', 'x'.repeat(200)]) {
    const h = hashString(s);
    if (!Number.isInteger(h) || h < 0 || h > 0xffffffff) hashInRange = false;
  }
  ok(hashInRange, 'hashString 结果均为 32 位无符号整数');

  section('rng · newId');

  const ids = new Set<string>();
  for (let i = 0; i < 5000; i++) ids.add(newId());
  eq(ids.size, 5000, '5000 次生成无重复');

  ok(/^[0-9a-f-]{36}$/.test(newId()), 'id 是 36 字符的 UUID 形态');

  // 只做形态检查，不断言必须等于 4：老环境会走手工拼装分支
  const v = newId()[14];
  between(parseInt(v, 16), 0, 15, 'id 版本位可解析');
}
