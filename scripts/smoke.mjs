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

    console.log('\n── 拖拽（阶段 3） ──');

    // 回到 A 空间并等星云先静止 —— 否则"拖动前后"的对比会被星云自身的流动污染
    await evaluate(cdp, `window.__nebula.switchSpace(${JSON.stringify(spaceA)})`);
    await sleep(800);
    // 先把全部泡泡收进视野，保证后面用真实鼠标点得到它们
    await evaluate(cdp, `window.__nebula.fitAll()`);
    await sleep(300);
    await waitUntil(cdp, `window.__nebula.field.tier() === 'asleep'`, 20000);

    const targetId = await evaluate(
      cdp,
      `(() => {
        const stage = document.querySelector('#stage').getBoundingClientRect();
        const inside = Array.from(document.querySelectorAll('.bubble--idea')).find((el) => {
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
    await waitUntil(cdp, `window.__nebula.field.tier() === 'asleep'`, 20000);
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
        const el = document.querySelector('.bubble--idea');
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
