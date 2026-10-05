/**
 * GitHub Contents API 客户端。
 *
 * 🔴 三个必须处理的本机实测坑：
 *
 * ① **只用 api.github.com**。本机实测 `raw.githubusercontent.com` 的 TLS 握手
 *    会被重置（连测 3 次全失败）。所以代码里**永不出现 download_url** ——
 *    那个字段就在 Contents API 的响应里，很诱人，但用了就挂。
 *
 * ② **`btoa()` 对非 Latin-1 字符抛 InvalidCharacterError**。中文同步会全挂。
 *    必须先 `TextEncoder` 编成字节，再分块 `String.fromCharCode(...chunk)` 拼二进制串。
 *    **必须分块**：`String.fromCharCode(...arr)` 在几万个参数时会栈溢出。
 *    解码方向同理：`atob` → 字节数组 → `TextDecoder`，不能把 atob 的结果直接当文本。
 *
 * ③ **PUT 必须带 `sha` 和 `committer`，缺任一返回 422**（本机踩过）。
 *    sha 是"我在改哪个版本"，committer 是提交者身份 —— 少了任何一个 GitHub 都不收。
 *
 * 另外：GitHub 返回的 base64 **每 76 字符带一个换行**，atob 前必须把空白去掉。
 */

/** base64 分块大小。0x8000 是个安全值：既避免参数上限，也不至于太碎。 */
const B64_CHUNK = 0x8000;

/** 单次请求超时。挂住的请求会一直占着导航锁，必须自己掐断。 */
const REQUEST_TIMEOUT_MS = 12_000;

