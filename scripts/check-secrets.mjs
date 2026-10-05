#!/usr/bin/env node
/**
 * 提交前密钥扫描。
 *
 * 这是铁律 #2「仓库里一个字节的密钥都没有」的执行手段。
 * `.gitignore` 是白名单，防止"不小心加进来"；本脚本是第二道防线，
 * 防止"显式放行了但内容里带了密钥"。
 *
 * 用法：
 *   npm run check:secrets
 *
 * 扫两类东西：
 *   ① 文件**名**（有没有 .env / token.json 之类的东西混进来）
 *   ② 文件**内容**（正则匹配已知的密钥前缀）
 *
 * 🔴 文件清单优先用 `git ls-files`（只扫真正会被提交的东西，风险面最准）。
 *    但某些环境不允许 Node 派生子进程（会抛 EBUSY），所以失败时退回
 *    直接遍历文件系统 —— 这样在沙箱里、在没装 git 的机器上同样能跑。
 *
 * 退出码非 0 表示发现可疑内容，不要在这时提交。
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** 已知的密钥前缀。宁可误报，不要漏报。 */
const PATTERNS = [
  ['GitHub 细粒度 token', /github_pat_[A-Za-z0-9_]{20,}/g],
  ['GitHub 经典 token', /gh[pousr]_[A-Za-z0-9]{20,}/g],
  ['OpenAI / DeepSeek 风格密钥', /sk-[A-Za-z0-9_-]{24,}/g],
  ['AWS Access Key ID', /AKIA[0-9A-Z]{16}/g],
  ['Google API Key', /AIza[0-9A-Za-z_-]{30,}/g],
  ['PEM 私钥块', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ['Slack token', /xox[baprs]-[A-Za-z0-9-]{10,}/g],
];

/** 文件名可疑的特征。 */
const SUSPICIOUS_NAME = /(^|[\\/])\.env(\.|$)|token|secret|credential|\.pem$|\.key$|\.p12$|keystore/i;

/** 扫描器自己天然含有"像密钥"的文本（正则字面量），跳过。 */
const SKIP_FILES = new Set(['scripts/check-secrets.mjs']);

/** 不走进这些目录（fs 模式用）。 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.workbuddy']);

/** 超过这个大小就不读内容了。 */
const MAX_SCAN_BYTES = 2 * 1024 * 1024;

function fromGit() {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\0').filter((s) => s.length > 0);
}

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), acc);
    } else if (entry.isFile()) {
      acc.push(relative(process.cwd(), join(dir, entry.name)).split(sep).join('/'));
    }
  }
  return acc;
}

function listFiles() {
  try {
    const files = fromGit();
    if (files.length > 0) return { files, source: 'git ls-files' };
  } catch {
    // 落到文件系统扫描（沙箱里 spawn 会 EBUSY，没装 git 的机器也会失败）
  }
  return { files: walk(process.cwd()), source: '文件系统遍历' };
}

function isTextFile(buf) {
  // 前 8KB 里出现 NUL 就当成二进制，跳过
  return !buf.subarray(0, 8192).includes(0);
}

const { files, source } = listFiles();

const nameHits = [];
const contentHits = [];

for (const rel of files) {
  if (SKIP_FILES.has(rel)) continue;

  if (SUSPICIOUS_NAME.test(rel)) nameHits.push(rel);

  let buf;
  try {
    if (statSync(rel).size > MAX_SCAN_BYTES) continue;
    buf = readFileSync(rel);
  } catch {
    continue; // 文件已删除或权限不足
  }
  if (!isTextFile(buf)) continue;

  const text = buf.toString('utf8');
  for (const [label, re] of PATTERNS) {
    re.lastIndex = 0;
    const found = text.match(re);
    if (!found) continue;
    for (const hit of found) {
      // 只回显前缀，避免把密钥本身完整打进终端 / 日志
      contentHits.push({ rel, label, preview: hit.slice(0, 12) + '…' });
    }
  }
}

let bad = false;

if (nameHits.length > 0) {
  bad = true;
  console.log('\n发现可疑文件名：');
  for (const f of nameHits) console.log(`  · ${f}`);
}

if (contentHits.length > 0) {
  bad = true;
  console.log('\n发现疑似密钥内容：');
  for (const h of contentHits) console.log(`  · ${h.rel}  [${h.label}]  ${h.preview}`);
}

if (bad) {
  console.log('\n未通过：请移除上述内容后再提交。');
  console.log('若确认是误报（例如文档里的示例密钥），把该文件加进本脚本的 SKIP_FILES。');
  process.exit(1);
}

console.log(`密钥扫描通过（清单来源：${source}，共 ${files.length} 个文件）。`);
