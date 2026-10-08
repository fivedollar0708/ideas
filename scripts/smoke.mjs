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
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedStress } from './stress-data.mjs';

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
    // 把异常详情带出来 —— 只写 "Uncaught" 对定位毫无帮助
    const d = result.exceptionDetails;
    const desc = d.exception?.description ?? d.exception?.value ?? d.text ?? '未知异常';
    throw new Error(`页面内求值抛错：${String(desc).split('\n')[0]}`);
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

/**
 * 打一条想法并回车。
 *
 * 🔴 默认会**等飞入落定**（影子消失）再返回 —— 阶段 4 起"回车"不再立刻产生泡泡，
 *    真泡泡要等 540ms 的弧线飞完才出现。早期那几条"回车后出现 1 个泡泡"的断言
 *    因此全都少数了一个（踩过）。要观察飞行途中的状态就传 waitForLanding = false。
 */
async function typeAndEnter(cdp, text, waitMs = 240, waitForLanding = true) {
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
  await sleep(waitMs);
  if (waitForLanding) {
    await waitUntil(cdp, `!document.querySelector('.bubble--shadow')`, 5000);
    await sleep(150);
  }
}

/** 取某个元素的中心（视口坐标）。 */
async function centerOf(cdp, selector) {
  return evaluate(
    cdp,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`,
  );
}

async function click(cdp, selector) {
  const point = await centerOf(cdp, selector);
  if (!point) throw new Error(`找不到元素：${selector}`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', {type, ...point, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1});
  }
  await sleep(80);
}

async function tap(cdp, selector) {
  const point = await centerOf(cdp, selector);
  await cdp.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{...point, id: 1}]});
  await cdp.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
  await sleep(100);
}

async function screenshot(cdp, name) {
  if (!process.env.SMOKE_SCREENSHOT_DIR) return;
  await sleep(250);
  const shot = await cdp.send('Page.captureScreenshot', {format: 'png'});
  writeFileSync(join(process.env.SMOKE_SCREENSHOT_DIR, `ui-${name}.png`), Buffer.from(shot.data, 'base64'));
}

/**
 * 用真实鼠标事件拖拽。
 * Chrome 会把这些鼠标事件同时合成为 pointer 事件，所以走的就是应用真实的拖拽链路。
 */
async function mouseDrag(cdp, selector, dx, dy, steps = 10) {
  const from = await centerOf(cdp, selector);
  if (!from) throw new Error(`找不到元素：${selector}`);

  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: from.x,
    y: from.y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });

  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: from.x + (dx * i) / steps,
      y: from.y + (dy * i) / steps,
      button: 'left',
      buttons: 1,
    });
    await sleep(16);
  }

  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: from.x + dx,
    y: from.y + dy,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  });

  return { from, to: { x: from.x + dx, y: from.y + dy } };
}

/** 双击（第二下要带 clickCount: 2，Chrome 才会派发 dblclick）。 */
async function doubleClick(cdp, selector) {
  const p = await centerOf(cdp, selector);
  if (!p) throw new Error(`找不到元素：${selector}`);

  for (const clickCount of [1, 2]) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: p.x,
      y: p.y,
      button: 'left',
      buttons: 1,
      clickCount,
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: p.x,
      y: p.y,
      button: 'left',
      buttons: 0,
      clickCount,
    });
    await sleep(40);
  }
  await sleep(200);
}

/**
 * 等星云彻底停稳。
 *
 * 🔴 用真实鼠标点击做测试之前**必须**先调它：力场还在跑的时候泡泡是移动的，
 *    而"算出中心点"和"真正点下去"之间隔了几十毫秒 —— 泡泡一移，点就落空了。
 *    表现是随机的"双击没生效""拖拽没反应"，非常难查（本机踩过）。
 */
async function settle(cdp, timeoutMs = 20000) {
  await waitUntil(cdp, `window.__nebula.field.tier() === 'asleep'`, timeoutMs);
  await sleep(150);
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
const IDEA_COUNT = `document.querySelectorAll('.bubble--idea:not(.bubble--shadow)').length`;
const IDEA_TEXTS = `Array.from(document.querySelectorAll('.bubble--idea:not(.bubble--shadow) .bubble-label')).map(e=>e.textContent)`;
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

    // 🔴 固定视口尺寸。headless 的默认窗口只有 754×333，而泡泡的散布半径可达 320 ——
    //    在小窗口里很多泡泡会落在 #stage 之外被裁掉，于是"真实鼠标点击"点不到它们，
    //    拖拽测试会以"什么都不发生"的形式假失败。固定成常见笔记本尺寸再加载。
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1024,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send('Page.navigate', { url: URL_BASE });
    await sleep(600);

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
    ok(await evaluate(cdp, `document.querySelector('#tools-panel').hidden && getComputedStyle(document.querySelector('#search')).display !== 'none' && document.querySelector('#search').getClientRects().length === 0`), '工具默认收起，搜索不占据页面');
    ok(await evaluate(cdp, `document.querySelector('.dock').querySelectorAll('textarea').length === 1 && !document.querySelector('.dock .meta,.dock .searchrow,.dock .sync-bar,.dock .devrow')`), '底部只保留录入与临时提示');
    ok(await evaluate(cdp, `!window.__nebula.uiState().tools && !window.__nebula.uiState().spaceOverview`), '调试出口显示工具与星图均处于关闭状态');
    ok(await evaluate(cdp, `document.querySelector('#input').scrollHeight <= document.querySelector('#input').clientHeight + 1`), '空输入栏不出现多余的纵向滚动');
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
      `Math.max(...Array.from(document.querySelectorAll('.bubble--idea:not(.bubble--shadow) .bubble-label')).map(e=>e.textContent.length))`,
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
    // The full-screen map intentionally hides recording while naming a new space.
    await click(cdp, '#space-close');
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
    // Capture a stable A baseline; CDP calls and the async switch otherwise include A's own remaining ticks.
    await settle(cdp);
    const aPositionsBefore = JSON.stringify(await evaluate(cdp, `window.__nebula.positions(${JSON.stringify(spaceA)})`));
    await evaluate(cdp, `window.__nebula.switchSpace(${JSON.stringify(spaceB)})`);
    await sleep(1500); // 让 B 的力导向充分跑一段时间
    const aPositionsAfter = JSON.stringify(await evaluate(cdp, `window.__nebula.positions(${JSON.stringify(spaceA)})`));

    let isoDiff = '';
    if (aPositionsBefore !== aPositionsAfter) {
      const before = JSON.parse(aPositionsBefore);
      const after = JSON.parse(aPositionsAfter);
      isoDiff = before
        .map((b, i) => {
          const a = after[i] ?? {};
          const d = Math.hypot((a.x ?? 0) - b.x, (a.y ?? 0) - b.y);
          return `#${i} 移动 ${d.toFixed(3)}px`;
        })
        .join(' / ');
    }
    ok(
      aPositionsBefore === aPositionsAfter,
      '模拟 B 空间 1.5 秒后，A 空间的泡泡坐标完全没变',
      isoDiff,
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
      (await evaluate(cdp, `document.querySelectorAll('.bubble--idea:not(.bubble--shadow)').length`)) === 3,
      '当前空间是 A，泡泡仍是 3 个（删除 B 没影响 A）',
    );

    await evaluate(cdp, `window.__nebula.openTrash()`);
    await sleep(400);
    await screenshot(cdp, 'trash');
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
    await click(cdp, '#trash-close');
    await settle(cdp);
    await screenshot(cdp, 'desktop');
    await click(cdp, '.bubble--heart');
    await sleep(350);
    ok(
      !(await evaluate(cdp, `document.querySelector('#space-layer').hidden`)),
      '点击心泡泡浮出空间切换层',
    );
    ok(
      (await evaluate(cdp, `document.querySelectorAll('.space-chip').length`)) === 2,
      '浮层里列出了 2 个空间的心泡泡',
    );
    ok(await evaluate(cdp, `getComputedStyle(document.querySelector('#world')).visibility === 'hidden' && getComputedStyle(document.querySelector('.dock')).visibility === 'hidden'`), '空间星图只显示中心星体，想法与录入暂时退场');
    ok(await evaluate(cdp, `(() => { const r = document.querySelector('.space-map').getBoundingClientRect(); return r.width === innerWidth && r.height === innerHeight; })()`), '空间星图覆盖完整视口');
    await screenshot(cdp, 'spaces');
    const oldSpaceName = await evaluate(cdp, 'window.__nebula.current().name');
    await click(cdp, '.space-chip.is-current .space-chip-rename');
    ok(await evaluate(cdp, `document.activeElement.matches('.space-chip-input')`), '真实点击当前空间的改名入口，输入框获得焦点');
    await cdp.send('Input.insertText', {text: '中心空间验收'});
    await cdp.send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13});
    ok(await waitUntil(cdp, `window.__nebula.current().name === '中心空间验收'`), '当前中心空间可以改名');
    ok(await evaluate(cdp, `window.__nebula.store.getAllSpaces().then(spaces => spaces.some(s => s.name === '中心空间验收'))`), '改名先写入 IndexedDB');
    await click(cdp, '#space-close');
    await cdp.send('Page.reload');
    await sleep(400);
    await waitUntil(cdp, '!!window.__nebula && document.readyState === "complete"');
    ok(await evaluate(cdp, `document.querySelector('#world .bubble--heart .bubble-label').textContent === '中心空间验收'`), '刷新后中心泡泡保留新名字');
    await evaluate(cdp, `window.__nebula.renameSpace(window.__nebula.current().id, ${JSON.stringify(oldSpaceName)})`);
    await settle(cdp);
    await click(cdp, '.bubble--heart');
    await click(cdp, '.space-list');
    ok(await evaluate(cdp, `document.querySelector('#space-layer').hidden`), '真实点击星图的空白处返回当前空间');
    await click(cdp, '.bubble--heart');
    await click(cdp, '.space-chip:nth-child(2) .space-chip-main');
    await sleep(400);
    ok(
      await evaluate(cdp, `document.querySelector('#space-layer').hidden`),
      '点某个空间后浮层收回',
    );

    console.log('\n── 拖拽（阶段 3） ──');

    // 回到 A 空间并等星云先静止 —— 否则"拖动前后"的对比会被星云自身的流动污染
    await evaluate(cdp, `window.__nebula.switchSpace(${JSON.stringify(spaceA)})`);
    await sleep(800);
    // 先把全部泡泡收进视野，保证后面用真实鼠标点得到它们
    await evaluate(cdp, `window.__nebula.fitAll()`);
    await settle(cdp);

    const targetId = await evaluate(
      cdp,
      `(() => {
        const stage = document.querySelector('#stage').getBoundingClientRect();
        const inside = Array.from(document.querySelectorAll('.bubble--idea:not(.bubble--shadow)')).find((el) => {
          const r = el.getBoundingClientRect();
          return r.left >= stage.left + 4 && r.top >= stage.top + 4 &&
                 r.right <= stage.right - 4 && r.bottom <= stage.bottom - 4;
        });
        return inside ? inside.dataset.id : null;
      })()`,
    );
    ok(typeof targetId === 'string' && targetId.length > 0, '找到一个完整落在画布内的可拖泡泡', String(targetId));

    const bubbleSel = `.bubble[data-id="${targetId}"]`;
    const p0 = JSON.parse(await evaluate(cdp, `JSON.stringify(window.__nebula.bodyState(${JSON.stringify(targetId)}))`));

    // 分步拖：按下 → 移动到位 → **先不松手**
    const from = await centerOf(cdp, bubbleSel);
    const DX = 260;
    const DY = 120;
    const STEPS = 12;

    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: from.x,
      y: from.y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    for (let i = 1; i <= STEPS; i++) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: from.x + (DX * i) / STEPS,
        y: from.y + (DY * i) / STEPS,
        button: 'left',
        buttons: 1,
      });
      await sleep(16);
    }

    ok(await evaluate(cdp, `window.__nebula.isDragging()`), '越过 8px 阈值后进入了拖拽状态');

    // 🔴 拖拽中必须关掉 hover 效果，否则会"一边拖一边胀大"
    const dragCls = await evaluate(
      cdp,
      `(() => {
        const el = document.querySelector(${JSON.stringify(bubbleSel)});
        return { cls: el.classList.contains('bubble--dragging'),
                 scale: getComputedStyle(el.querySelector('.bubble-scale')).transform };
      })()`,
    );
    ok(dragCls.cls, '拖拽中的泡泡带上了 bubble--dragging');
    ok(
      dragCls.scale === 'none' || dragCls.scale === 'matrix(1, 0, 0, 1, 0, 0)',
      '拖拽中缩放被压住（没有 hover 效果）',
      dragCls.scale,
    );

    // 🔴 按住不动 250ms：坐标必须一动不动。
    //    如果引擎还在写它，这里会看到抖动或被"吸回"。
    const holdA = await evaluate(cdp, `JSON.stringify(window.__nebula.bodyState(${JSON.stringify(targetId)}))`);
    await sleep(250);
    const holdB = await evaluate(cdp, `JSON.stringify(window.__nebula.bodyState(${JSON.stringify(targetId)}))`);
    ok(holdA === holdB, '按住不动 250ms，泡泡坐标完全没变（引擎确实没在写它）', `${holdA} → ${holdB}`);

    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: from.x + DX,
      y: from.y + DY,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });

    // 松手瞬间取样（只等一帧），用来量"飘了多远"
    await sleep(30);
    const atRelease = JSON.parse(
      await evaluate(cdp, `JSON.stringify(window.__nebula.bodyState(${JSON.stringify(targetId)}))`),
    );
    const speed = Math.hypot(atRelease.vx, atRelease.vy);
    ok(speed > 50, `松手时挂上了甩出速度（${speed.toFixed(0)} 单位/秒）`);
    ok(atRelease.dragging === false, '松手后 dragging 标记立刻清掉');

    // 等它滑完并落库
    await settle(cdp);
    await sleep(700);

    const settled = JSON.parse(
      await evaluate(cdp, `JSON.stringify(window.__nebula.bodyState(${JSON.stringify(targetId)}))`),
    );

    // 🔴 这一条直接验证用户的原话："默认不立刻定住，松手后会飘一点"
    const glide = Math.hypot(settled.x - atRelease.x, settled.y - atRelease.y);
    ok(glide > 5, `松手后不是硬停，又飘了 ${glide.toFixed(0)} 个单位才停下`);

    const movedBy = Math.hypot(settled.x - p0.x, settled.y - p0.y);
    ok(movedBy > 150, `整个手势把它挪走了 ${movedBy.toFixed(0)} 个单位`);

    console.log('\n── 位置持久化（阶段 3） ──');

    const stored = JSON.parse(
      await evaluate(
        cdp,
        `window.__nebula.storedIdea(${JSON.stringify(targetId)}).then(i =>
          JSON.stringify({ x: i.x, y: i.y, movedAt: i.movedAt, updatedAt: i.updatedAt, createdAt: i.createdAt }))`,
      ),
    );

    ok(
      Math.hypot(stored.x - settled.x, stored.y - settled.y) < 2,
      '数据库里的坐标 = 泡泡最终停下的位置',
      `库 (${stored.x.toFixed(0)}, ${stored.y.toFixed(0)}) vs 屏 (${settled.x.toFixed(0)}, ${settled.y.toFixed(0)})`,
    );
    ok(stored.movedAt > 0, 'movedAt 已写入');
    ok(
      stored.updatedAt === stored.createdAt,
      '🔴 拖拽只动了 movedAt，updatedAt 与 createdAt 仍相等（两个时间戳确实分离）',
      `updatedAt=${stored.updatedAt} createdAt=${stored.createdAt}`,
    );

    // 刷新后应该回到落库的位置，而不是原来的随机落点
    await cdp.send('Page.reload', { ignoreCache: true });
    await sleep(400);
    await waitUntil(cdp, `document.readyState === 'complete' && !!window.__nebula`);
    await waitUntil(cdp, `!!window.__nebula.bodyState(${JSON.stringify(targetId)})`, 10000);

    const afterReload = JSON.parse(
      await evaluate(cdp, `JSON.stringify(window.__nebula.bodyState(${JSON.stringify(targetId)}))`),
    );
    const dStored = Math.hypot(afterReload.x - stored.x, afterReload.y - stored.y);
    const dOriginal = Math.hypot(afterReload.x - p0.x, afterReload.y - p0.y);
    ok(
      dStored < dOriginal,
      '刷新后泡泡回到数据库里记的位置，而不是原来的随机落点',
      `到落库位置 ${dStored.toFixed(0)}，到原始位置 ${dOriginal.toFixed(0)}`,
    );

    console.log('\n── 双击锁定（阶段 3） ──');

    // 刷新之后力场从 0.6 开始重新收敛，此时泡泡是动的 —— 必须先停稳再点
    await settle(cdp);
    await doubleClick(cdp, bubbleSel);
    ok(
      (await evaluate(cdp, `window.__nebula.storedIdea(${JSON.stringify(targetId)}).then(i => i.pinned)`)) === 1,
      '双击后 pinned 落库为 1',
    );
    ok(
      await evaluate(
        cdp,
        `document.querySelector('.bubble[data-id="${targetId}"]').classList.contains('bubble--pinned')`,
      ),
      '泡泡加上了「已锁定」外观',
    );

    // 锁定的泡泡在星云里应该纹丝不动
    const pinBefore = JSON.parse(
      await evaluate(cdp, `JSON.stringify(window.__nebula.bodyState(${JSON.stringify(targetId)}))`),
    );
    await evaluate(cdp, `window.__nebula.field.wake(1)`);
    await sleep(1500);
    const pinAfter = JSON.parse(
      await evaluate(cdp, `JSON.stringify(window.__nebula.bodyState(${JSON.stringify(targetId)}))`),
    );
    ok(
      pinBefore.x === pinAfter.x && pinBefore.y === pinAfter.y,
      '锁定后唤醒星云跑 1.5 秒，它的坐标一动不动',
      `${pinBefore.x.toFixed(0)},${pinBefore.y.toFixed(0)} → ${pinAfter.x.toFixed(0)},${pinAfter.y.toFixed(0)}`,
    );

    await doubleClick(cdp, bubbleSel);
    ok(
      (await evaluate(cdp, `window.__nebula.storedIdea(${JSON.stringify(targetId)}).then(i => i.pinned)`)) === 0,
      '再双击一次解除锁定',
    );

    console.log('\n── 心泡泡不可拖（阶段 3） ──');

    const heartBefore = JSON.parse(await evaluate(cdp, `JSON.stringify(window.__nebula.heartState())`));
    await mouseDrag(cdp, '.bubble--heart', 180, 90);
    await sleep(400);
    const heartAfter = JSON.parse(await evaluate(cdp, `JSON.stringify(window.__nebula.heartState())`));
    ok(
      heartAfter.x === heartBefore.x && heartAfter.y === heartBefore.y,
      '心泡泡被拖了也不动（它钉在世界原点）',
      JSON.stringify(heartAfter),
    );
    ok(heartAfter.dragging === false, '心泡泡从未进入拖拽状态');
    ok(
      await evaluate(cdp, `document.querySelector('#space-layer').hidden`),
      '拖心泡泡没有误触发空间切换浮层',
    );

    console.log('\n── 命中测试（真实点击路径） ──');

    // 先回全貌，保证待测的泡泡确实在画布内
    await evaluate(cdp, `window.__nebula.fitAll()`);
    await sleep(250);

    // 🔴 这一节存在的理由：JS 的 element.click() 会**绕过命中测试**直接派发事件，
    //    所以"用 .click() 测通过"完全不能说明用户点得到。曾经有个 bug 是浮层
    //    以 transparent + 可命中的状态一直盖在页面上，把全部鼠标点击吃掉了，
    //    而当时所有测试都用 .click()，一条都没发现。
    const hitProbe = await evaluate(
      cdp,
      `(() => {
        const el = document.querySelector('.bubble--idea:not(.bubble--shadow)');
        if (!el) return { ok: false, why: '没有想法泡泡' };
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return {
          ok: !!(hit && hit.closest('.bubble')),
          hit: hit ? hit.tagName + '.' + hit.className : 'null',
          x: Math.round(r.left + r.width / 2),
          y: Math.round(r.top + r.height / 2),
        };
      })()`,
    );

    // 前提：此时不能有任何浮层开着，否则测的是浮层而不是泡泡
    ok(
      await evaluate(
        cdp,
        `Array.from(document.querySelectorAll('.layer')).every(l => l.hidden === true)`,
      ),
      '命中测试前没有任何浮层开着（前提成立）',
    );

    ok(hitProbe.ok, '泡泡中心点上的元素就是这个泡泡（没有被透明浮层盖住）', JSON.stringify(hitProbe));

    const hiddenLayers = await evaluate(
      cdp,
      `Array.from(document.querySelectorAll('.layer')).every(l => l.hidden === true ? getComputedStyle(l).display === 'none' : true)`,
    );
    ok(hiddenLayers, '带 hidden 的浮层真的不参与布局与命中测试（display: none）');

    const heartHit = await evaluate(
      cdp,
      `(() => {
        const el = document.querySelector('.bubble--heart');
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !!(hit && hit.closest('.bubble--heart'));
      })()`,
    );
    ok(heartHit, '心泡泡中心点上的元素就是心泡泡本身');

    console.log('\n── 飞入动画（阶段 4） ──');

    await evaluate(cdp, `window.__nebula.fitAll()`);
    await sleep(300);

    const FLY_TEXT = '飞进来的想法';
    // 只等很短的时间、且不等落定 —— 好在飞行途中取样
    await typeAndEnter(cdp, FLY_TEXT, 150, false);

    const midFlight = await evaluate(
      cdp,
      `(() => ({
        shadow: !!document.querySelector('.bubble--shadow'),
        inFxLayer: !!document.querySelector('.fx-layer .bubble--shadow'),
        realBubble: Array.from(document.querySelectorAll('.bubble--idea:not(.bubble--shadow)'))
          .some(e => e.querySelector('.bubble-label').textContent === ${JSON.stringify(FLY_TEXT)}),
      }))()`,
    );
    ok(midFlight.shadow, '飞行途中存在影子泡泡（而不是直接动画真泡泡）', JSON.stringify(midFlight));
    ok(midFlight.inFxLayer, '影子住在 body 下的固定图层里（不受 #world 的二次变换影响）');
    ok(!midFlight.realBubble, '落定之前真泡泡还没有被创建（影子交接，不是两套并存）');

    // 等落定
    await waitUntil(cdp, `!document.querySelector('.bubble--shadow')`, 6000);
    await sleep(120);

    const rippleCount = await evaluate(cdp, `document.querySelectorAll('.ripple').length`);
    ok(rippleCount >= 1, `落定时出现了涟漪（还有 ${rippleCount} 个在扩散）`);

    const flight = JSON.parse(await evaluate(cdp, `JSON.stringify(window.__nebula.lastFlight())`));
    const dShadowToTarget = Math.hypot(flight.shadowEnd.x - flight.to.x, flight.shadowEnd.y - flight.to.y);
    ok(
      dShadowToTarget < 3,
      '🔴 影子最终落在算出来的终点上 —— offset-path 的"视口绝对坐标"用对了',
      `偏差 ${dShadowToTarget.toFixed(2)}px（若坐标系写错，这里会差几百像素）`,
    );

    // 控制点确实在中点上方（弧线而不是直线）
    const midY = (flight.from.y + flight.to.y) / 2;
    ok(flight.control.y < midY - 10, `弧线确实向上兜（控制点比中点高 ${(midY - flight.control.y).toFixed(0)}px）`);

    const landed = await evaluate(
      cdp,
      `(() => {
        const el = Array.from(document.querySelectorAll('.bubble--idea:not(.bubble--shadow)'))
          .find(e => e.querySelector('.bubble-label').textContent === ${JSON.stringify(FLY_TEXT)});
        return el ? true : null;
      })()`,
    );
    ok(landed === true, '落定后真泡泡已经出现');

    // 🔴 用"创建那一刻"记录的位置比，而不是现在的位置 ——
    //    力场在落定后立刻开始推它，晚测 100ms 就已经偏了十几像素
    ok(flight.landedAt !== null, '记录了真泡泡诞生的那一刻位置');
    const dHandoff = flight.landedAt
      ? Math.hypot(flight.landedAt.x - flight.shadowEnd.x, flight.landedAt.y - flight.shadowEnd.y)
      : 999;
    ok(
      dHandoff < 2,
      '影子落点与真泡泡的诞生位置重合（交接不跳）',
      `偏差 ${dHandoff.toFixed(2)}px`,
    );

    console.log('\n── 悬停微胀大（阶段 4） ──');

    await evaluate(cdp, `window.__nebula.fitAll()`);
    // 先把鼠标移开，确保不是悬停态
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 8, y: 8 });
    await sleep(250);

    const hoverTargetSel = await evaluate(
      cdp,
      `(() => {
        const stage = document.querySelector('#stage').getBoundingClientRect();
        const el = Array.from(document.querySelectorAll('.bubble--idea:not(.bubble--shadow)')).find((e) => {
          const r = e.getBoundingClientRect();
          return r.left >= stage.left + 6 && r.top >= stage.top + 6 &&
                 r.right <= stage.right - 6 && r.bottom <= stage.bottom - 6;
        });
        return el ? '.bubble[data-id="' + el.dataset.id + '"]' : null;
      })()`,
    );
    ok(typeof hoverTargetSel === 'string', '找到一个可以做悬停测试的泡泡', String(hoverTargetSel));

    const idle = await evaluate(
      cdp,
      `(() => {
        const el = document.querySelector(${JSON.stringify(hoverTargetSel)});
        return {
          scale: getComputedStyle(el.querySelector('.bubble-scale')).transform,
          labelOpacity: getComputedStyle(el.querySelector('.bubble-label')).opacity,
          labelShadow: getComputedStyle(el.querySelector('.bubble-label')).textShadow,
        };
      })()`,
    );
    ok(
      idle.scale === 'none' || idle.scale === 'matrix(1, 0, 0, 1, 0, 0)',
      '未悬停时没有缩放',
      idle.scale,
    );
    ok(Number(idle.labelOpacity) < 1, `未悬停时文字是"柔"的（opacity ${idle.labelOpacity}）`);
    ok(
      idle.labelShadow !== 'none',
      '柔化用 text-shadow 实现，而不是 filter: blur()（几百个元素上 blur 会掉到个位数 fps）',
      idle.labelShadow,
    );

    const hoverPoint = await centerOf(cdp, hoverTargetSel);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hoverPoint.x, y: hoverPoint.y });
    await sleep(280);

    const hovered = await evaluate(
      cdp,
      `(() => {
        const el = document.querySelector(${JSON.stringify(hoverTargetSel)});
        return {
          scale: getComputedStyle(el.querySelector('.bubble-scale')).transform,
          labelOpacity: getComputedStyle(el.querySelector('.bubble-label')).opacity,
          labelShadow: getComputedStyle(el.querySelector('.bubble-label')).textShadow,
        };
      })()`,
    );
    const hoverScale = Number((hovered.scale.match(/matrix\(([\d.]+)/) ?? [])[1]);
    ok(hoverScale > 1.03 && hoverScale < 1.05, `悬停时放大到 1.04（实测 ${hoverScale}）`, hovered.scale);
    ok(Number(hovered.labelOpacity) === 1, `悬停时文字变清晰（opacity ${hovered.labelOpacity}）`);
    ok(hovered.labelShadow === 'none', '悬停时去掉了柔化', hovered.labelShadow);

    console.log('\n── 放大到中央（阶段 4） ──');

    await evaluate(cdp, `window.__nebula.fitAll()`);
    await sleep(250);

    const zoomTargetId = await evaluate(
      cdp,
      `(() => {
        const stage = document.querySelector('#stage').getBoundingClientRect();
        const el = Array.from(document.querySelectorAll('.bubble--idea:not(.bubble--shadow)')).find((e) => {
          const r = e.getBoundingClientRect();
          return r.left >= stage.left + 6 && r.top >= stage.top + 6 &&
                 r.right <= stage.right - 6 && r.bottom <= stage.bottom - 6;
        });
        return el ? el.dataset.id : null;
      })()`,
    );
    const zoomSel = `.bubble[data-id="${zoomTargetId}"]`;
    const zoomPoint = await centerOf(cdp, zoomSel);

    // 真实单击（不是 .click() —— 命中测试那节已经证明这条路是通的）
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: zoomPoint.x,
      y: zoomPoint.y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: zoomPoint.x,
      y: zoomPoint.y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
    await sleep(520);

    ok(await evaluate(cdp, `window.__nebula.isZoomed()`), '单击泡泡 → 放大态打开');

    const zoomView = await evaluate(
      cdp,
      `(() => {
        const clone = document.querySelector('.bubble--zoom');
        if (!clone) return null;
        const r = clone.getBoundingClientRect();
        const src = document.querySelector(${JSON.stringify(zoomSel)});
        const rec = window.__nebula.lastZoom();
        return {
          w: r.width, h: r.height,
          cx: r.left + r.width / 2, cy: r.top + r.height / 2,
          vw: innerWidth, vh: innerHeight,
          srcHidden: src.classList.contains('bubble--hidden'),
          recSrcAspect: rec.src.w / rec.src.h,
          recTargetAspect: rec.target.w / rec.target.h,
          shape: rec.shape,
          scale: rec.scale,
          backdrop: !!document.querySelector('.zoom-backdrop'),
        };
      })()`,
    );
    ok(zoomView !== null, '放大态的克隆体已经出现');
    await screenshot(cdp, 'reading');
    ok(zoomView?.backdrop, '放大时底层有遮罩（点它可以收回）');
    ok(zoomView?.srcHidden, '原泡泡被暂时隐藏（收回时会原地复活）');

    const dCenter = Math.hypot(zoomView.cx - zoomView.vw / 2, zoomView.cy - zoomView.vh / 2);
    ok(dCenter < 3, `放大后居中于屏幕（偏离中心 ${dCenter.toFixed(1)}px）`);

    // 🔴 形状不歪的判据：目标框与源框长宽比一致
    ok(
      Math.abs(zoomView.recTargetAspect - zoomView.recSrcAspect) < 1e-9,
      '🔴 目标框与源框长宽比完全一致 ⇒ 等比缩放不会把形状拉歪',
      `${zoomView.recSrcAspect.toFixed(4)} vs ${zoomView.recTargetAspect.toFixed(4)}`,
    );
    ok(
      Math.abs(zoomView.w / zoomView.h - zoomView.recSrcAspect) < 0.02,
      'DOM 里克隆体的实测长宽比也与源一致（不只是纸面计算）',
      `${(zoomView.w / zoomView.h).toFixed(4)}`,
    );
    ok(zoomView.scale >= 1 && zoomView.scale <= 3.4, `放大倍数在合理区间（${zoomView.scale.toFixed(2)}）`);

    // 🔴 字号公式的最终检验：真实排版下文字必须既没横向溢出、也没纵向被截断。
    //    单元测试用的是"每行字数 ≈ 框宽 / 字号"的一阶模型，只有这里能验真实换行。
    const fitCheck = async (label) => {
      const info = await evaluate(
        cdp,
        `(() => {
          const clone = document.querySelector('.bubble--zoom');
          if (!clone) return null;
          const inner = clone.querySelector('.bubble-inner');
          const lab = clone.querySelector('.bubble-label');
          const fs = parseFloat(getComputedStyle(lab).fontSize);
          return {
            font: +fs.toFixed(1),
            innerW: inner.clientWidth, innerH: inner.clientHeight,
            labelW: lab.scrollWidth, labelH: lab.scrollHeight,
            lines: Math.round(lab.scrollHeight / (fs * 1.45)),
            chars: lab.textContent.length,
          };
        })()`,
      );
      ok(
        info !== null && info.labelW <= info.innerW + 1,
        `${label}：放大态文字没有横向溢出`,
        JSON.stringify(info),
      );
      ok(
        info !== null && info.labelH <= info.innerH + 1,
        `${label}：放大态文字没有纵向被截断`,
        JSON.stringify(info),
      );
      return info;
    };

    await fitCheck('当前这条（短文本）');

    // 再验一条长文本（卡片档）—— 最容易塞不下的就是它
    const closeZoomAndOpenLong = async () => {
      for (const type of ['keyDown', 'keyUp']) {
        await cdp.send('Input.dispatchKeyEvent', {
          type,
          key: 'Escape',
          code: 'Escape',
          windowsVirtualKeyCode: 27,
        });
      }
      await sleep(400);

      const longCenter = await evaluate(
        cdp,
        `(() => {
          const el = Array.from(document.querySelectorAll('.bubble--idea:not(.bubble--shadow)'))
            .sort((a, b) => b.querySelector('.bubble-label').textContent.length
                          - a.querySelector('.bubble-label').textContent.length)[0];
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        })()`,
      );
      if (!longCenter) return false;

      for (const type of ['mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent', {
          type,
          x: longCenter.x,
          y: longCenter.y,
          button: 'left',
          buttons: type === 'mousePressed' ? 1 : 0,
          clickCount: 1,
        });
      }
      await sleep(600);
      return await evaluate(cdp, `window.__nebula.isZoomed()`);
    };

    if (await closeZoomAndOpenLong()) {
      const longPlan = JSON.parse(await evaluate(cdp, `JSON.stringify(window.__nebula.lastZoom())`));
      ok(longPlan.shape === 'card' || longPlan.shape === 'circle', `长文本的档位：${longPlan.shape}`);
      await fitCheck('最长的那条（卡片档）');
      for (const type of ['keyDown', 'keyUp']) {
        await cdp.send('Input.dispatchKeyEvent', {
          type,
          key: 'Escape',
          code: 'Escape',
          windowsVirtualKeyCode: 27,
        });
      }
      await sleep(400);
    } else {
      ok(false, '能打开最长那条的放大态');
    }

    // 为后面的"三次收回"测试重新打开一次
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', {
        type,
        x: zoomPoint.x,
        y: zoomPoint.y,
        button: 'left',
        buttons: type === 'mousePressed' ? 1 : 0,
        clickCount: 1,
      });
    }
    await sleep(600);

    // 收回方式 1：按 Esc
    for (const type of ['keyDown', 'keyUp']) {
      await cdp.send('Input.dispatchKeyEvent', {
        type,
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27,
      });
    }
    await sleep(400);
    ok(!(await evaluate(cdp, `window.__nebula.isZoomed()`)), '按 Esc 收回');
    ok(
      !(await evaluate(cdp, `document.querySelector(${JSON.stringify(zoomSel)}).classList.contains('bubble--hidden')`)),
      '收回后原泡泡重新出现',
    );

    // 收回方式 2：点空白（遮罩）
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: zoomPoint.x,
      y: zoomPoint.y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: zoomPoint.x,
      y: zoomPoint.y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
    await sleep(520);
    ok(await evaluate(cdp, `window.__nebula.isZoomed()`), '再次单击 → 又放大');

    const backdropAt = await evaluate(
      cdp,
      `(() => {
        const b = document.querySelector('.zoom-backdrop');
        const r = b.getBoundingClientRect();
        return { x: r.left + 12, y: r.top + 12 };
      })()`,
    );
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: backdropAt.x,
      y: backdropAt.y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: backdropAt.x,
      y: backdropAt.y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
    await sleep(400);
    ok(!(await evaluate(cdp, `window.__nebula.isZoomed()`)), '点空白（遮罩）收回');

    // 收回方式 3：再点放大后的泡泡
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: zoomPoint.x,
      y: zoomPoint.y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: zoomPoint.x,
      y: zoomPoint.y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
    await sleep(520);
    ok(await evaluate(cdp, `window.__nebula.isZoomed()`), '第三次单击 → 放大');

    const cloneCenter = await evaluate(
      cdp,
      `(() => { const r = document.querySelector('.bubble--zoom').getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
    );
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: cloneCenter.x,
      y: cloneCenter.y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: cloneCenter.x,
      y: cloneCenter.y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
    await sleep(400);
    ok(!(await evaluate(cdp, `window.__nebula.isZoomed()`)), '再点放大后的泡泡也能收回');

    console.log('\n── 搜索：聚光不是清场（阶段 5） ──');

    await settle(cdp);
    await evaluate(cdp, `window.__nebula.clearSearch()`);
    await evaluate(cdp, `window.__nebula.fitAll()`);
    await sleep(250);

    const BUBBLES = `.bubble--idea:not(.bubble--shadow)`;
    // returnByValue 已经把对象反序列化好了，不要再 JSON.parse（会得到 "[object Object]"）
    const probe = async () =>
      await evaluate(
        cdp,
        `(() => ({
            total: document.querySelectorAll('${BUBBLES}').length,
            hit: document.querySelectorAll('.bubble--hit').length,
            dim: document.querySelectorAll('.bubble--idea.bubble--dim').length,
            marks: Array.from(document.querySelectorAll('.bubble-label mark')).map(m => m.textContent),
            count: document.querySelector('#search-count').textContent,
            hintHidden: document.querySelector('#search-hint').hidden,
            hintText: document.querySelector('#search-hint').textContent,
          }))()`,
      );

    /** 用真实键盘输入搜索词（会触发真实的 input 事件）。 */
    const typeSearch = async (text) => {
      if (await evaluate(cdp, `document.querySelector('#tools-panel').hidden`)) await click(cdp, '#tools-toggle');
      await evaluate(
        cdp,
        `(() => { const el = document.querySelector('#search'); el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); })()`,
      );
      await sleep(220);
      await evaluate(cdp, `document.querySelector('#search').focus()`);
      if (text !== '') await cdp.send('Input.insertText', { text });
      await sleep(340); // 超过 120ms 的 debounce
    };

    const before = await probe();
    ok(before.total > 0, `当前空间有 ${before.total} 个泡泡可搜`);

    // ── 搜「三点」 ──
    await typeSearch('三点');
    await screenshot(cdp, 'search');
    const s1 = await probe();
    ok(s1.hit === 1, `搜「三点」命中 1 条（实际 ${s1.hit}）`);
    ok(s1.count === '⌕ 1 条', `计数文案正确（${s1.count}）`);
    ok(s1.marks.includes('三点'), `命中文字被 <mark> 包住（${JSON.stringify(s1.marks)}）`);
    ok(s1.dim === s1.total - 1, `其余 ${s1.dim} 条变暗`);
    ok(
      s1.total === before.total,
      '🔴 未命中的泡泡一个都没被移除（搜索是手电筒，不是筛子）',
      `${before.total} → ${s1.total}`,
    );

    // ── 搜「三」：命中应该变多 ──
    await typeSearch('三');
    const s2 = await probe();
    ok(s2.hit >= 1, `搜「三」命中 ${s2.hit} 条`);
    ok(s2.total === before.total, '换查询词后泡泡总数依然不变');

    // ── 搜「凌晨」：前缀命中 ──
    await typeSearch('凌晨');
    const s3 = await probe();
    ok(s3.hit >= 1, `搜「凌晨」命中 ${s3.hit} 条`);
    ok(s3.marks.some((m) => m.startsWith('凌晨')), `前缀被标出（${JSON.stringify(s3.marks)}）`);

    // ── 搜单字「水」 ──
    await typeSearch('水');
    const s4 = await probe();
    ok(s4.hit >= 1, `搜单字「水」命中 ${s4.hit} 条`);
    ok(s4.marks.includes('水'), '单字也被正确标出');

    // ── 搜不存在的东西 ──
    await typeSearch('zzzz不存在zzzz');
    const s5 = await probe();
    ok(s5.hit === 0, '搜不存在的东西：0 条命中');
    ok(s5.count === '⌕ 0 条', `计数显示 0（${s5.count}）`);
    ok(s5.marks.length === 0, '没有残留的高亮');
    ok(s5.dim === s5.total, '全部变暗');
    ok(s5.total === before.total, '🔴 一条都没被筛掉');

    console.log('\n── 搜索：中文输入法守卫 ──');

    // 直接派发 composition 事件来模拟输入法组字（这是唯一可行的模拟方式）
    await typeSearch('');
    const beforeIme = await probe();

    await evaluate(
      cdp,
      `(() => {
        const el = document.querySelector('#search');
        el.focus();
        el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        el.value = 'lingsant';
        for (let i = 1; i <= 8; i++) {
          el.value = 'lingsant'.slice(0, i);
          el.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
        }
      })()`,
    );
    await sleep(500); // 远超 debounce，如果守卫失效这里早就搜过 8 次了

    const duringIme = await probe();
    ok(
      duringIme.hit === 0 && duringIme.marks.length === 0,
      '🔴 组字过程中没有触发任何搜索（否则打拼音时每个中间态都会全量重搜、页面卡死）',
      JSON.stringify({ hit: duringIme.hit, marks: duringIme.marks, count: duringIme.count }),
    );
    ok(duringIme.total === beforeIme.total, '组字过程中星云没有任何变化');

    // 组字结束 + 最终 input ⇒ 这时才应该真的搜
    await evaluate(
      cdp,
      `(() => {
        const el = document.querySelector('#search');
        el.value = '凌晨';
        el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
        el.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: false }));
      })()`,
    );
    await sleep(400);
    const afterIme = await probe();
    ok(afterIme.hit >= 1, `组字结束后才真正搜索（命中 ${afterIme.hit} 条）`);

    console.log('\n── 搜索：Enter 跳转（移视口，不移泡泡） ──');

    await typeSearch('三');
    const jumpProbe = await probe();
    ok(jumpProbe.hit >= 1, `准备跳转：命中 ${jumpProbe.hit} 条`);

    const posBeforeJump = await evaluate(
      cdp,
      `JSON.stringify(window.__nebula.positions(window.__nebula.current().id))`,
    );
    const viewBeforeJump = await evaluate(
      cdp,
      `JSON.stringify({ tx: window.__nebula.field ? 0 : 0 })`,
    );
    void viewBeforeJump;

    const pressEnter = async (shift = false) => {
      for (const type of ['keyDown', 'keyUp']) {
        await cdp.send('Input.dispatchKeyEvent', {
          type,
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13,
          modifiers: shift ? 8 : 0,
        });
      }
      await sleep(420);
    };

    await pressEnter();
    const firstCenter = await evaluate(cdp, `window.__nebula.lastCentered()`);
    ok(typeof firstCenter === 'string' && firstCenter.length > 0, 'Enter 跳转到了某条命中');

    const posAfterJump = await evaluate(
      cdp,
      `JSON.stringify(window.__nebula.positions(window.__nebula.current().id))`,
    );
    ok(
      posBeforeJump === posAfterJump,
      '🔴 跳转只移动视口，泡泡的坐标一个都没变（不会"打断一边搜一边想"）',
    );

    await pressEnter();
    const secondCenter = await evaluate(cdp, `window.__nebula.lastCentered()`);
    ok(secondCenter !== firstCenter || jumpProbe.hit === 1, '再按 Enter 跳到下一条（循环）');

    await pressEnter(true);
    const backCenter = await evaluate(cdp, `window.__nebula.lastCentered()`);
    ok(
      backCenter === firstCenter || jumpProbe.hit <= 2,
      `Shift+Enter 往回跳（回到 ${backCenter === firstCenter ? '第一条' : '上一条'}）`,
    );

    console.log('\n── 搜索：切空间后重建结果 ──');

    await typeSearch('凌晨');
    const inA = await probe();
    ok(inA.hit >= 1, `在 A 空间命中 ${inA.hit} 条`);

    const otherSpaceId = await evaluate(
      cdp,
      `(() => { const cur = window.__nebula.current().id;
        const other = window.__nebula.spaces().find(s => s.id !== cur);
        return other ? other.id : null; })()`,
    );

    if (otherSpaceId) {
      await evaluate(cdp, `window.__nebula.switchSpace(${JSON.stringify(otherSpaceId)})`);
      await sleep(500);
      const inB = await probe();
      ok(
        inB.hit === 0 && inB.marks.length === 0,
        '🔴 切到另一个空间后，上一个空间的命中与高亮没有残留',
        JSON.stringify({ hit: inB.hit, marks: inB.marks, dim: inB.dim, count: inB.count }),
      );
      ok(inB.total === (await probe()).total, '新空间的泡泡数量正确');

      // 提示条：B 空间里搜 A 空间才有的词
      await typeSearch('凌晨');
      const crossHint = await probe();
      ok(
        !crossHint.hintHidden && /其他空间还有/.test(crossHint.hintText),
        `其他空间有命中时出现提示条（${crossHint.hintText}）`,
      );

      await evaluate(
        cdp,
        `document.querySelector('#search-hint').click()`,
      );
      await sleep(600);
      const afterGo = await probe();
      ok(
        afterGo.hit >= 1,
        '点提示条切到那个空间后，搜索词保留且命中被重建',
        JSON.stringify({ hit: afterGo.hit, count: afterGo.count }),
      );

      // 切回 A，清空搜索
      await evaluate(cdp, `window.__nebula.switchSpace(${JSON.stringify(spaceA)})`);
      await sleep(400);
    }

    await evaluate(cdp, `window.__nebula.clearSearch()`);
    await sleep(300);
    const cleared = await probe();
    ok(cleared.hit === 0 && cleared.dim === 0, '清空搜索后所有泡泡恢复正常');
    ok(cleared.count === '', '计数也清空了');

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

    console.log('\n── 同步演练（模拟远端，不需要真实 token） ──');

    // 装一个内存版"远端"。它把文件持久化到 localStorage，
    // 于是"删库 + 重载"之后还能拿回同一份远端数据 —— 相当于另一台设备看到的仓库。
    const installMockRemote = async () => {
      await evaluate(
        cdp,
        `(() => {
          const KEY = '__mockRepo';
          const files = new Map(Object.entries(JSON.parse(localStorage.getItem(KEY) || '{}')));
          let writes = 0;
          let mode = 'ok';
          const persist = () => localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(files)));
          const mkErr = (kind, msg) => Object.assign(new Error(msg), { kind, name: 'SyncError' });
          let account = 'mockuser';
          const store = {
            async identify() {
              if (mode === 'auth') throw mkErr('auth', '凭据无效（401）');
              return { login: account };
            },
            async ensureRepo() {
              if (mode === 'auth') throw mkErr('auth', '凭据无效（401）');
              return { created: files.size === 0, private: true, defaultBranch: 'main' };
            },
            setAccount: (h) => { account = h; },
            async readFile(path) {
              if (mode === 'auth') throw mkErr('auth', '凭据无效（401）：Bad credentials');
              if (mode === 'network') throw mkErr('network', '请求失败：Failed to fetch');
              const f = files.get(path);
              if (!f) return null;
              if (mode === 'garbage' && path.indexOf('backup') < 0 && path.indexOf('ideas.json') >= 0) {
                return { text: '{这是坏掉的 JSON', sha: f.sha, base64: '' };
              }
              return { text: f.text, sha: f.sha, base64: '' };
            },
            async writeFile(path, text, message, sha) {
              if (mode === 'auth') throw mkErr('auth', '凭据无效（401）');
              if (mode === 'network') throw mkErr('network', '请求失败：Failed to fetch');
              writes++;
              files.set(path, { text, sha: 'sha' + writes });
              persist();
            },
          };
          window.__mock = {
            store,
            setAccount: (h) => { account = h; },
            writes: () => writes,
            setMode: (m) => { mode = m; },
            read: (p) => (files.get(p) ? files.get(p).text : null),
            write: (p, t) => { files.set(p, { text: t, sha: 'manual' + Math.random() }); persist(); },
            reset: () => { files.clear(); writes = 0; mode = 'ok'; persist(); },
          };
          return 'ok';
        })()`,
      );
      await evaluate(cdp, `window.__nebula.installRemote(window.__mock.store)`);
    };

    await installMockRemote();

    const readLocalNow = async () => await evaluate(cdp, `window.__nebula.readLocalDoc()`);
    const runSync = async (waitMs = 500) => {
      await evaluate(cdp, `window.__nebula.syncNow(true)`);
      await sleep(waitMs);
    };

    // ── 演练 1：推送 ──
    const before1 = await readLocalNow();
    await evaluate(cdp, `window.__nebula.syncDirty()`);
    await runSync();

    const pushed = await evaluate(cdp, `window.__mock.read('data/ideas.json')`);
    ok(typeof pushed === 'string' && pushed.length > 0, '演练1：本地数据被推到了远端');
    const pushedDoc = JSON.parse(pushed);
    ok(
      pushedDoc.ideas.length === before1.ideas.length,
      `演练1：远端收到的条数与本地一致（${pushedDoc.ideas.length}/${before1.ideas.length}）`,
    );
    ok(
      (await evaluate(cdp, `window.__mock.read('data/sync.config.json')`)) !== null,
      '演练1：sync.config.json 被自动创建（首次同步）',
    );
    ok(
      (await evaluate(cdp, `window.__mock.read('data/ideas.backup.json')`)) !== null,
      '演练1：推送前先写了 backup（回退的弹药）',
    );
    ok(
      /^\{/.test(await evaluate(cdp, `window.__mock.read('data/ideas.json')`)),
      '演练1：远端文件是合法 JSON',
    );

    // ── 演练 9：内容相同 ⇒ 一个字节都不写 ──
    const writesBefore = await evaluate(cdp, `window.__mock.writes()`);
    await runSync();
    const writesAfter = await evaluate(cdp, `window.__mock.writes()`);
    ok(
      writesAfter === writesBefore,
      '演练9：内容没变时完全不发写请求（GitHub 每次 PUT 都会留一个 commit）',
      `${writesBefore} → ${writesAfter}`,
    );

    // ── 演练 4：并发合并不丢 ──
    const spaceId = before1.spaces[0]?.id;
    const remoteDoc = JSON.parse(await evaluate(cdp, `window.__mock.read('data/ideas.json')`));
    remoteDoc.ideas.push({
      id: 'remote-only-1',
      spaceId,
      text: '另一台设备加的想法',
      createdAt: 1,
      updatedAt: 1,
      movedAt: 0,
      x: 30,
      y: 30,
      pinned: 0,
      linksAlwaysOn: 0,
      archived: 0,
    });
    await evaluate(
      cdp,
      `window.__mock.write('data/ideas.json', ${JSON.stringify(JSON.stringify(remoteDoc, null, 2))})`,
    );

    // 本地也加一条（不推）
    await typeAndEnter(cdp, '这台设备加的想法');
    const afterLocalAdd = await readLocalNow();
    await evaluate(cdp, `window.__nebula.syncDirty()`);
    await runSync(900);

    const merged = JSON.parse(await evaluate(cdp, `window.__mock.read('data/ideas.json')`));
    const mergedTexts = merged.ideas.map((i) => i.text);
    ok(mergedTexts.includes('另一台设备加的想法'), '演练4：远端那条还在（没被本地覆盖）');
    ok(mergedTexts.includes('这台设备加的想法'), '演练4：本地那条也推上去了');
    ok(
      afterLocalAdd.ideas.length + 1 <= merged.ideas.length,
      `演练4：并发合并没有丢任何一条（${merged.ideas.length} 条）`,
    );

    // ── 演练 6：远端内容坏掉 ⇒ fail loud，本地一条不少 ──
    await evaluate(cdp, `window.__mock.setMode('garbage')`);
    const localBeforeBreak = await readLocalNow();
    await evaluate(cdp, `window.__nebula.syncDirty()`);
    await runSync(700);

    const stateAfterBreak = await evaluate(cdp, `window.__nebula.syncState()`);
    ok(stateAfterBreak.status === 'error', `演练6：远端 JSON 坏掉时状态是 error（${stateAfterBreak.detail}）`);
    const localAfterBreak = await readLocalNow();
    ok(
      localAfterBreak.ideas.length === localBeforeBreak.ideas.length,
      '🔴 演练6：本地数据一条都没少（解析失败绝不能被当成"空数据"）',
      `${localBeforeBreak.ideas.length} → ${localAfterBreak.ideas.length}`,
    );

    // 恢复备份：读远端 config、把 fallbackToBackup 置 true、写回去
    const cfg = JSON.parse(await evaluate(cdp, `window.__mock.read('data/sync.config.json')`));
    cfg.fallbackToBackup = true;
    await evaluate(
      cdp,
      `window.__mock.write('data/sync.config.json', ${JSON.stringify(JSON.stringify(cfg, null, 2))})`,
    );
    await evaluate(cdp, `window.__mock.setMode('ok')`);
    await runSync(900);

    const recovered = JSON.parse(await evaluate(cdp, `window.__mock.read('data/ideas.json')`));
    ok(recovered.ideas.length > 0, `演练6：置上 fallbackToBackup 后从备份恢复（${recovered.ideas.length} 条）`);
    const cfgAfter = JSON.parse(await evaluate(cdp, `window.__mock.read('data/sync.config.json')`));
    ok(cfgAfter.fallbackToBackup === false, '演练6：回退后 flag 被自动清掉（不需要重新部署代码）');

    // ── 演练 7：凭据无效 ⇒ 停止重试 ──
    await evaluate(cdp, `window.__mock.setMode('auth')`);
    await evaluate(cdp, `window.__nebula.syncDirty()`);
    await runSync(600);
    const authState = await evaluate(cdp, `window.__nebula.syncState()`);
    ok(authState.status === 'error' && /凭据/.test(authState.detail), `演练7：凭据无效时明确报错（${authState.detail}）`);
    ok(authState.dirty === false, '演练7：凭据无效时清掉 dirty（不会无脑反复重试注定失败的请求）');

    // ── 演练 8：离线 ⇒ 录入照常；恢复后能推上去 ──
    await evaluate(cdp, `window.__mock.setMode('network')`);
    await typeAndEnter(cdp, '断网时记下的想法');
    const offlineDoc = await readLocalNow();
    ok(
      offlineDoc.ideas.some((i) => i.text === '断网时记下的想法'),
      '演练8：断网时录入照常成功（本地先成功，网络后同步）',
    );
    await evaluate(cdp, `window.__nebula.syncDirty()`);
    await runSync(600);
    ok(
      (await evaluate(cdp, `window.__nebula.syncState()`)).status === 'error',
      '演练8：离线时同步报错但界面不卡',
    );

    await evaluate(cdp, `window.__mock.setMode('ok')`);
    await runSync(900);
    const afterOnline = JSON.parse(await evaluate(cdp, `window.__mock.read('data/ideas.json')`));
    ok(
      afterOnline.ideas.some((i) => i.text === '断网时记下的想法'),
      '演练8：恢复网络后自动补推成功',
    );

    // ── 演练 5：灾难恢复（清空本地 + 重载 + 同步）──
    const expectedCount = afterOnline.ideas.length;
    await evaluate(cdp, `indexedDB.deleteDatabase('nebula')`);
    await sleep(400);
    await cdp.send('Page.reload', { ignoreCache: true });
    await sleep(500);
    await waitUntil(cdp, `document.readyState === 'complete' && !!window.__nebula`, 10000);
    await sleep(400);

    const wipedDoc = await readLocalNow();
    ok(wipedDoc.ideas.length === 0, `演练5：本地已经清空（${wipedDoc.ideas.length} 条）`);

    await installMockRemote();
    await runSync(1200);
    const restoredDoc = await readLocalNow();
    ok(
      restoredDoc.ideas.length >= expectedCount,
      `🔴 演练5：清空本地后从备份完整恢复（${restoredDoc.ideas.length} 条，期望 ≥ ${expectedCount}）`,
    );

    console.log('\n── 多用户演练（每人一个账号、一个私有仓库） ──');

    // 演练10：粘贴 token 之后全自动（认人 + 建仓 + 首次同步）
    await evaluate(cdp, `window.__nebula.setRemoteFactory(() => window.__mock.store)`);
    await evaluate(cdp, `window.__mock.reset()`);
    await evaluate(cdp, `window.__nebula.wipeLocal()`);
    await sleep(300);

    await evaluate(cdp, `window.__mock.setAccount('alice')`);
    await evaluate(cdp, `window.__nebula.connectWithToken('ghp_fake_token')`);
    await sleep(1500);

    ok(
      (await evaluate(cdp, `window.__nebula.ownerHandle()`)) === 'alice',
      '演练10：粘贴 token 后自动识别账号（不用手填 owner）',
      String(await evaluate(cdp, `window.__nebula.ownerHandle()`)),
    );
    ok(
      await evaluate(cdp, `window.__mock.read('data/sync.config.json') !== null`),
      '演练10：自动创建了私有数据仓库并写入 config（不用先手动建仓）',
    );

    // 在 alice 的账号下记两条
    await typeAndEnter(cdp, 'alice 的第一条想法');
    await typeAndEnter(cdp, 'alice 的第二条想法');
    await evaluate(cdp, `window.__nebula.syncDirty()`);
    await runSync(1000);
    const aliceRemote = JSON.parse(await evaluate(cdp, `window.__mock.read('data/ideas.json')`));
    ok(aliceRemote.ideas.length === 2, `演练10：alice 的 2 条已经备份（${aliceRemote.ideas.length} 条）`);

    // ── 🔴 演练11：同一台电脑换一个人登录 ──
    await evaluate(cdp, `window.__mock.reset()`);
    await evaluate(cdp, `window.__nebula.setAccount('bob')`);
    await evaluate(cdp, `window.__nebula.syncDirty()`);
    await runSync(800);

    const guardState = await evaluate(cdp, `window.__nebula.syncState()`);
    ok(
      guardState.status === 'error' && /另一个账号|属于/.test(guardState.detail),
      `🔴 演练11：换账号后同步被拦下（${guardState.detail}）`,
    );
    const leaked = await evaluate(cdp, `window.__mock.read('data/ideas.json')`);
    ok(
      leaked === null,
      '🔴 演练11：alice 的想法一条都没被推到 bob 的仓库（跨账号泄漏已堵住）',
      String(leaked).slice(0, 120),
    );
    const localStill = await readLocalNow();
    ok(
      localStill.ideas.length === 2,
      '演练11：本地数据完好，没有被清掉（拦下是"不动"，不是"删掉"）',
      String(localStill.ideas.length),
    );

    // ── 演练12：用户确认切换 ⇒ 清空本机后正常归属新账号 ──
    await evaluate(cdp, `window.__nebula.wipeLocal()`);
    await sleep(300);
    await evaluate(cdp, `window.__nebula.syncNow(true)`);
    await sleep(1200);
    const afterSwitch = await evaluate(cdp, `window.__nebula.ownerHandle()`);
    ok(afterSwitch === 'bob', `演练12：清空本机后正常归属到新账号（@${afterSwitch}）`);
    ok(
      (await readLocalNow()).ideas.length === 0,
      '演练12：新账号从零开始（alice 的数据不在本机了，但在她的备份里）',
    );

    console.log('\n── 演练13：重开页面不用再登录 ──');

    // 先在 bob 的账号下同步一次，让凭据真正落盘
    await typeAndEnter(cdp, 'bob 的一条想法');
    await evaluate(cdp, `window.__nebula.syncDirty()`);
    await runSync(1000);
    ok(
      (await evaluate(cdp, `window.__nebula.syncState()`)).everPushed === true,
      '演练13：已经成功备份过（退出登录时才敢说"数据能取回"）',
    );

    // 🔴 把真实 GitHub 域名挡掉：重载后应用会尝试自动连远端，
    //    我们不希望测试去打真实网络（假 token 会挂 12 秒）
    await cdp.send('Network.enable');
    await cdp.send('Network.setBlockedURLs', { urls: ['https://api.github.com/*'] });

    await cdp.send('Page.reload', { ignoreCache: true });
    await sleep(500);
    await waitUntil(cdp, `document.readyState === 'complete' && !!window.__nebula`, 10000);
    await sleep(1200);

    ok(
      (await evaluate(cdp, `window.__nebula.isLoggedIn()`)) === true,
      '🔴 演练13：重载后**没有输入任何东西**就已经是登录状态（凭据留在本机且能解开）',
    );

    await cdp.send('Network.setBlockedURLs', { urls: [] });

    // 接回模拟远端，确认自动登录拿到的是**能用的**凭据
    await installMockRemote();
    await runSync(1200);
    const resumed = JSON.parse(await evaluate(cdp, `window.__mock.read('data/ideas.json')`));
    ok(
      resumed.ideas.some((i) => i.text === 'bob 的一条想法'),
      '演练13：自动登录拿到的凭据真的能用（数据继续同步）',
    );

    // 退出登录之后就不该再自动登录了
    ok(
      typeof (await evaluate(cdp, `typeof window.__nebula.logout`)) === 'string',
      '演练13：有明确的退出登录入口',
    );
    await runStage7(cdp);
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

async function runStage7(cdp) {
  console.log('\n── 阶段7：触屏、键盘与性能分档 ──');
  // The entire smoke run owns a mkdtemp profile. No regular browser data is touched.
  await cdp.send('Storage.clearDataForOrigin', {origin: new globalThis.URL(URL_BASE).origin, storageTypes: 'all'});
  await cdp.send('Emulation.setDeviceMetricsOverride', {width: 390, height: 844, deviceScaleFactor: 1, mobile: true});
  await cdp.send('Emulation.setTouchEmulationEnabled', {enabled: true, maxTouchPoints: 5});
  await cdp.send('Page.navigate', {url: URL_BASE});
  await sleep(500);
  ok(await waitUntil(cdp, '!!window.__nebula && document.readyState === "complete"'), '手机尺寸正常启动');
  await tap(cdp, '#tools-toggle');
  ok(await evaluate(cdp, `document.querySelector('#tools-toggle').getAttribute('aria-expanded') === 'true' && !document.querySelector('#tools-panel').hidden`), '手机真实点击展开工具');
  await screenshot(cdp, 'mobile-tools');
  await tap(cdp, '#sync-bar');
  ok(await evaluate(cdp, `!document.querySelector('#sync-layer').hidden && document.querySelector('#tools-panel').hidden`), '手机备份入口打开设置，同时收起工具');
  await screenshot(cdp, 'mobile-settings');
  await tap(cdp, '#sync-close');
  await tap(cdp, '#tools-toggle');
  await cdp.send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'Escape', windowsVirtualKeyCode: 27});
  ok(await evaluate(cdp, `document.querySelector('#tools-panel').hidden && document.querySelector('#tools-toggle').getAttribute('aria-expanded') === 'false'`), 'Escape 收起工具，不留下透明遮罩');
  await settle(cdp);
  const mapViewport = await evaluate(cdp, 'window.__nebula.viewport()');
  await tap(cdp, '.bubble--heart');
  await tap(cdp, '.space-chip-rename');
  const mobileName = await evaluate(cdp, 'window.__nebula.current().name');
  await cdp.send('Input.insertText', {text: '手机空间'});
  await evaluate(cdp, `window.__renameVv = Object.getOwnPropertyDescriptor(visualViewport, 'height'); Object.defineProperty(visualViewport, 'height', {configurable:true, value:innerHeight - 300}); visualViewport.dispatchEvent(new Event('resize'))`);
  await sleep(150);
  ok(await evaluate(cdp, `document.querySelector('.space-chip-input').getBoundingClientRect().bottom <= visualViewport.height`), '模拟键盘弹起时，星图中的改名框仍在可视区域');
  await evaluate(cdp, `delete visualViewport.height; if (window.__renameVv) Object.defineProperty(visualViewport, 'height', window.__renameVv); delete window.__renameVv; visualViewport.dispatchEvent(new Event('resize'))`);
  await cdp.send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 229, isComposing: true});
  ok(await evaluate(cdp, `!!document.querySelector('.space-chip-input') && window.__nebula.current().name === ${JSON.stringify(mobileName)}`), '改名输入法组字时 Enter 不提前提交');
  await tap(cdp, '.space-edit .btn');
  ok(await waitUntil(cdp, `window.__nebula.current().name === '手机空间'`), '手机无需双击，点击改名与保存即可持久化');
  await screenshot(cdp, 'mobile-spaces');
  await tap(cdp, '#space-close');
  ok(await evaluate(cdp, `(() => { const view = window.__nebula.viewport(), stage = document.querySelector('#stage'); return view.tx === ${mapViewport.tx} && view.ty === ${mapViewport.ty} && view.scale === ${mapViewport.scale} && stage.scrollLeft === 0 && stage.scrollTop === 0; })()`), '星图返回不改变想法视口，也不因焦点滚动偏移画布');
  await evaluate(cdp, `window.__nebula.renameSpace(window.__nebula.current().id, ${JSON.stringify(mobileName)})`);
  ok(await evaluate(cdp, `document.documentElement.scrollWidth === innerWidth`), '手机页面没有横向溢出');
  await typeAndEnter(cdp, '触屏验证');
  await screenshot(cdp, 'mobile');
  await settle(cdp);
  await evaluate(cdp, 'window.__nebula.fitAll(); document.activeElement.blur()');
  const target = await centerOf(cdp, '.bubble--idea:not(.bubble--shadow)');
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', {type, touchPoints: points.map((p,i) => ({...p, id: i+1, radiusX: 2, radiusY: 2}))});
  const at = {x: target.x, y: target.y};
  await touch('touchStart', [at]);
  await touch('touchMove', [{x: at.x + 30, y: at.y + 20}]);
  ok(await evaluate(cdp, 'window.__nebula.isDragging()'), '真实触屏移动进入泡泡拖拽');
  const before = await evaluate(cdp, 'window.__nebula.viewport()');
  const a = {x: at.x + 30, y: at.y + 20}, b = {x: at.x + 90, y: at.y + 20};
  await touch('touchStart', [a,b]);
  ok(!(await evaluate(cdp, 'window.__nebula.isDragging()')), '第二指落下取消单指拖拽');
  await touch('touchMove', [{x: a.x - 15, y: a.y}, {x: b.x + 15, y: b.y}]);
  const after = await evaluate(cdp, 'window.__nebula.viewport()');
  ok(after.scale > before.scale, '真实双指分开使星云放大');
  ok(Math.abs((await evaluate(cdp, 'visualViewport.scale')) - 1) < .01, '捏合没有缩放浏览器页面');
  await touch('touchEnd', []);
  ok(!(await evaluate(cdp, 'window.__nebula.isZoomed()')), '捏合结束不误开阅读放大');
  ok((await evaluate(cdp, 'window.scrollY')) === 0, '触屏拖拽和捏合没有滚动页面');
  ok((await evaluate(cdp, 'getComputedStyle(document.querySelector(".input")).touchAction')).includes('pan-y'), '输入框保留原生纵向滚动');
  await settle(cdp);

  const keyboard = await evaluate(cdp, `(() => {
    const vv = visualViewport, dock = document.querySelector('.dock');
    document.querySelector('#input').focus();
    const baseline = dock.getBoundingClientRect().bottom;
    Object.defineProperty(vv, 'height', {configurable: true, value: innerHeight - 250});
    Object.defineProperty(vv, 'offsetTop', {configurable: true, value: 40});
    vv.dispatchEvent(new Event('resize'));
    const shift = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--kb'));
    const bottom = dock.getBoundingClientRect().bottom;
    const expected = Math.max(0, baseline - vv.height - vv.offsetTop);
    document.body.style.height = (innerHeight - 250) + 'px';
    vv.dispatchEvent(new Event('resize'));
    const shrunk = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--kb'));
    document.body.style.height = '';
    delete vv.height; delete vv.offsetTop;
    document.activeElement.blur(); vv.dispatchEvent(new Event('resize'));
    return {shift, expected, bottom, visualBottom: innerHeight - 210, shrunk,
      restored: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--kb'))};
  })()`);
  ok(Math.abs(keyboard.shift - keyboard.expected) < 1 && keyboard.shift > 0, 'visualViewport resize 实际驱动 --kb（模拟键盘，非 Safari 真机）');
  ok(keyboard.bottom <= keyboard.visualBottom + 1, '底栏移动到可视区内');
  ok(keyboard.shrunk === 0, '布局已缩小时不会重复补偿键盘高度');
  ok(keyboard.restored === 0, '键盘收起后底栏恢复');
  await evaluate(cdp, `(() => { const el=document.querySelector('#input'); el.value='可滚动的正文\\n'.repeat(40); el.dispatchEvent(new Event('input')); el.scrollTop=0; el.blur(); })()`);
  const scrollAt = await evaluate(cdp, `(() => { const r=document.querySelector('#input').getBoundingClientRect(); return {x:r.left+30, y:r.bottom-20}; })()`);
  await touch('touchStart', [scrollAt]);
  for (let n=1;n<=4;n++) { await touch('touchMove', [{x:scrollAt.x,y:scrollAt.y-n*15}]); await sleep(30); }
  await touch('touchEnd', []);
  await sleep(150);
  ok((await evaluate(cdp, 'document.querySelector("#input").scrollTop')) > 0, '真实触屏仍能滚动多行输入框');
  await evaluate(cdp, 'const el=document.querySelector("#input"); el.value=""; el.dispatchEvent(new Event("input"))');

  await cdp.send('Emulation.setDeviceMetricsOverride', {width: 1024, height: 800, deviceScaleFactor: 1, mobile: false});
  await cdp.send('Emulation.setTouchEmulationEnabled', {enabled: false});
  const seed = n => evaluate(cdp, `(${seedStress.toString()})(${n})`);
  // Existing touch fixture is archived, not deleted, to get exact active-space counts.
  await evaluate(cdp, `(async () => { const a=window.__nebula; for (const i of await a.listIdeas()) await a.store.putIdea({...i, archived:1}); })()`);
  const full = await seed(300);
  ok(full.renderTier === 'full' && full.rendered === 300, '300 个想法全开且全部渲染');
  const light = await seed(800);
  ok(light.renderTier === 'light' && light.rendered === 800, '800 个想法进入轻量档但不裁剪');
  ok((await evaluate(cdp, 'getComputedStyle(document.querySelector(".bubble--idea .bubble-label")).fontSize')) === '12px', '轻量档字号从 13px 降到 12px');
  await typeAndEnter(cdp, '轻量档录入');
  ok((await evaluate(cdp, 'document.querySelectorAll(".ripple").length')) === 0, '轻量档录入不生成涟漪');
  const culled = await evaluate(cdp, 'window.__nebula.performance()');
  ok(culled.ideas === 801 && culled.rendered === 300, '第 801 条落定后切到最大 300 个');
  ok((await evaluate(cdp, 'window.__nebula.field.activeBodies.length')) === 802, 'DOM 裁剪保留全部 801 个物理节点和心泡泡');
  ok(!(await evaluate(cdp, '!!document.querySelector("[data-id=stress-00000]")')), '小泡泡探针原本未渲染');
  const baseIds = await evaluate(cdp, 'Array.from(document.querySelectorAll("#world .bubble--idea"), e => e.dataset.id).sort()');
  await evaluate(cdp, 'const s=document.querySelector("#search"); s.value="觅"; s.dispatchEvent(new Event("input", {bubbles:true}))');
  await sleep(250);
  ok((await evaluate(cdp, 'window.__nebula.searchState().hits')) === 1, '裁剪后仍搜索全部数据，找到唯一隐藏命中');
  ok((await evaluate(cdp, 'window.__nebula.performance().rendered')) === 301, '隐藏命中补入 DOM');
  const searchedIds = await evaluate(cdp, 'Array.from(document.querySelectorAll("#world .bubble--idea"), e => e.dataset.id)');
  ok(baseIds.every(id => searchedIds.includes(id)), '搜索保留全部 300 个基础泡泡');
  await evaluate(cdp, 'window.__nebula.clearSearch()');
  ok(JSON.stringify(await evaluate(cdp, 'Array.from(document.querySelectorAll("#world .bubble--idea"), e => e.dataset.id).sort()')) === JSON.stringify(baseIds), '清空搜索只移除额外命中，恢复相同底图');
  ok((await evaluate(cdp, 'window.__nebula.listIdeas().then(l=>l.filter(i=>i.archived===0).length)')) === 801, '裁剪和搜索不删除本地数据');

  await cdp.send('Emulation.setEmulatedMedia', {features: [{name: 'prefers-reduced-motion', value: 'reduce'}]});
  await sleep(50);
  await typeAndEnter(cdp, '减少动态验证');
  ok((await evaluate(cdp, 'window.__nebula.lastFlight().mode')) === 'fade', '系统减少动态效果时飞入改为淡入');
  const fade = await evaluate(cdp, 'window.__nebula.lastFlight()');
  ok(Math.hypot(fade.shadowEnd.x - fade.to.x, fade.shadowEnd.y - fade.to.y) < 3, '淡入在终点原位发生，影子交接不跳');
  ok((await evaluate(cdp, 'document.querySelectorAll(".ripple").length')) === 0, '减少动态效果不产生涟漪');
  await settle(cdp, 20000);
  await evaluate(cdp, 'window.__nebula.field.wake(.01)');
  ok((await evaluate(cdp, 'window.__nebula.field.tier()')) === 'asleep', '减少动态效果时禁止余温档弱唤醒');
  await cdp.send('Input.dispatchKeyEvent', {type:'keyDown', key:'F2', code:'F2', windowsVirtualKeyCode:113});
  await sleep(700);
  ok((await evaluate(cdp, 'document.querySelector(".performance-panel").textContent')).includes('fps'), 'F2 打开面板并更新实测 rAF 帧率');
  await cdp.send('Input.dispatchKeyEvent', {type:'keyUp', key:'F2', code:'F2', windowsVirtualKeyCode:113});
  await cdp.send('Input.dispatchKeyEvent', {type:'keyDown', key:'F2', code:'F2', windowsVirtualKeyCode:113});
  ok(await evaluate(cdp, 'document.querySelector(".performance-panel").hidden'), 'F2 再按一次关闭面板');
  const unsafe = await evaluate(cdp, `Array.from(document.querySelectorAll('.bubble')).some(el => {
    const s=getComputedStyle(el); return s.willChange !== 'auto' || s.filter !== 'none' || s.backdropFilter !== 'none';
  })`);
  ok(!unsafe, '泡泡没有常驻 will-change、filter 或 backdrop-filter');
}

main().catch((err) => {
  console.error(`\n冒烟测试无法完成：${err.message}`);
  console.error('请确认已另开终端运行 `npm run serve`，且 8000 端口可访问。');
  process.exitCode = 1;
});
