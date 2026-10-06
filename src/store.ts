/**
 * IndexedDB 封装。**整个项目只有这一个文件允许直接碰数据库。**
 *
 * 三条铁律在代码层面的落点：
 *  ① "本地先成功，网络后同步" —— 所有写操作在 `tx.oncomplete`（事务真正提交）
 *     才 resolve，而不是在 `request.onsuccess`（语句排队成功）时。差别在于：
 *     前者表示数据已落盘，后者只表示"这条语句提交给了事务"。若用后者，
 *     可能出现"界面显示保存成功，实际事务后来中止了"的假成功。
 *  ② "仓库里没有密钥" —— token 不走这里，它在 localStorage 里密文存放。
 *  ③ "数据只有一份真身" —— 这里的 IndexedDB 就是唯一真身。GitHub 上的
 *     镜像与 backup 都在 sync 层，本文件完全不知道网络的存在。
 */

import { newId } from './rng';
import type { Id, Idea, Space, TrashEntry, Viewport } from './types';
import { SPACE_NAME_DEFAULT, SPACE_RESTORE_SUFFIX, TRASH_RETENTION_MS } from './types';

const DB_NAME = 'nebula';
const DB_VERSION = 1;

export const STORE_SPACES = 'spaces';
export const STORE_IDEAS = 'ideas';
export const STORE_META = 'meta';
export const STORE_TRASH = 'trash';

/** meta 表的 key 常量。视口用 `viewport:<spaceId>` 前缀，见 PROJECT-SPEC.md §4.4。 */
export const META_LAST_SPACE_ID = 'lastSpaceId';
export const META_SCHEMA_VERSION = 'schemaVersion';
/**
 * 已"彻底清理"的 id 列表（只增不减）。
 * 同步时它会跟着推到镜像，用来堵住"清掉的东西下次同步又冒回来"。
 */
export const META_PURGED_IDS = 'purgedIds';
/**
 * 本机这份数据的**主人**（GitHub 用户名）。
 *
 * 🔴 多用户最容易出事故的地方：A 在这台电脑上用过，B 再登录 ——
 *    合并是并集语义，于是 A 的私人想法会被推到 B 的仓库里。
 *    所以每次同步前都要核对这个值，不一致就拒绝同步。
 */
export const META_OWNER_HANDLE = 'ownerHandle';
export const viewportKey = (spaceId: Id): string => `viewport:${spaceId}`;

interface MetaRecord {
  key: string;
  value: unknown;
}

// ── 空间命名的纯函数（不需要数据库，可直接单测）────────────────

