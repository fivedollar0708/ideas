#!/usr/bin/env node
/**
 * 浏览器冒烟测试（端到端）。
 *
 * 为什么需要它：store.ts / main.ts / 渲染层依赖 IndexedDB 与 DOM，
 * 在 Node 里一条都测不到 —— 而那恰恰是"数据会不会丢、空间会不会串"最关键的部分。
 * 单元测试全绿也不能说明"刷新之后东西还在、切了空间另一个空间没被扰动"。
 *
 * 实现方式刻意做到**零新增依赖**：
 *   用本机已装的 Chrome + Node 22 内置的 WebSocket 直接说 CDP 协议，
 *   不装 puppeteer / playwright / agent-browser（那些要拉几百 MB）。
 *
 * 用法：
 *   1) 另开一个终端：npm run serve
 *   2) 本终端：npm run smoke
 *
 * 环境变量：SMOKE_URL / CHROME_PATH / CDP_PORT
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
      /* 还没起来 */
    }
    await sleep(200);
  }
  throw new Error(`等待 Chrome 调试端口超时（${CDP_PORT}）`);
}

/** 极简 CDP 客户端。支持发送命令 + 订阅事件。 */
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    const listeners = new Map();

    ws.addEventListener('open', () => {
      resolve({
        send(method, params = {}) {
          const id = ++seq;
          return new Promise((res, rej) => {
            pending.set(id, { res, rej });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        on(method, handler) {
          const list = listeners.get(method) ?? [];
          list.push(handler);
          listeners.set(method, list);
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

      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message ?? 'CDP 错误'));
        else res(msg.result);
        return;
      }

      if (msg.method && listeners.has(msg.method)) {
        for (const fn of listeners.get(msg.method)) fn(msg.params);
      }
    });
  });
}

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
  await sleep(240);
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

