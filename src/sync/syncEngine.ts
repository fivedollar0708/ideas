/**
 * 同步引擎。
 *
 * 铁律 #1 在代码里的形状：**本地先成功，网络后同步**。
 * 整个同步过程都包在 try/catch 里，任何失败都不影响已经落到 IndexedDB 的数据；
 * 用户最多看到状态条上多一行"备份失败"，录入照旧。
 *
 * 三条数据安全措施（按重要性排序）：
 *  ① **fail loud**：远端内容解析失败 / 为空 / 编码不是 base64 ⇒ 立刻 throw，
 *     **绝不进入合并流程**。否则"解析失败 → 解析成空 → 合并成空 → 推上去"= 数据全没。
 *  ② **空结果拒绝推送**：合并结果为空而本地非空时拒发 PUT 并告警。
 *  ③ **backup 回退**：每次推之前把远端原文一字不改地存一份；
 *     `fallbackToBackup: true` 时改用 backup 作为远端来源（不用重新部署代码就能回退）。
 *
 * 并发：
 *  · `navigator.locks` 包住临界区，避免两个标签页同时推造成来回覆盖；
 *  · `BroadcastChannel` 通知其它标签页"数据变了，刷新 UI"，但**不触发它们同步**（否则来回打）。
 */

import type { RemoteFile, RemoteStore, SyncErrorKind } from './github';
import { SyncError } from './github';
import {
  diffDocs,
  emptyDoc,
  isEmptyDoc,
  mergeDocs,
  sameDoc,
  serializeDoc,
  type MergeReport,
  type SyncDoc,
} from './merge';

/** 本地改动后多久自动同步。 */
export const DIRTY_DEBOUNCE_MS = 60_000;
/** 自动推送的最小间隔。GitHub 每次 PUT 都会产生一个 commit 且关不掉。 */
export const PUSH_THROTTLE_MS = 2 * 60 * 60_000;
/** 版本冲突时重新合并重试的次数。 */
export const MAX_CONFLICT_RETRIES = 2;

export interface SyncConfig {
  version: number;
  file: string;
  backupFile: string;
  /**
   * 🔴 这个 flag 是**从远端读的** —— 所以改一行 JSON 就能触发回退，
   *    不需要重新部署代码。这是刻意设计的，别改成"需要重新部署"。
   */
  fallbackToBackup: boolean;
  savedAt: number;
}

export const CONFIG_PATH = 'data/sync.config.json';

export function defaultConfig(now: number = Date.now()): SyncConfig {
  return {
    version: 1,
    file: 'data/ideas.json',
    backupFile: 'data/ideas.backup.json',
    fallbackToBackup: false,
    savedAt: now,
  };
}

export type SyncStatusKind = 'local-only' | 'idle' | 'pulling' | 'pushing' | 'merged' | 'error';

export interface SyncSnapshot {
  status: SyncStatusKind;
  detail: string;
  lastSyncAt: number | null;
  lastError: string | null;
  dirty: boolean;
  /** 本次同步从远端拿回来 / 被远端赢走多少条（用于 UI 反馈）。 */
  lastAdded: number;
  lastRemoteWon: number;
}

export interface SyncDeps {
  /** 当前远端。null = 还没配置（纯本地模式）。 */
  remote: RemoteStore | null;
  readLocal(): Promise<SyncDoc>;
  writeLocal(doc: SyncDoc): Promise<void>;
  /** 合并落地后的反馈（把差异画到 UI 上）。 */
  onMerged?(report: MergeReport, doc: SyncDoc, source: SyncDoc): void;
  onState?(snapshot: SyncSnapshot): void;
  /** 别的标签页更新了本地数据 —— 只刷新 UI，不要再同步。 */
  onExternalUpdate?(): void;
}

const SYNC_KINDS: ReadonlySet<string> = new Set([
  'auth',
  'notfound',
  'conflict',
  'ratelimit',
  'network',
  'content',
  'unknown',
]);

/**
 * 取错误的分类。
 *
 * 先看 `instanceof SyncError`，再退一步看有没有合法的 `kind` 字段 ——
 * 这样在自动化测试里注入一个"模拟远端"抛出的普通错误对象也能走到正确的分支
 * （否则 auth / network 这些分支永远测不到，而那正是最需要测的几条）。
 */
function errorKind(err: unknown): SyncErrorKind {
  if (err instanceof SyncError) return err.kind;
  const kind = (err as { kind?: unknown })?.kind;
  if (typeof kind === 'string' && SYNC_KINDS.has(kind)) return kind as SyncErrorKind;
  return 'unknown';
}

