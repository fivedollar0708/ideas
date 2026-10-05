#!/usr/bin/env node
/**
 * 浏览器冒烟测试（端到端）。
 *
 * 为什么需要它：store.ts 和 main.ts 依赖 IndexedDB 与 DOM，在 Node 里
 * 一条都测不到 —— 而那恰恰是"数据会不会丢"最关键的一层。单元测试全绿
 * 也不能说明"刷新之后东西还在"。这个脚本补的就是这一段。
 *
 * 实现方式刻意做到**零新增依赖**：
 *   用本机已装的 Chrome + Node 22 内置的 WebSocket 直接说 CDP 协议，
 *   不装 puppeteer / playwright / agent-browser（那些要拉几百 MB）。
 *
 * 用法：
 *   1) 另开一个终端：npm run serve
 *   2) 本终端：npm run smoke
 *
 * 环境变量：
 *   SMOKE_URL       默认 http://127.0.0.1:8000
 *   CHROME_PATH     默认自动探测
 *   CDP_PORT        默认 9333
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_BASE = process.env.SMOKE_URL ?? 'http://127.0.0.1:8000';
const CDP_PORT = Number(process.env.CDP_PORT ?? 9333);

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);

function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    if (p && existsSync(p)) return p;
  }
  throw new Error('找不到 Chrome/Edge，请用 CHROME_PATH 指定可执行文件路径');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForCdp(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      if (res.ok) {
        const list = await res.json();
        const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (page) return page;
      }
    } catch {
      /* 还没起来，继续等 */
    }
    await sleep(200);
  }
  throw new Error(`等待 Chrome 调试端口超时（${CDP_PORT}）`);
}

/** 极简 CDP 客户端。 */
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();

    ws.addEventListener('open', () => {
      resolve({
        send(method, params = {}) {
          const id = ++seq;
          return new Promise((res, rej) => {
            pending.set(id, { res, rej });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        close() {
          ws.close();
        },
      });
    });

    ws.addEventListener('error', () => reject(new Error('连接 CDP 失败')));

    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (!msg.id || !pending.has(msg.id)) return;
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(`${msg.error.message ?? 'CDP 错误'}`));
      else res(msg.result);
    });
  });
}

/** 在页面里求值，返回可序列化的结果。 */
async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(`页面内求值抛错：${result.exceptionDetails.text}`);
  }
  return result.result?.value;
}

/** 轮询直到表达式返回真值。 */
async function waitUntil(cdp, expression, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(cdp, expression)) return true;
    await sleep(120);
  }
  return false;
}

async function typeAndEnter(cdp, text) {
  await evaluate(cdp, `document.querySelector('#input').focus()`);
  await cdp.send('Input.insertText', { text });
  await sleep(60);
  for (const type of ['keyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', {
      type,
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    });
  }
  await sleep(220);
}

// ── 断言 ──────────────────────────────────────────────
let passed = 0;
const failures = [];

function ok(condition, message, extra = '') {
  if (condition) {
    passed++;
    console.log(`  [OK  ] ${message}`);
  } else {
    failures.push(message);
    console.log(`  [FAIL] ${message}${extra ? '  → ' + extra : ''}`);
  }
}

