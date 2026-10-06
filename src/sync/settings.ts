/**
 * 设备级凭据存储：**登录一次，这台设备以后都记得**。
 *
 * ── 为什么不要口令了 ────────────────────────────────
 * 上一版用「用户自设口令 + PBKDF2」加密 token，代价是**每次重开页面都要输一次口令**
 * （派生密钥不落地）。那是比行业惯例更严的做法：所有网站都是"登录一次，之后靠
 * 本机存储记住你"。所以这里改成设备级凭据 —— 和浏览器里的登录 cookie 一个性质。
 *
 * ── 安全边界要说清楚 ────────────────────────────────
 * 去掉口令之后，**能打开这个浏览器的人就能看到这些想法**，和"没退出的 Gmail"一样。
 * 本机的边界就是安全边界。所以界面上必须有一个明确的「退出登录」。
 *
 * ── 但不存明文（这一条是真的有用）──────────────────
 * token 不会以明文落在任何存储里：
 *   · 生成一个 **不可导出**（`extractable: false`）的 AES-GCM 密钥，存进 IndexedDB；
 *   · 用它加密 token，密文与 iv 也存进 IndexedDB。
 *
 * 🔴 这挡不住"有人能在这个源里执行代码"（那和 XSS 一样无解）——
 *    同源脚本仍然可以让浏览器用它解密。它挡住的是另一类**很现实**的攻击：
 *    扫描浏览器存储、按前缀找 `ghp_` / `github_pat_` 这类 token 特征的恶意程序与扩展。
 *    **那个字符串根本不会出现在任何存储里。**
 *
 * 🔴 远端坐标（owner/repo/branch）存在**本地**，不放进远端的那份 sync.config.json ——
 *    否则就成了"要先知道仓库才能读到仓库地址"的循环。
 */

const DB_NAME = 'nebula-credentials';
const DB_VERSION = 1;
const STORE = 'credentials';
const RECORD_KEY = 'github';

/** 远端坐标。存在本地，不放进远端的那份 config（否则是循环依赖）。 */
export interface SyncTarget {
  owner: string;
  repo: string;
  branch: string;
}

interface CredentialRecord {
  target: SyncTarget;
  /** 加密后的 token。退化模式下为空。 */
  cipher: ArrayBuffer | null;
  iv: Uint8Array | null;
  /**
   * AES-GCM 密钥。**不可导出** —— 拿不到原始字节，只能"用它做事"。
   * IndexedDB 能直接存 CryptoKey 对象，所以这一层是免费的。
   */
  key: CryptoKey | null;
  /**
   * 退化模式：当前不是安全上下文（例如用 http:// 局域网 IP 打开）时
   * `crypto.subtle` 不存在，只能明文存。**界面上会如实说明**，不偷偷降级。
   */
  plain: string | null;
}

function hasSubtle(): boolean {
  return typeof crypto !== 'undefined' && typeof crypto.subtle !== 'undefined';
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('打不开凭据库'));
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('凭据读写失败'));
        t.oncomplete = () => db.close();
      }),
  );
}

/** 保存凭据（登录）。token 会被加密后再落地。 */
export async function saveCredential(target: SyncTarget, token: string): Promise<void> {
  let record: CredentialRecord;

  if (hasSubtle()) {
    // 🔴 extractable: false —— 密钥本身导不出来，只能在加密子系统里用它
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipher = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      new TextEncoder().encode(token),
    );
    record = { target, cipher, iv, key, plain: null };
  } else {
    // 不是安全上下文：如实降级，并由界面提示用户
    record = { target, cipher: null, iv: null, key: null, plain: token };
  }

  await tx('readwrite', (store) => store.put(record, RECORD_KEY));
}

/** 读出凭据。没有或解不开都返回 null。 */
export async function loadCredential(): Promise<{ target: SyncTarget; token: string } | null> {
  let record: CredentialRecord | undefined;
  try {
    record = await tx<CredentialRecord | undefined>('readonly', (store) => store.get(RECORD_KEY));
  } catch {
    return null;
  }

  if (!record?.target) return null;
  if (record.plain) return { target: record.target, token: record.plain };
  if (!record.key || !record.cipher || !record.iv) return null;

  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: record.iv as BufferSource },
      record.key,
      record.cipher as BufferSource,
    );
    return { target: record.target, token: new TextDecoder().decode(plain) };
  } catch {
    // 解不开（例如换了浏览器配置）—— 当作没有凭据，让用户重新登录
    return null;
  }
}

/** 退出登录：抹掉这台设备上的凭据。 */
export async function clearCredential(): Promise<void> {
  await tx('readwrite', (store) => store.delete(RECORD_KEY));
}

/**
 * 这台设备有没有凭据**记录**（不代表能解开）。
 *
 * 🔴 需要区分两件事，它们的提示完全不同：
 *    · 从没登录过 ⇒ "点这里登录"
 *    · 有记录但解不开（换了浏览器配置等）⇒ "登录已失效，请重新登录"
 *    混成一句会让第二种情况的人以为自己的数据没了。
 */
export async function credentialRecordExists(): Promise<boolean> {
  try {
    return (await tx<unknown>('readonly', (store) => store.get(RECORD_KEY))) !== undefined;
  } catch {
    return false;
  }
}

/**
 * 当前是否处于安全上下文（决定 token 能不能被加密保存）。
 * 不是的话界面要如实告诉用户"token 只能明文存在本机"。
 */
export function isCredentialEncrypted(): boolean {
  return hasSubtle();
}