const LOCK_NAME = 'nebula-sync';
const CHANNEL_NAME = 'nebula-sync';

export class SyncEngine {
  private snapshotValue: SyncSnapshot = {
    status: 'local-only',
    detail: '只存在这台设备',
    lastSyncAt: null,
    lastError: null,
    dirty: false,
    lastAdded: 0,
    lastRemoteWon: 0,
  };

  private lastPushAt = 0;
  private timer = 0;
  private running = false;
  private channel: BroadcastChannel | null = null;
  /** 上一次成功写进 backup 的内容，用来避免"内容没变也产生一个 commit"。 */
  private lastBackupBody: string | null = null;

  constructor(private deps: SyncDeps) {
    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(CHANNEL_NAME);
      this.channel.addEventListener('message', (e) => {
        if ((e.data as { type?: string })?.type === 'local-updated') {
          this.deps.onExternalUpdate?.();
        }
      });
    }
    this.emit();
  }

  get snapshot(): SyncSnapshot {
    return this.snapshotValue;
  }

  setRemote(remote: RemoteStore | null): void {
    this.deps = { ...this.deps, remote };
    if (!remote) {
      this.patch({ status: 'local-only', detail: '只存在这台设备', dirty: false });
    } else if (this.snapshotValue.status === 'local-only') {
      this.patch({ status: 'idle', detail: '等待同步' });
    }
  }

  /** 标脏：本地有新东西了，稍后自动推。 */
  markDirty(): void {
    this.patch({ dirty: true });
    window.clearTimeout(this.timer);
    // 🔴 60s 防抖：连续录入不会每次都推
    this.timer = window.setTimeout(() => void this.sync(), DIRTY_DEBOUNCE_MS);
  }

  private patch(next: Partial<SyncSnapshot>): void {
    this.snapshotValue = { ...this.snapshotValue, ...next };
    this.emit();
  }

  private emit(): void {
    this.deps.onState?.(this.snapshotValue);
  }

  /** 跑一轮完整的同步。force = true 时绕过节流与 dirty 判断（手动按钮、关页面时用）。 */
  async sync(opts: { force?: boolean } = {}): Promise<void> {
    const remote = this.deps.remote;
    if (!remote) {
      this.patch({ status: 'local-only', detail: '只存在这台设备' });
      return;
    }
    if (this.running) return; // 同一标签页内不重入

    const run = async (): Promise<void> => {
      this.running = true;
      try {
        await this.runOnce(remote, opts.force === true);
      } finally {
        this.running = false;
      }
    };

    // 🔴 跨标签页互斥。两个标签页同时推会来回覆盖（而且每次都要重试一遍冲突）
    if (typeof navigator !== 'undefined' && navigator.locks) {
      await navigator.locks.request(LOCK_NAME, run);
    } else {
      await run();
    }
  }

  private async runOnce(remote: RemoteStore, force: boolean): Promise<void> {
    this.patch({ status: 'pulling', detail: '正在同步…', lastError: null });

    try {
      // ── 1. 读远端配置 ──
      let config = defaultConfig();
      const configFile = await remote.readFile(CONFIG_PATH);
      if (configFile) {
        config = parseConfig(configFile);
      } else {
        // 首次同步：把默认配置创建出来
        await remote.writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, '初始化同步配置');
      }

      // ── 2. 决定"远端"的来源 ──
      let remoteDoc: SyncDoc;

      if (config.fallbackToBackup) {
        // 🔴 回退：改用 backup 作为远端来源。
        //    触发方式是"远端 config 里的一行 JSON" —— 所以不用重新部署代码。
        const backup = await remote.readFile(config.backupFile);
        if (!backup) {
          throw new SyncError('content', '配置要求从备份回退，但备份文件不存在');
        }
        remoteDoc = parseDoc(backup.text, '备份文件');
        this.patch({ detail: '正在从备份恢复…' });

        // 🔴 恢复完必须把 flag **写回远端**。
        //    只改内存里的 config 是个危险的半成品：远端一直是 true，
        //    于是每一轮同步都会再从 backup 恢复一次，把更新的数据反复覆盖掉。
        config = { ...config, fallbackToBackup: false, savedAt: Date.now() };
        await remote.writeFile(
          CONFIG_PATH,
          `${JSON.stringify(config, null, 2)}\n`,
          '回退完成，清除 fallbackToBackup',
          configFile?.sha,
        );
      } else {
        const file = await remote.readFile(config.file);
        if (file) {
          remoteDoc = parseDoc(file.text, '远端数据');
        } else {
          // 文件还不存在 ⇒ 首次同步，视为空文档
          remoteDoc = emptyDoc();
        }
      }

      // ── 3. 本地 ──
      const localDoc = await this.deps.readLocal();

      // ── 4. 合并 ──
      const merged = mergeDocs(localDoc, remoteDoc);

      // ── 5. 安全阀：合并结果为空而本地非空 ⇒ 拒绝推送 ──
      if (isEmptyDoc(merged) && !isEmptyDoc(localDoc)) {
        throw new SyncError(
          'content',
          '合并结果为空但本地有数据 —— 已拒绝推送，并保留本地数据不动',
        );
      }

      // ── 6. 先落本地（铁律 #1：本地先成功）──
      const report = diffDocs(localDoc, merged);
      const changedLocally =
        report.addedFromRemote.length > 0 ||
        report.remoteWon.length > 0 ||
        report.addedSpaces.length > 0;

      if (changedLocally) {
        await this.deps.writeLocal(merged);
        this.deps.onMerged?.(report, merged, localDoc);
        // 别的标签页也刷新一下界面（但不让它再同步，否则会来回打）
        this.channel?.postMessage({ type: 'local-updated' });
      }

      // ── 7. 推送 ──
      const throttled = !force && Date.now() - this.lastPushAt < PUSH_THROTTLE_MS;
      const needPush = this.snapshotValue.dirty || changedLocally;

      if (!needPush) {
        this.patch({
          status: changedLocally ? 'merged' : 'idle',
          detail: changedLocally ? `已合并 ${report.addedFromRemote.length} 条` : '已是最新',
          lastSyncAt: Date.now(),
          lastAdded: report.addedFromRemote.length,
          lastRemoteWon: report.remoteWon.length,
        });
        return;
      }

      if (throttled && !force) {
        // 节流中：本次只拉不推，保持 dirty，等下一次
        this.patch({
          status: changedLocally ? 'merged' : 'idle',
          detail: `已合并 ${report.addedFromRemote.length} 条 · 稍后推送`,
          lastSyncAt: Date.now(),
          lastAdded: report.addedFromRemote.length,
          lastRemoteWon: report.remoteWon.length,
        });
        return;
      }

      // 内容与远端完全一样 ⇒ 完全不发请求。GitHub 每次 PUT 都会留一个 commit
      if (!config.fallbackToBackup && sameDoc(merged, remoteDoc)) {
        this.lastPushAt = Date.now();
        this.patch({
          status: 'idle',
          detail: '已是最新（无需推送）',
          lastSyncAt: Date.now(),
          dirty: false,
          lastAdded: report.addedFromRemote.length,
          lastRemoteWon: report.remoteWon.length,
        });
        return;
      }

      this.patch({ status: 'pushing', detail: '正在备份…' });

      // 🔴 推之前先备份：把远端原文一字不改地存到 backup
      await this.writeBackupIfChanged(remote, config, remoteDoc);

      await this.pushWithRetry(remote, config, localDoc);

      this.lastPushAt = Date.now();
      this.patch({
        status: 'idle',
        detail: `已备份 · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`,
        lastSyncAt: Date.now(),
        dirty: false,
        lastError: null,
        lastAdded: report.addedFromRemote.length,
        lastRemoteWon: report.remoteWon.length,
      });
    } catch (err) {
      const kind = errorKind(err);
      const message = err instanceof Error ? err.message : String(err);

      this.patch({
        status: 'error',
        detail: detailFor(kind, message),
        lastError: message,
        // 🔴 凭据无效时清理 dirty，避免每次操作都重试一遍必然失败的请求
        dirty: kind === 'auth' ? false : this.snapshotValue.dirty,
      });

      // 🔴 不把错误继续往上抛：状态里已经带了原因，界面会显示"点此重新配置"。
      //    抛出去只会变成"未处理的 Promise 拒绝"，把调用方（尤其是自动化脚本）打断。
    }
  }

  /** 把远端原文存到 backup。内容没变就跳过（否则每次同步都会多一个 commit）。 */
  private async writeBackupIfChanged(
    remote: RemoteStore,
    config: SyncConfig,
    remoteDoc: SyncDoc,
  ): Promise<void> {
    // 用"把远端文档按同一格式再序列化一次"作为比较基准：
    // 只要内容语义相同就不重写 backup。
    const body = serializeDoc(remoteDoc);
    if (this.lastBackupBody === body) return;

    const existing = await remote.readFile(config.backupFile);
    if (existing && normalizeWhitespace(existing.text) === normalizeWhitespace(body)) {
      this.lastBackupBody = body;
      return;
    }

    await remote.writeFile(
      config.backupFile,
      body,
      '同步前备份（回退用）',
      existing?.sha,
    );
    this.lastBackupBody = body;
  }

  /** 推送，遇到 409 就重新拉取 + 重新合并 + 再推。 */
  private async pushWithRetry(
    remote: RemoteStore,
    config: SyncConfig,
    localSnapshot: SyncDoc,
  ): Promise<void> {
    let doc = mergeDocs(localSnapshot, await this.deps.readLocal());

    for (let attempt = 0; attempt <= MAX_CONFLICT_RETRIES; attempt++) {
      const current = await remote.readFile(config.file);

      if (current) {
        const remoteDoc = parseDoc(current.text, '远端数据');
        doc = mergeDocs(doc, remoteDoc);

        // 别人刚推过同样的内容 ⇒ 无事可做
        if (sameDoc(doc, remoteDoc)) return;
      }

      try {
        await remote.writeFile(config.file, serializeDoc(doc), `同步想法（${doc.ideas.length} 条）`, current?.sha);
        // 推完可能又并进来一些东西，落一次本地保持一致
        await this.deps.writeLocal(doc);
        return;
      } catch (err) {
        const kind = errorKind(err);
        // 🔴 冲突是**幂等**的，重试永远安全。其它错误（凭据/内容）重试没意义
        if (kind !== 'conflict' || attempt === MAX_CONFLICT_RETRIES) throw err;
        // 重新读一遍再合一次
        doc = mergeDocs(doc, await this.deps.readLocal());
      }
    }
  }

  destroy(): void {
    window.clearTimeout(this.timer);
    this.channel?.close();
  }
}

