/**
 * 确定性随机。
 *
 * 🔴 为什么引擎里绝不允许直接调 Math.random：
 *    力导向的初始散布、布局的抖动、任何"随手取个位置"，都必须由种子驱动。
 *    否则同一批想法每次打开会散落到不同位置 —— 用户辛苦摆好的星云每次刷新
 *    都变样，位置持久化就形同虚设（存了坐标却每次都被重新随机覆盖）。
 *    用种子驱动后，"同样的数据 + 同样的种子 = 同样的布局"，位置才有意义。
 *
 * 所有需要随机的模块都从这里取数，不要各自引别的随机源。
 */

/**
 * mulberry32：32 位状态的快速伪随机数发生器。
 * 选它是因为实现足够短（十几行）、周期与分布对布局够用、且完全确定性。
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * FNV-1a：把任意字符串折成 32 位种子。
 * 用它把 "空间 id + 想法 id" 这样的字符串变成稳定的种子。
 */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 由种子创建的随机器，带几个常用的取数方法。 */
export interface Rng {
  /** [0, 1) 浮点。 */
  next(): number;
  /** [lo, hi) 浮点。 */
  range(lo: number, hi: number): number;
  /** [lo, hi] 闭区间整数。 */
  int(lo: number, hi: number): number;
  /** 单位圆内均匀取点，再乘 radius。 */
  inDisc(radius: number): { x: number; y: number };
}

export function makeRng(seed: number | string): Rng {
  const next = mulberry32(typeof seed === 'string' ? hashString(seed) : seed);
  return {
    next,
    range: (lo, hi) => lo + next() * (hi - lo),
    int: (lo, hi) => Math.floor(lo + next() * (hi - lo + 1)),
    inDisc(radius) {
      // 🔴 半径要开平方：否则点在圆内不是均匀分布，会大量挤在圆心附近，
      //    表现就是"新泡泡总是堆在中看不出来的一小团里"。
      const angle = next() * Math.PI * 2;
      const r = Math.sqrt(next()) * radius;
      return { x: Math.cos(angle) * r, y: Math.sin(angle) * r };
    },
  };
}

/**
 * 生成一个全局唯一 id。
 *
 * 用结构化的最小类型而不是 lib.dom 的 `Crypto`，这样同一份代码在
 * 浏览器和 Node（跑测试）里都能通过类型检查，不需要引入 @types/node。
 */
interface CryptoLike {
  randomUUID?: () => string;
  getRandomValues?: (array: Uint8Array) => Uint8Array;
}

export function newId(): string {
  const c = (globalThis as { crypto?: CryptoLike }).crypto;

  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID();
  }

  if (c && typeof c.getRandomValues === 'function') {
    const b = new Uint8Array(16);
    c.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40; // version 4
    b[8] = (b[8] & 0x3f) | 0x80; // variant 10
    let hex = '';
    for (const byte of b) hex += byte.toString(16).padStart(2, '0');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  throw new Error('当前环境没有 crypto，无法生成 id');
}