/** 带超时的 fetch。GitHub 偶发不响应时不能让同步永远卡住。 */
async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 文本 → base64（UTF-8 安全）。 */
export function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);

  let binary = '';
  for (let i = 0; i < bytes.length; i += B64_CHUNK) {
    const chunk = bytes.subarray(i, i + B64_CHUNK);
    // 🔴 必须用展开 + 分块。直接 fromCharCode(...bytes) 在大文件上会爆栈
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

/** base64 → 文本（UTF-8 安全）。 */
export function fromBase64(b64: string): string {
  // GitHub 的 content 每 76 字符插一个换行；atob 不容忍这些空白
  const clean = b64.replace(/\s+/g, '');

  let binary: string;
  try {
    binary = atob(clean);
  } catch (err) {
    throw new SyncError(
      'content',
      `base64 解码失败（内容可能被截断或损坏）：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  // 🔴 不能直接返回 binary —— 那样中文会变成乱码（每个字节被当成一个 Latin-1 字符）
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

/** UTF-8 字节数（用来提示文件大小、以及判断 GitHub 的 1MB base64 边界）。 */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export type SyncErrorKind =
  /** 凭据无效 / 无权限 —— 重试没有意义，要停下来告诉用户。 */
  | 'auth'
  /** 找不到（读文件时视为"还不存在"，写文件时是真错误）。 */
  | 'notfound'
  /** 版本冲突（别人刚推过）—— 重新合并后重试即可。 */
  | 'conflict'
  /** 被限速或超额。 */
  | 'ratelimit'
  /** 网络层失败（离线、DNS、TLS）。 */
  | 'network'
  /** 🔴 内容层失败：解析不了、空内容、编码不对。**这一类绝不能继续往下走。** */
  | 'content'
  /** 其它未分类。 */
  | 'unknown';

export class SyncError extends Error {
  constructor(
    readonly kind: SyncErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'SyncError';
  }
}

export interface RemoteFile {
  /** 解码后的文本。 */
  text: string;
  /** 版本 sha，PUT 时要用。 */
  sha: string;
  /** 原样的 base64（写 backup 时"一字不改"地用它是更保险的做法）。 */
  base64: string;
}

/** 远端存储的抽象。抽出来是为了让自动化测试能注入一个内存实现。 */
export interface RemoteStore {
  readFile(path: string): Promise<RemoteFile | null>;
  writeFile(path: string, text: string, message: string, sha?: string): Promise<void>;
}

export interface GitHubOptions {
  token: string;
  owner: string;
  repo: string;
  branch: string;
}

interface ContentsResponse {
  content?: string;
  encoding?: string;
  sha?: string;
  size?: number;
}

export class GitHubClient implements RemoteStore {
  constructor(private readonly opts: GitHubOptions) {}

  private url(path: string): string {
    // 🔴 只用 api.github.com。不要改成 raw.githubusercontent.com（本机握手被重置）
    const base = `https://api.github.com/repos/${this.opts.owner}/${this.opts.repo}/contents/${path}`;
    return `${base}?ref=${encodeURIComponent(this.opts.branch)}`;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.opts.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  /**
   * 把 HTTP 响应翻译成 SyncError。
   * 分类的意义：'auth' 要停下来让用户换 token，'conflict' 要重新合并重试，
   * 'network' 要稍后再试 —— 三种的处置完全不同。
   */
  private async fail(res: Response): Promise<never> {
    let detail = '';
    try {
      const body = (await res.json()) as { message?: string };
      detail = body.message ?? '';
    } catch {
      /* 响应体不是 JSON，忽略 */
    }

    const status = res.status;

    if (status === 401) throw new SyncError('auth', `凭据无效（401）：${detail}`);
    if (status === 403) {
      if (/rate limit|secondary rate/i.test(detail)) {
        throw new SyncError('ratelimit', `被 GitHub 限速（403）：${detail}`);
      }
      throw new SyncError('auth', `没有权限（403）：${detail}`);
    }
    if (status === 404) throw new SyncError('notfound', `找不到（404）：${detail}`);
    if (status === 409) throw new SyncError('conflict', `版本冲突（409）：${detail}`);
    if (status === 422) throw new SyncError('content', `请求内容不合法（422）：${detail}`);

    throw new SyncError('unknown', `GitHub 返回 ${status}：${detail}`);
  }

  async readFile(path: string): Promise<RemoteFile | null> {
    let res: Response;
    try {
      res = await fetchWithTimeout(this.url(path), { headers: this.headers() });
    } catch (err) {
      throw new SyncError('network', `请求失败：${err instanceof Error ? err.message : String(err)}`);
    }

    // 文件还不存在不是错误 —— 首次同步就是这样
    if (res.status === 404) return null;
    if (!res.ok) await this.fail(res);

    const data = (await res.json()) as ContentsResponse;

    // 🔴 下面前三条是"必须 fail loud"的检查。任何一条放过去，
    //    都会演变成"把本地数据推成空"的灾难：解析失败 → 解析成空 → 合并成空 → 推上去。
    if (typeof data.sha !== 'string' || data.sha === '') {
      throw new SyncError('content', '远端响应缺少 sha，无法安全地继续');
    }
    if (typeof data.encoding !== 'string' || data.encoding !== 'base64') {
      // 文件超过 1MB 时 GitHub 会把 encoding 变成 'none' 且不给 content
      throw new SyncError(
        'content',
        `远端文件的 encoding 是 "${String(data.encoding)}"（预期 base64）。` +
          `文件可能超过了 1MB —— 请先人工处理，不要继续同步。`,
      );
    }
    if (typeof data.content !== 'string' || data.content === '') {
      throw new SyncError('content', '远端返回了空内容 —— 拒绝把它当作"数据为空"处理');
    }

    const text = fromBase64(data.content);

    // 空字符串也算内容异常：一个"存在的文件"不该是空的
    if (text.trim() === '') {
      throw new SyncError('content', '远端文件内容为空字符串 —— 拒绝继续');
    }

    return { text, sha: data.sha, base64: data.content };
  }

  async writeFile(path: string, text: string, message: string, sha?: string): Promise<void> {
    const body: Record<string, unknown> = {
      message,
      content: toBase64(text),
      branch: this.opts.branch,
      // 🔴 缺 committer / author 会得到 422。GitHub 要求提交里必须有身份
      committer: { name: this.opts.owner, email: `${this.opts.owner}@users.noreply.github.com` },
      author: { name: this.opts.owner, email: `${this.opts.owner}@users.noreply.github.com` },
    };
    // 🔴 更新已有文件必须带 sha（"我在改哪个版本"）；新建时不能带
    if (sha) body.sha = sha;

    let res: Response;
    try {
      res = await fetchWithTimeout(
        `https://api.github.com/repos/${this.opts.owner}/${this.opts.repo}/contents/${path}`,
        {
          method: 'PUT',
          headers: { ...this.headers(), 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
    } catch (err) {
      throw new SyncError('network', `请求失败：${err instanceof Error ? err.message : String(err)}`);
    }

    if (!res.ok) await this.fail(res);
  }

  /** 读一个文件、取它的文本；不存在返回 null。 */
  async tryReadText(path: string): Promise<{ text: string; sha: string } | null> {
    const file = await this.readFile(path);
    return file ? { text: file.text, sha: file.sha } : null;
  }
}