// ─────────────────────────────────────────────────────────────
// 解析（fail loud 的落点）
// ─────────────────────────────────────────────────────────────

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function detailFor(kind: SyncErrorKind, message: string): string {
  switch (kind) {
    case 'auth':
      return '备份失败：凭据无效或无权限 · 点此重新配置';
    case 'ratelimit':
      return '备份失败：GitHub 限速 · 稍后自动重试';
    case 'network':
      return '备份失败：网络不通 · 本地数据不受影响';
    case 'content':
      return '备份失败：远端内容异常 · 已停止同步以保护本地数据';
    case 'conflict':
      return '备份失败：版本冲突 · 会重试';
    default:
      return `备份失败：${message}`;
  }
}

function parseConfig(file: RemoteFile): SyncConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(file.text);
  } catch (err) {
    throw new SyncError(
      'content',
      `sync.config.json 解析失败：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new SyncError('content', 'sync.config.json 不是对象');
  }

  const cfg = raw as Partial<SyncConfig>;
  const base = defaultConfig();

  return {
    version: typeof cfg.version === 'number' ? cfg.version : base.version,
    file: typeof cfg.file === 'string' && cfg.file !== '' ? cfg.file : base.file,
    backupFile:
      typeof cfg.backupFile === 'string' && cfg.backupFile !== '' ? cfg.backupFile : base.backupFile,
    // 只有严格等于 true 才回退 —— 写错字符串不会误触发
    fallbackToBackup: cfg.fallbackToBackup === true,
    savedAt: typeof cfg.savedAt === 'number' ? cfg.savedAt : base.savedAt,
  };
}

/**
 * 解析远端文档。
 *
 * 🔴 这里是"最恐怖的那类失败"的闸门：任何一条不对都直接 throw，
 *    **绝不返回一个"空文档"糊过去**。返回空文档的后果是：
 *    合并时远端为空 → 结果只剩本地 → 看起来没事；
 *    但如果本地也恰好是空的（比如换了台设备），就会把空推上去，数据全没。
 */
export function parseDoc(text: string, label: string): SyncDoc {
  if (text.trim() === '') {
    throw new SyncError('content', `${label}为空字符串 —— 拒绝继续`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new SyncError(
      'content',
      `${label}解析失败（可能被截断或损坏）：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (typeof raw !== 'object' || raw === null) {
    throw new SyncError('content', `${label}不是对象`);
  }

  const doc = raw as Partial<SyncDoc>;
  if (!Array.isArray(doc.spaces) || !Array.isArray(doc.ideas)) {
    throw new SyncError('content', `${label}缺少 spaces / ideas 数组`);
  }

  return {
    version: typeof doc.version === 'number' ? doc.version : 1,
    savedAt: typeof doc.savedAt === 'number' ? doc.savedAt : 0,
    spaces: doc.spaces,
    ideas: doc.ideas,
    purged: Array.isArray(doc.purged) ? doc.purged.filter((x): x is string => typeof x === 'string') : [],
  };
}
