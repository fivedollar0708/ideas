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

import type { Id, Idea, Space, TrashEntry, Viewport } from './types';

const DB_NAME = 'nebula';
const DB_VERSION = 1;

export const STORE_SPACES = 'spaces';
export const STORE_IDEAS = 'ideas';
export const STORE_META = 'meta';
export const STORE_TRASH = 'trash';

/** meta 表的 key 常量。视口用 `viewport:<spaceId>` 前缀，见 PROJECT-SPEC.md §4.4。 */
export const META_LAST_SPACE_ID = 'lastSpaceId';
export const META_SCHEMA_VERSION = 'schemaVersion';
export const viewportKey = (spaceId: Id): string => `viewport:${spaceId}`;

interface MetaRecord {
  key: string;
  value: unknown;
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
   * 清理过期回收站条目。**启动时与打开回收站时都要调**，因为启动时用户
   * 可能在别的空间，可能永远不打开回收站。
   *
   * 返回清理掉的条目数。
   */
  async purgeExpired(now: number = Date.now()): Promise<number> {
    const all = await this.getAllTrash();
    const expired = all.filter((e) => e.purgeAt > 0 && e.purgeAt <= now);
    if (expired.length === 0) return 0;

    await this.write([STORE_TRASH, STORE_SPACES, STORE_IDEAS], (tx) => {
      const trash = tx.objectStore(STORE_TRASH);
      const spaces = tx.objectStore(STORE_SPACES);
      const ideas = tx.objectStore(STORE_IDEAS);

      for (const entry of expired) {
        trash.delete(entry.id);
        if (entry.kind === 'space' && entry.space) {
          spaces.delete(entry.space.id);
          for (const idea of entry.ideas ?? []) ideas.delete(idea.id);
        } else if (entry.kind === 'idea' && entry.idea) {
          ideas.delete(entry.idea.id);
        }
      }
    });

    return expired.length;
  }
}
