/**
 * 同步的合并算法。**纯函数，不碰网络也不碰数据库** —— 这是全项目最需要被测试钉死的一块。
 *
 * 架构：记录级 LWW（Last-Write-Wins）+ 集合并集。不做三方合并（那要持久化第三份 base，
 * 还要处理"base 已经过时"的一整类情况）。
 *
 * 🔴 这套规则必须满足三条代数性质，否则多设备迟早会出现"两边都觉得自己对"的僵局：
 *    · **幂等**：merge(merge(a,b), b) === merge(a,b)
 *    · **交换**：merge(a,b) 与 merge(b,a) 的结果完全一致
 *    · **单调**：合并只会带来信息，不会把已经合并过的东西丢掉
 *    test/merge.ts 里逐条钉住了这三条。
 *
 * 🔴 交换律最容易在"时间戳完全相同"时被破坏：
 *    如果平局时写 `l.updatedAt >= r.updatedAt ? l : r`，那么 merge(a,b) 取 a、
 *    merge(b,a) 取 b —— 两台设备各取各的，永远收敛不到一起。
 *    所以平局必须用**与参数顺序无关**的确定性规则打破（取内容较大者，等价于 max）。
 */

import type { Id, Idea, Space } from '../types';

/** 同步文档的结构。GitHub 上的 data/ideas.json 就是这个形状。 */
export interface SyncDoc {
  version: number;
  /** 生成这份文档的时刻（诊断用，不参与合并）。 */
  savedAt: number;
  spaces: Space[];
  ideas: Idea[];
  /**
   * 已经被"彻底清理"的 id（空间与想法都放这里）。
   *
   * 🔴 为什么必须有这个列表：
   *    「清空回收站」在本地是**物理删除**，而合并是**并集**语义 ——
   *    清掉的东西会在下一次同步时从镜像里**又冒回来**（数据复活）。
   *    把"彻底删过"本身变成一条只增不减的信息，复活就被堵死了。
   *
   *    它只增不减 ⇒ 并集合并天然满足交换律与幂等性：
   *    两台设备各自清掉不同的东西，合并后两边都不会复活任何一个。
   *    反过来，如果按"[LWW]"去比这个列表，就会出现"A 清掉的被 B 的旧列表恢复"。
   */
  purged?: Id[];
}

/** 文档格式版本。将来改结构时用它做迁移。 */
export const DOC_VERSION = 1;

export function emptyDoc(now: number = Date.now()): SyncDoc {
  return { version: DOC_VERSION, savedAt: now, spaces: [], ideas: [], purged: [] };
}

// ─────────────────────────────────────────────────────────────
// 单条记录的合并
// ─────────────────────────────────────────────────────────────

/** 想法内容字段的确定性比较（越大越"新"）。只在时间戳打平时用到。 */
function compareIdeaContent(l: Idea, r: Idea): number {
  if (l.text !== r.text) return l.text > r.text ? 1 : -1;
  if (l.archived !== r.archived) return l.archived - r.archived;
  if (l.pinned !== r.pinned) return l.pinned - r.pinned;
  if (l.linksAlwaysOn !== r.linksAlwaysOn) return l.linksAlwaysOn - r.linksAlwaysOn;
  if (l.spaceId !== r.spaceId) return l.spaceId > r.spaceId ? 1 : -1;
  return 0;
}

/**
 * 文本类字段的赢家。
 * 🔴 用 `l 更优 ? l : r` 这种"取较大者"的写法，而不是 `l.updatedAt >= r.updatedAt ? l : r`：
 *    前者在平局时也与参数顺序无关（max 是交换的），后者不是。
 */
function pickByUpdatedAt(l: Idea, r: Idea): Idea {
  if (l.updatedAt !== r.updatedAt) return l.updatedAt > r.updatedAt ? l : r;
  return compareIdeaContent(l, r) >= 0 ? l : r;
}

/** 位置字段的赢家（只看 movedAt）。同样用 max 式的平局规则。 */
function pickByMovedAt(l: Idea, r: Idea): Idea {
  if (l.movedAt !== r.movedAt) return l.movedAt > r.movedAt ? l : r;
  if (l.x !== r.x) return l.x > r.x ? l : r;
  if (l.y !== r.y) return l.y > r.y ? l : r;
  return l;
}

/**
 * 合并同一条想法。
 *
 * 🔴 `updatedAt` 与 `movedAt` 分离的全部意义就在这里：
 *    文本按 `updatedAt` 比、位置按 `movedAt` 比，**互不干扰**。
 *    如果只有一个时间戳，在 A 上拖一下泡泡就会用本地时间戳把 B 上刚改的文本压掉。
 */
export function mergeIdea(l: Idea, r: Idea): Idea {
  const textWinner = pickByUpdatedAt(l, r);
  const posWinner = pickByMovedAt(l, r);
  return {
    ...textWinner,
    x: posWinner.x,
    y: posWinner.y,
    movedAt: posWinner.movedAt,
  };
}

/**
 * 合并同一个空间。
 *
 * ⚠️ 空间没有 movedAt，所以整个记录（名字 / 色板 / 删除标记）一起按 `updatedAt` 走 LWW。
 *
 * **由此带来的一个真实后果，值得知道**：
 * 如果 A 设备删了某空间、而 B 设备稍后又给这个空间改了名（B 的 updatedAt 更晚），
 * 合并结果是"空间复活"。我们没有把删除做成"粘住"的墓碑，理由是：
 * 这个产品的性格是"不想错过任何东西"，而"你刚碰过的东西悄悄消失"是更糟的体验。
 * 如果你更想要"删除永远赢"，把 pickSpace 改成"只要任意一方 deleted === 1 就取 deleted"
 * 即可（一行），但那会让"删了之后在另一台设备上恢复"变得不可能。
 */