async function main() {
  const chrome = findChrome();
  const profile = mkdtempSync(join(tmpdir(), 'nebula-smoke-'));
  console.log(`浏览器：${chrome}`);
  console.log(`临时 profile：${profile}\n`);

  const child = spawn(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      URL_BASE,
    ],
    { stdio: 'ignore', detached: false },
  );

  let cdp;
  try {
    const page = await waitForCdp();
    cdp = await connect(page.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    console.log('── 首屏 ──');

    const ready = await waitUntil(cdp, `document.readyState === 'complete' && !!window.__nebula`);
    ok(ready, '页面加载完成且应用已启动');

    ok((await evaluate(cdp, `document.title`)) === '想法星云', '页面标题正确');

    // 全新 profile ⇒ 全新 IndexedDB ⇒ 初始应为空
    ok(
      (await evaluate(cdp, `document.querySelectorAll('#list li').length`)) === 0,
      '全新环境初始清单为空',
    );

    const spaceName = await evaluate(cdp, `document.querySelector('#space-name').textContent`);
    ok(spaceName === '未命名 1', '自动创建了默认空间「未命名 1」', `实际：${spaceName}`);

    const notice = await evaluate(cdp, `document.querySelector('#notice').textContent`);
    ok(!/打不开本地数据库/.test(notice), 'IndexedDB 正常打开（未落到错误分支）', notice);

    console.log('\n── 录入 ──');

    await typeAndEnter(cdp, '凌晨三点');
    ok(
      (await evaluate(cdp, `document.querySelectorAll('#list li').length`)) === 1,
      '回车后清单出现 1 条',
    );
    ok(
      (await evaluate(cdp, `document.querySelector('#list li .idea-text').textContent`)) === '凌晨三点',
      '存下的文本正确',
    );

    await typeAndEnter(cdp, '水');
    ok(
      (await evaluate(cdp, `Array.from(document.querySelectorAll('#list li .idea-text')).map(e=>e.textContent).join('|')`)) ===
        '水|凌晨三点',
      '第二条追加在顶部（最近的在上）',
    );

    // 空输入不该产生记录
    await typeAndEnter(cdp, '   ');
    ok(
      (await evaluate(cdp, `document.querySelectorAll('#list li').length`)) === 2,
      '空输入回车不产生记录',
    );

    // 超长文本截断
    await typeAndEnter(cdp, '长'.repeat(300));
    const longLen = await evaluate(
      cdp,
      `document.querySelector('#list li .idea-text').textContent.length`,
    );
    ok(longLen === 280, `超长文本截断到 280 字`, `实际 ${longLen}`);

    console.log('\n── 刷新后是否还在（关键） ──');

    await cdp.send('Page.reload', { ignoreCache: true });
    await sleep(400);
    const backAgain = await waitUntil(cdp, `document.readyState === 'complete' && !!window.__nebula`);
    ok(backAgain, '刷新后应用重新启动');

    const afterReload = await evaluate(
      cdp,
      `Array.from(document.querySelectorAll('#list li .idea-text')).map(e=>e.textContent).map(t=>t.slice(0,4)).join('|')`,
    );
    ok(
      (await evaluate(cdp, `document.querySelectorAll('#list li').length`)) === 3,
      '刷新后 3 条都还在（持久化生效）',
      `实际：${afterReload}`,
    );

    console.log('\n── 直接读数据库（绕过 UI 再验一次） ──');

    const fromDb = await evaluate(
      cdp,
      `window.__nebula.listIdeas().then(list => list.map(i => i.text.length).join(','))`,
    );
    ok(typeof fromDb === 'string' && fromDb.split(',').length === 3, 'IndexedDB 里确实有 3 条记录', String(fromDb));

    const spaceCount = await evaluate(
      cdp,
      `window.__nebula.store.getAllSpaces().then(s => s.length)`,
    );
    ok(spaceCount === 1, '空间表里有且只有 1 个空间', String(spaceCount));

    console.log('\n── 页面内自检 ──');

    await evaluate(cdp, `document.querySelector('#selftest').click()`);
    const gotResult = await waitUntil(
      cdp,
      `document.querySelector('#selftest-out').textContent.includes('[OK')`,
    );
    ok(gotResult, '自检按钮产出了结果');

    const selfTestText = await evaluate(cdp, `document.querySelector('#selftest-out').textContent`);
    const failCount = (selfTestText.match(/\[FAIL\]/g) ?? []).length;
    const okCount = (selfTestText.match(/\[OK\s*\]/g) ?? []).length;
    ok(failCount === 0, `页内自检全部通过（${okCount} 项）`, selfTestText.replace(/\n/g, ' | '));
  } finally {
    try {
      cdp?.close();
    } catch {
      /* 忽略 */
    }
    try {
      child.kill();
    } catch {
      /* 忽略 */
    }
    await sleep(300);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      /* profile 可能还被占用，留给系统清理 */
    }
  }

  console.log(`\n${'─'.repeat(48)}`);
  if (failures.length === 0) {
    console.log(`冒烟测试全部通过：${passed} 项`);
  } else {
    console.log(`通过 ${passed} 项，失败 ${failures.length} 项：`);
    for (const f of failures) console.log(`  · ${f}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`\n冒烟测试无法完成：${err.message}`);
  console.error('请确认已另开终端运行 `npm run serve`，且 8000 端口可访问。');
  process.exitCode = 1;
});