/** 在已占用的名字里挑一个不冲突的「未命名 N」。 */
export function nextSpaceName(taken: ReadonlySet<string>): string {
  for (let n = 1; n <= 999; n++) {
    const candidate = `${SPACE_NAME_DEFAULT} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${SPACE_NAME_DEFAULT} ${Date.now()}`;
}

/**
 * 恢复空间时解决命名冲突。
 * 规则：原名 → 「原名（恢复）」→「原名（恢复 2）」→ …
 */
export function uniqueSpaceName(desired: string, taken: ReadonlySet<string>): string {
  if (!taken.has(desired)) return desired;

  const first = `${desired}${SPACE_RESTORE_SUFFIX}`;
  if (!taken.has(first)) return first;

  for (let n = 2; n <= 999; n++) {
    const candidate = `${desired}（恢复 ${n}）`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${desired}（恢复 ${Date.now()}）`;
}

/**
 * 挑一个"用得最少"的色板索引。
 * 目的是让相邻创建的空间颜色不撞脸 —— 随机取色经常连撞三次，看着很乱。
 */
export function pickHue(spaces: readonly Space[]): number {
  const counts = new Array<number>(9).fill(0);
  for (const s of spaces) {
    const idx = ((s.hue % 9) + 9) % 9;
    counts[idx] += 1;
  }
  let best = 0;
  for (let h = 1; h < 9; h++) {
    if (counts[h] < counts[best]) best = h;
  }
  return best;
}

export class NebulaStore {
  private db: IDBDatabase | null = null;
  private opening: Promise<void> | null = null;

  /** 打开数据库。可重复调用，只会真正打开一次。 */
  open(): Promise<void> {
    if (this.db) return Promise.resolve();
    if (!this.opening) this.opening = this.doOpen();
    return this.opening;
  }

  close(): void {
    this.db?.close();
    this.db = null;
    this.opening = null;
  }

  get isOpen(): boolean {
    return this.db !== null;
  }

  private doOpen(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(
          new Error(
            '当前环境没有 IndexedDB。如果你是用 file:// 直接打开页面的，请改用 HTTP 服务（npm run serve）。',
          ),
        );
        return;
      }

      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = () => {
        const db = req.result;

        if (!db.objectStoreNames.contains(STORE_SPACES)) {
          const s = db.createObjectStore(STORE_SPACES, { keyPath: 'id' });
          s.createIndex('deleted', 'deleted');
        }

        if (!db.objectStoreNames.contains(STORE_IDEAS)) {
          const s = db.createObjectStore(STORE_IDEAS, { keyPath: 'id' });
          s.createIndex('spaceId', 'spaceId');
          s.createIndex('archived', 'archived');
          s.createIndex('updatedAt', 'updatedAt');
        }

        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: 'key' });
        }

        if (!db.objectStoreNames.contains(STORE_TRASH)) {
          const s = db.createObjectStore(STORE_TRASH, { keyPath: 'id' });
          s.createIndex('purgeAt', 'purgeAt');
        }
      };

      req.onsuccess = () => {
        const db = req.result;
        // 另一个标签页要升级数据库时，主动让路，避免它一直卡在 blocked
        db.onversionchange = () => {
          db.close();
          this.db = null;
          this.opening = null;
        };
        this.db = db;
        resolve();
      };

      req.onerror = () => reject(req.error ?? new Error('打开 IndexedDB 失败'));

      req.onblocked = () =>
        reject(new Error('IndexedDB 正被其它标签页占用，请关闭其它标签页后刷新重试'));
    });
  }

  private requireDb(): IDBDatabase {
    if (!this.db) throw new Error('数据库尚未打开，请先 await store.open()');
    return this.db;
  }

  // ── 底层读写helper ──────────────────────────────────────────

  private readOne<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
    const db = this.requireDb();
    return new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result as T | undefined);
      req.onerror = () => reject(req.error ?? new Error(`读取 ${store} 失败`));
    });
  }

  private readAll<T>(store: string): Promise<T[]> {
    const db = this.requireDb();
    return new Promise<T[]>((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result as T[]);
      req.onerror = () => reject(req.error ?? new Error(`读取 ${store} 全部失败`));
    });
  }

  private readByIndex<T>(store: string, index: string, key: IDBValidKey): Promise<T[]> {
    const db = this.requireDb();
    return new Promise<T[]>((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).index(index).getAll(key);
      req.onsuccess = () => resolve(req.result as T[]);
      req.onerror = () => reject(req.error ?? new Error(`按 ${index} 读取 ${store} 失败`));
    });
  }

  /**
   * 执行一次写事务。
   *
   * 🔴 resolve 挂在 `tx.oncomplete` 上 —— 这是"本地先成功"的技术保证。
   *    调用方 await 到之后，可以确信数据已经真正提交，网络同步随后再做。
   */
  private write(stores: string[], mutate: (tx: IDBTransaction) => void): Promise<void> {
    const db = this.requireDb();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(stores, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 写事务失败'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 写事务被中止'));

      try {
        mutate(tx);
      } catch (err) {
        try {
          tx.abort();
        } catch {
          /* 事务可能已经结束，忽略 */
        }
        reject(err);
      }
    });
  }

  // ── spaces ─────────────────────────────────────────────────

  putSpace(space: Space): Promise<void> {
    return this.write([STORE_SPACES], (tx) => {
      tx.objectStore(STORE_SPACES).put(space);
    });
  }

  getSpace(id: Id): Promise<Space | undefined> {
    return this.readOne<Space>(STORE_SPACES, id);
  }

  /** 取全部空间。默认排除已删除的（回收站里的）。 */
  async getAllSpaces(includeDeleted = false): Promise<Space[]> {
    const all = await this.readAll<Space>(STORE_SPACES);
    const list = includeDeleted ? all : all.filter((s) => s.deleted === 0);
    return list.sort((a, b) => a.createdAt - b.createdAt);
  }

  hardDeleteSpace(id: Id): Promise<void> {
    return this.write([STORE_SPACES], (tx) => {
      tx.objectStore(STORE_SPACES).delete(id);
    });
  }

  // ── ideas ──────────────────────────────────────────────────

  putIdea(idea: Idea): Promise<void> {
    return this.write([STORE_IDEAS], (tx) => {
      tx.objectStore(STORE_IDEAS).put(idea);
    });
  }

  /** 批量写入，单事务 —— 多设备合并拉回大量记录时用。 */
  putIdeas(ideas: Idea[]): Promise<void> {
    if (ideas.length === 0) return Promise.resolve();
    return this.write([STORE_IDEAS], (tx) => {
      const s = tx.objectStore(STORE_IDEAS);
      for (const idea of ideas) s.put(idea);
    });
  }

  getIdea(id: Id): Promise<Idea | undefined> {
    return this.readOne<Idea>(STORE_IDEAS, id);
  }

  getAllIdeas(): Promise<Idea[]> {
    return this.readAll<Idea>(STORE_IDEAS);
  }

  /** 取某个空间的想法。默认不含归档 —— 归档的定义就是"从星云隐藏"。 */
  async getIdeasBySpace(spaceId: Id, includeArchived = false): Promise<Idea[]> {
    const list = await this.readByIndex<Idea>(STORE_IDEAS, 'spaceId', spaceId);
    const filtered = includeArchived ? list : list.filter((i) => i.archived === 0);
    return filtered.sort((a, b) => a.createdAt - b.createdAt);
  }

  countIdeasBySpace(spaceId: Id): Promise<number> {
    const db = this.requireDb();
    return new Promise<number>((resolve, reject) => {
      const tx = db.transaction(STORE_IDEAS, 'readonly');
      const req = tx.objectStore(STORE_IDEAS).index('spaceId').count(spaceId);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('统计想法数量失败'));
    });
  }

  hardDeleteIdea(id: Id): Promise<void> {
    return this.write([STORE_IDEAS], (tx) => {
      tx.objectStore(STORE_IDEAS).delete(id);
    });
  }

  // ── meta ───────────────────────────────────────────────────

  async getMeta<T>(key: string): Promise<T | undefined> {
    const rec = await this.readOne<MetaRecord>(STORE_META, key);
    return rec?.value as T | undefined;
  }

  setMeta(key: string, value: unknown): Promise<void> {
    return this.write([STORE_META], (tx) => {
      tx.objectStore(STORE_META).put({ key, value } satisfies MetaRecord);
    });
  }

  deleteMeta(key: string): Promise<void> {
    return this.write([STORE_META], (tx) => {
      tx.objectStore(STORE_META).delete(key);
    });
  }

  /**
   * 视口状态。按空间分别记忆，**不进同步**（本机偏好）。
   * 若加在 Space 上跟着同步，手机拨到的缩放会把电脑上的也改掉。
   */
  getViewport(spaceId: Id): Promise<Viewport | undefined> {
    return this.getMeta<Viewport>(viewportKey(spaceId));
  }

  setViewport(spaceId: Id, vp: Viewport): Promise<void> {
    return this.setMeta(viewportKey(spaceId), vp);
  }

  /** 本机数据的主人（GitHub 用户名）。null = 还没归属过任何账号。 */
  async getOwnerHandle(): Promise<string | null> {
    const value = await this.getMeta<string>(META_OWNER_HANDLE);
    return typeof value === 'string' && value !== '' ? value : null;
  }

  async setOwnerHandle(handle: string): Promise<void> {
    await this.setMeta(META_OWNER_HANDLE, handle);
  }

  /**
   * 清空本机全部数据。
   *
   * 🔴 只在一件事上用它：**切换账号**。
   *    必须由用户明确确认（界面会弹确认框并说明"原账号的数据在他的备份里不会丢"），
   *    因为这一步之后，本机就再也看不到原来那个账号的数据了。
   */
  wipeAllData(): Promise<void> {
    return this.write([STORE_SPACES, STORE_IDEAS, STORE_TRASH, STORE_META], (tx) => {
      tx.objectStore(STORE_SPACES).clear();
      tx.objectStore(STORE_IDEAS).clear();
      tx.objectStore(STORE_TRASH).clear();
      tx.objectStore(STORE_META).clear();
    });
  }

  /** 已被彻底清理的 id（空间与想法混合）。 */
  async getPurgedIds(): Promise<Id[]> {
    const list = await this.getMeta<Id[]>(META_PURGED_IDS);
    return Array.isArray(list) ? list : [];
  }

  /** 追加彻底清理记录。**只增不减** —— 这是它可安全合并的前提。 */
  async addPurgedIds(ids: readonly Id[]): Promise<void> {
    if (ids.length === 0) return;
    const existing = new Set(await this.getPurgedIds());
    for (const id of ids) existing.add(id);
    await this.setMeta(META_PURGED_IDS, [...existing].sort());
  }

  async getLastSpaceId(): Promise<Id | undefined> {
    return this.getMeta<Id>(META_LAST_SPACE_ID);
  }

  setLastSpaceId(id: Id): Promise<void> {
    return this.setMeta(META_LAST_SPACE_ID, id);
  }

  // ── trash ──────────────────────────────────────────────────

  putTrash(entry: TrashEntry): Promise<void> {
    return this.write([STORE_TRASH], (tx) => {
      tx.objectStore(STORE_TRASH).put(entry);
    });
  }

  getAllTrash(): Promise<TrashEntry[]> {
    return this.readAll<TrashEntry>(STORE_TRASH);
  }

  deleteTrash(id: Id): Promise<void> {
    return this.write([STORE_TRASH], (tx) => {
      tx.objectStore(STORE_TRASH).delete(id);
    });
  }

  clearTrash(): Promise<void> {
    return this.write([STORE_TRASH], (tx) => {
      tx.objectStore(STORE_TRASH).clear();
    });
  }

  /**
   * 删除空间 → 回收站。
   *
   * 🔴 采用「墓碑式」而不是把记录搬走：
   *    空间留在 spaces 表里但标记 deleted=1 + purgeAt，想法也留在 ideas 表里不动。
   *    同时在 trash 表写一份**完整快照**（空间本体 + 它的全部想法）。
   *
   *    为什么两者都要？
   *    - 墓碑让"恢复"变成一次极轻的翻转，不需要把大量记录搬回来，
   *      也不会因为搬到一半失败而留下半截数据；
   *    - 快照是**第二份保险**：万一过期清理逻辑出 bug、或者 ideas 表被误删，
   *      快照还能把整个空间救回来。删除是唯一不可逆的操作，值得存两份。
   *
   *    ⚠️ PROJECT-SPEC.md §5.4 同时写了「从 spaces 表移出」和「标 deleted=1」，
   *       是自相矛盾的。这里按后者实现，因为墓碑式对"不想错过任何想法"更安全。
   */
  async deleteSpaceToTrash(spaceId: Id, now: number = Date.now()): Promise<TrashEntry | null> {
    const space = await this.getSpace(spaceId);
    if (!space || space.deleted === 1) return null;

    // 含归档的想法也要带走 —— 归档不等于删除，恢复时它也该回来
    const ideas = await this.getIdeasBySpace(spaceId, true);
    const purgeAt = now + TRASH_RETENTION_MS;

    const tombstone: Space = { ...space, deleted: 1, purgeAt, updatedAt: now };
    const entry: TrashEntry = {
      id: space.id,
      kind: 'space',
      deletedAt: now,
      purgeAt,
      space: tombstone,
      ideas,
    };

    await this.write([STORE_SPACES, STORE_TRASH], (tx) => {
      tx.objectStore(STORE_SPACES).put(tombstone);
      tx.objectStore(STORE_TRASH).put(entry);
    });

    return entry;
  }

  /**
   * 从回收站恢复。名字冲突时自动加「（恢复）」后缀。
   *
   * 🔴 恢复时只补回**库里已经不存在**的想法，绝不覆盖现有记录。
   *    否则"在 A 设备恢复了一个空间"会把它在 B 设备上的改动冲掉。
   */
  async restoreFromTrash(trashId: Id, now: number = Date.now()): Promise<Space | null> {
    const entries = await this.getAllTrash();
    const entry = entries.find((e) => e.id === trashId && e.kind === 'space');
    if (!entry?.space) return null;

    const allSpaces = await this.readAll<Space>(STORE_SPACES);
    const takenNames = new Set(allSpaces.filter((s) => s.deleted === 0).map((s) => s.name));
    const name = uniqueSpaceName(entry.space.name, takenNames);

    const restored: Space = { ...entry.space, name, deleted: 0, purgeAt: 0, updatedAt: now };

    const existingIds = new Set((await this.readAll<Idea>(STORE_IDEAS)).map((i) => i.id));
    const missing = (entry.ideas ?? []).filter((i) => !existingIds.has(i.id));

    await this.write([STORE_SPACES, STORE_IDEAS, STORE_TRASH], (tx) => {
      tx.objectStore(STORE_SPACES).put(restored);
      const ideas = tx.objectStore(STORE_IDEAS);
      for (const idea of missing) ideas.put({ ...idea, spaceId: restored.id });
      tx.objectStore(STORE_TRASH).delete(entry.id);
    });

    return restored;
  }

  /** 创建一个新空间。hue 自动挑用得最少的那个。 */
  async createSpace(now: number = Date.now()): Promise<Space> {
    const all = await this.readAll<Space>(STORE_SPACES);
    const taken = new Set(all.filter((s) => s.deleted === 0).map((s) => s.name));

    const space: Space = {
      id: newId(),
      name: nextSpaceName(taken),
      hue: pickHue(all),
      createdAt: now,
      updatedAt: now,
      deleted: 0,
      purgeAt: 0,
    };

    await this.putSpace(space);
    return space;
  }

  /** 重命名空间。只改名字，不碰其他字段。 */
  async renameSpace(spaceId: Id, name: string, now: number = Date.now()): Promise<Space | null> {
    const space = await this.getSpace(spaceId);
    if (!space) return null;
    const next: Space = { ...space, name, updatedAt: now };
    await this.putSpace(next);
    return next;
  }

  /**
   * 清理过期回收站条目。**启动时与打开回收站时都要调**，因为启动时用户
   * 可能在别的空间，可能永远不打开回收站。
   *
   * 返回清理掉的条目数。
   */
  async purgeExpired(now: number = Date.now()): Promise<number> {
    const all = await this.getAllTrash();
    const expired = all.filter((e) => e.purgeAt > 0 && e.purgeAt <= now);
    if (expired.length === 0) return 0;
    await this.purgeEntries(expired);
    return expired.length;
  }

  /** 清空回收站（用户手动点"清空"）。返回清理掉的条目数。 */
  async purgeAllTrash(): Promise<number> {
    const all = await this.getAllTrash();
    if (all.length === 0) return 0;
    await this.purgeEntries(all);
    return all.length;
  }

  /**
   * 只清理回收站里的某一条。
   *
   * 🔴 存在的理由：自检（diagnostics）必须能"跑完不留痕迹"，但绝不能顺手
   *    把用户回收站里真实的东西也删了。所以自检用它，而不是 purgeAllTrash。
   *    任何"清理自己造的数据"的场景都该用它。
   */
  async purgeTrashEntry(trashId: Id): Promise<boolean> {
    const all = await this.getAllTrash();
    const entry = all.find((e) => e.id === trashId);
    if (!entry) return false;
    await this.purgeEntries([entry]);
    return true;
  }

  /**
   * 真正物理删除一批回收站条目。
   *
   * ⚠️ 这是全项目**唯一**的不可逆操作。它同时删三处：
   *    回收站条目、空间记录、以及快照里列出的每一条想法。
   *    所以它只该被 purgeExpired / purgeAllTrash 调用，不要在别的地方直接用。
   */
  private async purgeEntries(entries: readonly TrashEntry[]): Promise<void> {
    // 记下这次真正删掉了哪些 id —— 之后要写进 purged 列表，
    // 否则它们会在下次同步时从镜像里复活
    const gone: Id[] = [];

    await this.write([STORE_TRASH, STORE_SPACES, STORE_IDEAS], (tx) => {
      const trash = tx.objectStore(STORE_TRASH);
      const spaces = tx.objectStore(STORE_SPACES);
      const ideas = tx.objectStore(STORE_IDEAS);

      for (const entry of entries) {
        trash.delete(entry.id);
        if (entry.kind === 'space' && entry.space) {
          spaces.delete(entry.space.id);
          gone.push(entry.space.id);
          for (const idea of entry.ideas ?? []) {
            ideas.delete(idea.id);
            gone.push(idea.id);
          }
        } else if (entry.kind === 'idea' && entry.idea) {
          ideas.delete(entry.idea.id);
          gone.push(entry.idea.id);
        }
      }
    });

    await this.addPurgedIds(gone);
  }
}