// 页面里常用的取值表达式
const IDEA_COUNT = `document.querySelectorAll('.bubble--idea').length`;
const IDEA_TEXTS = `Array.from(document.querySelectorAll('.bubble--idea .bubble-label')).map(e=>e.textContent)`;
const HEART_TEXT = `document.querySelector('.bubble--heart .bubble-label')?.textContent ?? ''`;

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

    // 🔴 删除空间 / 清空回收站都用了 window.confirm。headless 下原生对话框
    //    会一直等在那里，不处理的话脚本会直接挂死。这里全部自动"确定"。
    let dialogs = 0;
    cdp.on('Page.javascriptDialogOpening', () => {
      dialogs++;
      void cdp.send('Page.handleJavaScriptDialog', { accept: true });
    });

    console.log('── 首屏 ──');

    const ready = await waitUntil(cdp, `document.readyState === 'complete' && !!window.__nebula`);
    ok(ready, '页面加载完成且应用已启动');
    ok((await evaluate(cdp, `document.title`)) === '想法星云', '页面标题正确');
    ok((await evaluate(cdp, IDEA_COUNT)) === 0, '全新环境没有想法泡泡');
    ok(
      (await evaluate(cdp, `!!document.querySelector('.bubble--heart')`)),
      '心泡泡已经出现（空间切换的唯一入口）',
    );
    ok((await evaluate(cdp, HEART_TEXT)) === '未命名 1', '自动创建了默认空间「未命名 1」');
    ok(
      !/打不开本地数据库/.test(await evaluate(cdp, `document.querySelector('#notice').textContent`)),
      'IndexedDB 正常打开',
    );

    console.log('\n── 录入 ──');

    await typeAndEnter(cdp, '凌晨三点');
    ok((await evaluate(cdp, IDEA_COUNT)) === 1, '回车后出现 1 个泡泡');
    await typeAndEnter(cdp, '水');
    const texts = await evaluate(cdp, IDEA_TEXTS);
    ok(
      Array.isArray(texts) && texts.includes('凌晨三点') && texts.includes('水'),
      '两个泡泡的文字都正确',
      JSON.stringify(texts),
    );

    await typeAndEnter(cdp, '   ');
    ok((await evaluate(cdp, IDEA_COUNT)) === 2, '空输入回车不产生泡泡');

    await typeAndEnter(cdp, '长'.repeat(300));
    const longLen = await evaluate(
      cdp,
      `Math.max(...Array.from(document.querySelectorAll('.bubble--idea .bubble-label')).map(e=>e.textContent.length))`,
    );
    ok(longLen === 280, '超长文本截断到 280 字', `实际 ${longLen}`);

    console.log('\n── 刷新后是否还在 ──');

    await cdp.send('Page.reload', { ignoreCache: true });
    await sleep(400);
    ok(
      await waitUntil(cdp, `document.readyState === 'complete' && !!window.__nebula`),
      '刷新后应用重新启动',
    );
    ok((await evaluate(cdp, IDEA_COUNT)) === 3, '刷新后 3 个泡泡都还在（持久化生效）');
    ok((await evaluate(cdp, HEART_TEXT)) === '未命名 1', '当前空间也被记住（lastSpaceId）');

    console.log('\n── 多空间：创建与切换 ──');

    const spaceA = await evaluate(cdp, `window.__nebula.current().id`);
    await evaluate(cdp, `window.__nebula.createSpace()`);
    await sleep(400);

    const afterCreate = await evaluate(
      cdp,
      `window.__nebula.spaces().length + '|' + window.__nebula.current().name`,
    );
    ok(
      afterCreate === '2|未命名 2',
      '新建空间后自动切过去，名字是「未命名 2」',
      afterCreate,
    );
    ok((await evaluate(cdp, IDEA_COUNT)) === 0, '新空间是空的（看不到上一个空间的想法）');
    ok((await evaluate(cdp, HEART_TEXT)) === '未命名 2', '心泡泡换成了新空间的名字');

    const spaceB = await evaluate(cdp, `window.__nebula.current().id`);

    await typeAndEnter(cdp, '深海的压力');
    ok((await evaluate(cdp, IDEA_COUNT)) === 1, '在 B 空间记 1 条 → 只有 1 个泡泡');

    await evaluate(cdp, `window.__nebula.switchSpace(${JSON.stringify(spaceA)})`);
    await sleep(400);
    ok((await evaluate(cdp, IDEA_COUNT)) === 3, '切回 A 空间 → 又是 3 个泡泡');
    ok((await evaluate(cdp, HEART_TEXT)) === '未命名 1', '心泡泡上显示的是 A 空间的名字');

    console.log('\n── 空间隔离（最关键的验收） ──');

    const isolationReport = await evaluate(cdp, `JSON.stringify(window.__nebula.debugIsolation())`);
    const iso = JSON.parse(isolationReport);
    ok(iso.crossSpaceNeighbors === 0, `邻居查询里没有跨空间的结果（检查了 ${iso.neighborsChecked} 组）`, isolationReport);
    ok(iso.spaceIds.length === 2, '力场里登记了 2 个互相独立的泡泡分区', isolationReport);

    // 行为验证：B 在被模拟时，A 的泡泡必须一动不动
    const aPositionsBefore = JSON.stringify(await evaluate(cdp, `window.__nebula.positions(${JSON.stringify(spaceA)})`));
    await evaluate(cdp, `window.__nebula.switchSpace(${JSON.stringify(spaceB)})`);
    await sleep(1500); // 让 B 的力导向充分跑一段时间
    const aPositionsAfter = JSON.stringify(await evaluate(cdp, `window.__nebula.positions(${JSON.stringify(spaceA)})`));

    ok(
      aPositionsBefore === aPositionsAfter,
      '模拟 B 空间 1.5 秒后，A 空间的泡泡坐标完全没变',
      aPositionsBefore === aPositionsAfter ? '' : `${aPositionsBefore} → ${aPositionsAfter}`,
    );

    const bMoved = await evaluate(
      cdp,
      `(() => { const p = window.__nebula.field.bodiesOf(${JSON.stringify(spaceB)}); return p.length > 0; })()`,
    );
    ok(bMoved, 'B 空间自己有泡泡（对照：不是"两边都没动"造成的假通过）');

    console.log('\n── 删除空间 → 回收站 → 恢复 ──');

    await evaluate(cdp, `window.__nebula.deleteSpace(${JSON.stringify(spaceB)})`);
    await sleep(600);
    ok(dialogs >= 1, '删除时弹了确认框，脚本已自动确认');

    const afterDelete = await evaluate(
      cdp,
      `window.__nebula.spaces().length + '|' + window.__nebula.current().id`,
    );
    ok(afterDelete.startsWith('1|'), '删除后只剩 1 个空间');
    ok(
      (await evaluate(cdp, `document.querySelectorAll('.bubble--idea').length`)) === 3,
      '当前空间是 A，泡泡仍是 3 个（删除 B 没影响 A）',
    );

    await evaluate(cdp, `window.__nebula.openTrash()`);
    await sleep(400);
    const trashCount = await evaluate(cdp, `document.querySelectorAll('.trash-item').length`);
    ok(trashCount === 1, '回收站里有 1 项', String(trashCount));
    const trashMeta = await evaluate(cdp, `document.querySelector('.trash-meta')?.textContent ?? ''`);
    ok(/1 条想法/.test(trashMeta), '回收站条目显示"1 条想法"（快照里带着想法）', trashMeta);
    ok(/天后清除/.test(trashMeta), '回收站条目显示剩余天数', trashMeta);

    const trashId = await evaluate(cdp, `document.querySelector('.trash-item').dataset.trashId`);
    await evaluate(cdp, `window.__nebula.restoreTrash(${JSON.stringify(trashId)})`);
    await sleep(500);

    ok((await evaluate(cdp, `window.__nebula.spaces().length`)) === 2, '恢复后又有 2 个空间');
    const restoredIdeas = await evaluate(
      cdp,
      `window.__nebula.listIdeas().then(l => l.filter(i => i.spaceId === ${JSON.stringify(spaceB)}).length)`,
    );
    ok(restoredIdeas === 1, '被删空间里的想法跟着一起回来了', String(restoredIdeas));

    const restoredName = await evaluate(
      cdp,
      `window.__nebula.spaces().find(s => s.id === ${JSON.stringify(spaceB)}).name`,
    );
    ok(restoredName === '未命名 2', '恢复时名字没有被多加后缀（此时无冲突）', restoredName);

    console.log('\n── 空间切换浮层 UI ──');

    await evaluate(cdp, `document.querySelector('.bubble--heart').click()`);
    await sleep(350);
    ok(
      !(await evaluate(cdp, `document.querySelector('#space-layer').hidden`)),
      '点击心泡泡浮出空间切换层',
    );
    ok(
      (await evaluate(cdp, `document.querySelectorAll('.space-chip').length`)) === 2,
      '浮层里列出了 2 个空间的心泡泡',
    );
    await evaluate(cdp, `document.querySelectorAll('.space-chip-main')[1].click()`);
    await sleep(400);
    ok(
      await evaluate(cdp, `document.querySelector('#space-layer').hidden`),
      '点某个空间后浮层收回',
    );

    console.log('\n── 页面内自检 ──');

    await evaluate(cdp, `document.querySelector('#selftest').click()`);
    // 🔴 等"出现 OK 行"，而不是只等"出现 [OK" —— 后者在超时后返回 false，
    //    而下面的断言只查 [FAIL] 计数，会导致"自检根本没跑"也判为通过（踩过一次）
    const selfTestRan = await waitUntil(
      cdp,
      `document.querySelector('#selftest-out').textContent.split('[OK').length - 1 >= 5`,
      12000,
    );
    const selfTestText = await evaluate(cdp, `document.querySelector('#selftest-out').textContent`);
    const failCount = (selfTestText.match(/\[FAIL\]/g) ?? []).length;
    const okCount = (selfTestText.match(/\[OK\s*\]/g) ?? []).length;

    ok(selfTestRan && okCount > 0, `页内自检确实跑起来了（${okCount} 项）`);
    ok(failCount === 0, `页内自检无失败项`, selfTestText.replace(/\n/g, ' | '));
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
      /* profile 可能仍被占用 */
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
