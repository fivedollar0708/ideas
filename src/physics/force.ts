/**
 * 力导向布局。纯计算，不碰 DOM。
 *
 * 三种力：
 *  ① 斥力 —— 任意两个泡泡距离小于交互半径时互推，强度随距离平方反比衰减
 *  ② 向心 —— 所有泡泡被拉向心泡泡（世界原点），让星云聚拢不散架
 *  ③ 碰撞 —— 泡泡之间不能重叠，用椭圆归一化距离判断，做位置松弛
 *
 * ─────────────────────────────────────────────────────────────
 * 🔴 本文件最重要的一条设计：空间隔离是**结构性**的，不是调用方过滤的。
 *
 * 做法：spatial grid 按 spaceId 分成互不相通的桶（`grids: Map<spaceId, Grid>`），
 * `neighborsOf()` 只可能查到自己所属那个桶。
 * 也就是说，"空间 A 的泡泡影响不到空间 B" 不是靠每个人都记得写 `if (a.spaceId === b.spaceId)`，
 * 而是从数据结构上就不存在这条通路。少写一个 filter 不会造成 bug，因为根本没有 filter 可写。
 * ─────────────────────────────────────────────────────────────
 *
 * 另一个关键点：`step()` 使用**固定的 dt**（不是真实帧间隔）。这是"同一批数据
 * 每次打开布局都一样"的前提 —— 用真实 dt 的话，帧率抖动会让积分结果每次不同，
 * 于是用户摆好的星云每次刷新都变样。
 */

import { hashString } from '../rng';
import type { Id } from '../types';

/** 一个参与布局的泡泡。 */
export interface Body {
  id: Id;
  /** 所属空间。**所有力的计算都以此为界。** */
  spaceId: Id;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** 椭圆半径（world 单位）。 */
  rx: number;
  ry: number;
  /** 心泡泡：钉死在原位，不受力、不积分，但仍参与碰撞（挡住别的泡泡）。 */
  fixed: boolean;
  /** 用户双击锁定（阶段 3）：不受力、不积分，但可以被别的泡泡推动吗？不 —— 完全静止。 */
  pinned: boolean;
}

export interface ForceParams {
  /** 斥力系数（配合 1/d² 衰减）。 */
  repulsion: number;
  /** 向心系数。 */
  centering: number;
  /** 每 tick 速度保留比例（抖动越小越"黏"）。 */
  damping: number;
  /** 超出这个距离就互不施力。 */
  interactionRadius: number;
  /** 速度上限，防止 1/d² 在极近距离炸开。 */
  maxVelocity: number;
  /** 固定步长（秒）—— 保证确定性。 */
  dt: number;
  /** 每 tick 的 alpha 衰减比例。 */
  alphaDecay: number;
  /** alpha 低于它就彻底停下（CPU 归零）。 */
  alphaMin: number;
  /** 碰撞松弛强度 0..1，1 = 一帧内完全分开。 */
  collisionRelax: number;
}

/**
 * 🔴 这些常数的量级是"起手值"，不是调好的值 —— 手感需要看着实物调。
 * 改这里就够了，不要散落到别处。
 */
export const DEFAULT_PARAMS: ForceParams = {
  repulsion: 520000,
  centering: 0.9,
  damping: 0.885,
  interactionRadius: 260,
  maxVelocity: 900,
  dt: 1 / 60,
  alphaDecay: 0.0225,
  alphaMin: 0.002,
  collisionRelax: 0.62,
};

export type Tier = 'full' | 'eco' | 'asleep';

/** 一个空间一份网格：桶之间不互通。 */
type Grid = Map<string, Body[]>;

function cellKey(cx: number, cy: number): string {
  return `${cx},${cy}`;
}

export class ForceField {
  readonly params: ForceParams;

  /** 🔴 按空间分区的泡泡表。每个空间一份，互不可见。 */
  private readonly partitions = new Map<Id, Body[]>();
  /** 🔴 按空间分区的 spatial grid。这是空间隔离的执行点。 */
  private readonly grids = new Map<Id, Grid>();

  private active: Id | null = null;
  private alphaValue = 0;

  constructor(params: Partial<ForceParams> = {}) {
    this.params = { ...DEFAULT_PARAMS, ...params };
  }