export function mergeSpace(l: Space, r: Space): Space {
  if (l.updatedAt !== r.updatedAt) return l.updatedAt > r.updatedAt ? l : r;
  if (l.name !== r.name) return l.name > r.name ? l : r;
  if (l.hue !== r.hue) return l.hue > r.hue ? l : r;
  if (l.deleted !== r.deleted) return l.deleted > r.deleted ? l : r;
  if (l.purgeAt !== r.purgeAt) return l.purgeAt > r.purgeAt ? l : r;
  return l;
}

// ─────────────────────────────────────────────────────────────
// 整份文档的合并
// ─────────────────────────────────────────────────────────────

/**
 * 合并两份文档：按 id 求并集，同 id 的用 merge* 决定。
 *
 * 🔴 并集保证"一条都不丢" —— 这是"删除空间"与"另一台设备刚在这个空间加了想法"
 *    并发时想法不会消失的根本原因：想法始终在并集里，
 *    即使它所属的空间此刻处于"已删除"状态（它会在回收站里等着被恢复）。
 */
export function mergeDocs(local: SyncDoc, remote: SyncDoc): SyncDoc {
  const spaces = new Map<Id, Space>();
  for (const s of local.spaces) spaces.set(s.id, s);
  for (const s of remote.spaces) {
    const mine = spaces.get(s.id);
    spaces.set(s.id, mine ? mergeSpace(mine, s) : s);
  }

  const ideas = new Map<Id, Idea>();
  for (const i of local.ideas) ideas.set(i.id, i);
  for (const i of remote.ideas) {
    const mine = ideas.get(i.id);
    ideas.set(i.id, mine ? mergeIdea(mine, i) : i);
  }

  // 彻底删除列表按并集合并（只增不减）：任何一台设备清掉的东西，两边都不会再复活
  const purged = new Set<Id>([...(local.purged ?? []), ...(remote.purged ?? [])]);

  return {
    version: DOC_VERSION,
    savedAt: Math.max(local.savedAt, remote.savedAt),
    // 排序让结果稳定：同样的输入永远得到字节相同的输出（也就不会产生无意义的 commit）
    spaces: [...spaces.values()]
      .filter((sp) => !purged.has(sp.id))
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
    ideas: [...ideas.values()]
      .filter((i) => !purged.has(i.id))
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
    purged: [...purged].sort(),
  };
}

// ─────────────────────────────────────────────────────────────
// 差异报告（让同步"可见"）
// ─────────────────────────────────────────────────────────────

export interface MergeReport {
  /** 远端带来、本地原本没有的想法。 */
  addedFromRemote: Id[];
  /** 双方都有，但结果取了远端版本（本地被改写）。 */
  remoteWon: Id[];
  /** 双方都有，结果保持了本地版本。 */
  localWon: Id[];
  /** 远端带来、本地原本没有的空间。 */
  addedSpaces: Id[];
}

function sameIdea(a: Idea | undefined, b: Idea | undefined): boolean {
  if (!a || !b) return a === b;
  return (
    a.text === b.text &&
    a.spaceId === b.spaceId &&
    a.updatedAt === b.updatedAt &&
    a.movedAt === b.movedAt &&
    a.x === b.x &&
    a.y === b.y &&
    a.pinned === b.pinned &&
    a.linksAlwaysOn === b.linksAlwaysOn &&
    a.archived === b.archived
  );
}

/**
 * 对比"合并前的本地"与"合并结果"，得出该给用户看什么反馈。
 *
 * 同步必须**可见**：用户看不到任何变化时，不会相信备份真的在工作。
 */
export function diffDocs(localBefore: SyncDoc, merged: SyncDoc): MergeReport {
  const before = new Map(localBefore.ideas.map((i) => [i.id, i]));
  const beforeSpaces = new Set(localBefore.spaces.map((s) => s.id));

  const report: MergeReport = { addedFromRemote: [], remoteWon: [], localWon: [], addedSpaces: [] };

  for (const idea of merged.ideas) {
    const had = before.get(idea.id);
    if (!had) {
      report.addedFromRemote.push(idea.id);
      continue;
    }
    if (sameIdea(had, idea)) report.localWon.push(idea.id);
    else report.remoteWon.push(idea.id);
  }

  for (const space of merged.spaces) {
    if (!beforeSpaces.has(space.id)) report.addedSpaces.push(space.id);
  }

  return report;
}

/** 合并结果是不是"什么都没有"。用来拦住"把本地数据推成空"这种灾难。 */
export function isEmptyDoc(doc: SyncDoc): boolean {
  return doc.spaces.length === 0 && doc.ideas.length === 0;
}

/** 一条记录是否已被彻底清理。 */
export function isPurged(doc: SyncDoc, id: Id): boolean {
  return (doc.purged ?? []).includes(id);
}

/**
 * 判断两份文档的内容是否完全相同。
 *
 * 🔴 用来在 PUT 之前拦一道：内容一样就完全不发请求。
 *    GitHub 的每次 PUT 都会产生一个 commit，而且**关不掉**。
 *    不做这个比对的话，每 2 小时一次的空推送会把仓库历史刷成一条噪声长河。
 */
export function sameDoc(a: SyncDoc, b: SyncDoc): boolean {
  return serializeDoc(a) === serializeDoc(b);
}

/** 序列化成推给 GitHub 的文本。字段顺序固定、数组已排序 ⇒ 同样内容永远得到同样字节。 */
export function serializeDoc(doc: SyncDoc): string {
  return `${JSON.stringify(
    {
      version: doc.version,
      savedAt: doc.savedAt,
      spaces: doc.spaces,
      ideas: doc.ideas,
      purged: doc.purged ?? [],
    },
    null,
    2,
  )}\n`;
}
