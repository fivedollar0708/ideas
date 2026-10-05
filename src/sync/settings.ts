/**
 * 同步设置：远端坐标 + **加密后的 token**。
 *
 * 铁律 #2：仓库里一个字节的密钥都没有。那么 token 存哪？
 *  · 存 localStorage —— 但它能被 DevTools 直接看到，而站点是公开的；
 *  · 所以先用用户自设的口令加密（PBKDF2 派生密钥 + AES-GCM），
 *    **派生出来的密钥只在内存里**，不落地。
 *
 * 代价要说清楚：每次重新打开页面都要输一次口令（因为密钥不落地）。
 * 这是"不让别人翻 DevTools 就看到 token"必然要付的成本。
 * 想要免口令就得把密钥也存下来 —— 那和不加密没有区别。
 *
 * 🔴 远端坐标（owner/repo/branch）存在**本地**，不放进远端的那份 sync.config.json ——
 *    否则就成了"要先知道仓库才能读到仓库地址"的循环。
 */

const KEY_SETTINGS = 'nebula.sync.settings';

/** PBKDF2 迭代次数。够高以拖慢暴力破解，又不至于让解锁明显卡顿。 */
const PBKDF2_ITERATIONS = 120_000;

export interface SyncTarget {
  owner: string;
  repo: string;
  branch: string;
}

interface StoredSettings {
  version: 1;
  target: SyncTarget;
  salt: string;
  iv: string;
  cipher: string;
}

function bytesToB64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** 加密 token。返回三段 base64（salt / iv / 密文）。 */
export async function encryptToken(
  token: string,
  passphrase: string,
): Promise<{ salt: string; iv: string; cipher: string }> {
  if (passphrase.length < 4) {
    throw new Error('口令至少 4 位 —— 太短的话加密形同虚设');
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);

  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    new TextEncoder().encode(token),
  );

  return { salt: bytesToB64(salt), iv: bytesToB64(iv), cipher: bytesToB64(new Uint8Array(cipher)) };
}

/** 解密。口令错时 AES-GCM 会认证失败 ⇒ 抛错（这正是我们要的：无法用错口令"解出垃圾"）。 */
export async function decryptToken(
  parts: { salt: string; iv: string; cipher: string },
  passphrase: string,
): Promise<string> {
  const key = await deriveKey(passphrase, b64ToBytes(parts.salt));

  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBytes(parts.iv) as BufferSource },
      key,
      b64ToBytes(parts.cipher) as BufferSource,
    );
    return new TextDecoder().decode(plain);
  } catch {
    throw new Error('口令不对（或设置已损坏），无法解出 token');
  }
}

/** 读出已保存的设置（不含 token —— token 是密文）。 */
export function loadStoredSettings(): StoredSettings | null {
  const raw = localStorage.getItem(KEY_SETTINGS);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredSettings;
    if (parsed.version !== 1 || !parsed.target) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 保存设置（token 会被加密后再落地）。 */
export async function saveSettings(
  target: SyncTarget,
  token: string,
  passphrase: string,
): Promise<void> {
  const parts = await encryptToken(token, passphrase);
  const stored: StoredSettings = { version: 1, target, ...parts };
  localStorage.setItem(KEY_SETTINGS, JSON.stringify(stored));
}

/** 用口令解锁：成功返回远端坐标与明文 token（token 只在内存里活到本次会话结束）。 */
export async function unlockSettings(
  passphrase: string,
): Promise<{ target: SyncTarget; token: string } | null> {
  const stored = loadStoredSettings();
  if (!stored) return null;
  const token = await decryptToken(stored, passphrase);
  return { target: stored.target, token };
}

export function forgetSettings(): void {
  localStorage.removeItem(KEY_SETTINGS);
}

/** 是否已经配置过（不代表已解锁）。 */
export function hasStoredSettings(): boolean {
  return loadStoredSettings() !== null;
}