  get alpha(): number {
    return this.alphaValue;
  }

  get activeSpaceId(): Id | null {
    return this.active;
  }

  /** 已登记的空间 id 列表（测试与调试用）。 */
  get spaceIds(): Id[] {
    return [...this.partitions.keys()];
  }

  bodiesOf(spaceId: Id): Body[] {
    return this.partitions.get(spaceId) ?? [];
  }

  /** 当前正在模拟的空间的泡泡。 */
  get activeBodies(): Body[] {
    return this.active ? this.bodiesOf(this.active) : [];
  }

  setSpaceBodies(spaceId: Id, bodies: Body[]): void {
    this.partitions.set(spaceId, bodies);
    this.rebuildGrid(spaceId);
  }

  removeSpace(spaceId: Id): void {
    this.partitions.delete(spaceId);
    this.grids.delete(spaceId);
    if (this.active === spaceId) this.active = null;
  }

  setActiveSpace(spaceId: Id | null): void {
    this.active = spaceId;
  }

  /** 唤醒布局。新泡泡落定、拖动、窗口变化时调用。 */
  wake(strength = 0.35): void {
    if (strength > this.alphaValue) this.alphaValue = strength;
  }

  /** 三档降频。让静止时 CPU 真的是 0，而不是一直在跑。 */
  tier(): Tier {
    if (this.alphaValue > 0.02) return 'full';
    if (this.alphaValue > this.params.alphaMin) return 'eco';
    return 'asleep';
  }

  /**
   * 查某个泡泡的邻居。
   *
   * 🔴 注意这里**没有任何 spaceId 过滤条件** —— 因为网格本身就是按空间分的，
   *    查到别的空间在结构上不可能。这正是"空间互不影响"的实现方式。
   */
  neighborsOf(body: Body): Body[] {
    const grid = this.grids.get(body.spaceId);
    if (!grid) return [];

    const { cellSize } = this.gridMetrics();
    const cx = Math.floor(body.x / cellSize);
    const cy = Math.floor(body.y / cellSize);
    const r2 = this.params.interactionRadius * this.params.interactionRadius;
    const out: Body[] = [];

    for (let ix = cx - 1; ix <= cx + 1; ix++) {
      for (let iy = cy - 1; iy <= cy + 1; iy++) {
        const bucket = grid.get(cellKey(ix, iy));
        if (!bucket) continue;
        for (const other of bucket) {
          if (other === body) continue;
          const dx = other.x - body.x;
          const dy = other.y - body.y;
          if (dx * dx + dy * dy <= r2) out.push(other);
        }
      }
    }
    return out;
  }

  /** 推进一步。只推进当前活动空间。 */
  step(): void {
    const spaceId = this.active;
    if (!spaceId) return;

    const bodies = this.partitions.get(spaceId);
    if (!bodies || bodies.length === 0) {
      this.decayAlpha();
      return;
    }

    this.rebuildGrid(spaceId);

    const p = this.params;
    const alpha = this.alphaValue;

    // ── ① 斥力 + ② 向心（累加进速度）──────────────────────
    for (const body of bodies) {
      if (body.fixed || body.pinned) {
        body.vx = 0;
        body.vy = 0;
        continue;
      }

      let vx = body.vx;
      let vy = body.vy;

      for (const other of this.neighborsOf(body)) {
        let dx = body.x - other.x;
        let dy = body.y - other.y;
        let d2 = dx * dx + dy * dy;

        // 🔴 两点完全重合时 1/d² 会发散成 Infinity/NaN。
        //    这里按两个 id 的哈希决定一个确定的方向，而不是用 Math.random ——
        //    否则同一份数据每次打开的散开方向都不同，布局就不可复现了。
        if (d2 < 1e-9) {
          const h = hashString(`${body.id}|${other.id}`);
          const angle = ((h % 3600) / 3600) * Math.PI * 2;
          dx = Math.cos(angle);
          dy = Math.sin(angle);
          d2 = 1;
        }

        const d = Math.sqrt(d2);
        // 强度随距离平方反比衰减
        const magnitude = (p.repulsion * alpha) / d2;
        vx += (dx / d) * magnitude * p.dt;
        vy += (dy / d) * magnitude * p.dt;
      }

      // 向心：拉向世界原点（心泡泡所在处）
      vx += -body.x * p.centering * alpha * p.dt;
      vy += -body.y * p.centering * alpha * p.dt;

      // 阻尼 + 限速
      vx *= p.damping;
      vy *= p.damping;

      const speed = Math.hypot(vx, vy);
      if (speed > p.maxVelocity) {
        const k = p.maxVelocity / speed;
        vx *= k;
        vy *= k;
      }

      body.vx = vx;
      body.vy = vy;
    }

    // ── 积分 ────────────────────────────────────────────
    for (const body of bodies) {
      if (body.fixed || body.pinned) continue;
      body.x += body.vx * p.dt;
      body.y += body.vy * p.dt;
    }

    // ── ③ 碰撞：位置松弛（比力更稳，不会因为刚性过强而抖）────
    this.resolveCollisions(bodies);

    // 位置变了，网格失效
    this.grids.delete(spaceId);
    this.rebuildGrid(spaceId);

    this.decayAlpha();
  }

