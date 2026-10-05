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