  /** 椭圆碰撞。fixed/pinned 的泡泡不动，只推开对方。 */
  private resolveCollisions(bodies: Body[]): void {
    const relax = this.params.collisionRelax;

    for (const body of bodies) {
      for (const other of this.neighborsOf(body)) {
        // 每一对只处理一次
        if (body.id >= other.id) continue;

        const dx = other.x - body.x;
        const dy = other.y - body.y;

        // 🔴 用"椭圆归一化距离"而不是外接矩形：
        //    扁椭圆的包围盒在左右两侧有大片空的区域，用包围盒判断会让两个泡泡
        //    明明看着离得很远却被推开，星云会显得稀稀拉拉。
        //    归一化距离把椭圆当成"单位圆经过缩放"，贴合实际形状。
        const sumRx = body.rx + other.rx;
        const sumRy = body.ry + other.ry;
        if (sumRx <= 0 || sumRy <= 0) continue;

        const nx = dx / sumRx;
        const ny = dy / sumRy;
        const dist = Math.hypot(nx, ny);
        if (dist >= 1) continue; // 没重叠

        // 重合到无法判断方向时，同样用确定性哈希给个方向
        let ux = nx;
        let uy = ny;
        if (dist < 1e-6) {
          const h = hashString(`${body.id}#${other.id}`);
          const angle = ((h % 3600) / 3600) * Math.PI * 2;
          ux = Math.cos(angle);
          uy = Math.sin(angle);
        } else {
          ux /= dist;
          uy /= dist;
        }

        // 需要拉开多少（换算回 world 单位）
        const overlap = (1 - dist) * Math.min(sumRx, sumRy) * relax;
        const pushX = ux * overlap * 0.5;
        const pushY = uy * overlap * 0.5;

        const bodyMovable = !body.fixed && !body.pinned;
        const otherMovable = !other.fixed && !other.pinned;

        if (bodyMovable && otherMovable) {
          body.x -= pushX;
          body.y -= pushY;
          other.x += pushX;
          other.y += pushY;
        } else if (bodyMovable) {
          body.x -= pushX * 2;
          body.y -= pushY * 2;
        } else if (otherMovable) {
          other.x += pushX * 2;
          other.y += pushY * 2;
        }
      }
    }
  }

  private decayAlpha(): void {
    const next = this.alphaValue * (1 - this.params.alphaDecay);
    this.alphaValue = next < this.params.alphaMin ? 0 : next;
  }

  private gridMetrics(): { cellSize: number } {
    // 网格边长取交互半径 ⇒ 3×3 邻域恰好覆盖交互范围
    return { cellSize: Math.max(32, this.params.interactionRadius) };
  }

  private rebuildGrid(spaceId: Id): void {
    const bodies = this.partitions.get(spaceId);
    if (!bodies || bodies.length === 0) {
      this.grids.delete(spaceId);
      return;
    }

    const { cellSize } = this.gridMetrics();
    const grid: Grid = new Map();

    for (const body of bodies) {
      const key = cellKey(Math.floor(body.x / cellSize), Math.floor(body.y / cellSize));
      const bucket = grid.get(key);
      if (bucket) bucket.push(body);
      else grid.set(key, [body]);
    }

    this.grids.set(spaceId, grid);
  }
}
