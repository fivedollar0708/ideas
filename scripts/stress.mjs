#!/usr/bin/env node
/** node scripts/stress.mjs 800 [--visible]; fresh Chrome profile, no dependencies or credentials. */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { seedStress } from './stress-data.mjs';

const counts = (process.argv[2] ?? '300,800,801').split(',').map(Number);
if (counts.some(n => !Number.isInteger(n) || n < 1 || n > 10000)) throw new Error('数量必须是 1–10000 的整数');
const visible = process.argv.includes('--visible');
const mobile = process.argv.includes('--mobile');
const url = process.env.SMOKE_URL ?? 'http://127.0.0.1:8000';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(url)) throw new Error('压测仅连接本地开发站点');
const chrome = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
let port = Number(process.env.CDP_PORT ?? 0);
const profile = mkdtempSync(join(tmpdir(), 'nebula-stress-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const child = spawn(chrome, [
  ...(visible ? [] : ['--headless=new']), '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, url,
], {stdio: 'ignore'});
let ws;
try {
  let page;
  for (let n = 0; n < 100; n++) {
    try {
      if (!port) port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
      page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(p => p.type === 'page');
    } catch {}
    if (page) break;
    await sleep(100);
  }
  if (!page) throw new Error('Chrome 调试端口没有启动');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r, {once: true}); ws.addEventListener('error', j, {once: true}); });
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (!m.id) return;
    const task = pending.get(m.id);
    if (!task) return;
    clearTimeout(task.timer);
    pending.delete(m.id);
    m.error ? task.reject(new Error(m.error.message)) : task.resolve(m.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} 超时`)); }, 60000);
    pending.set(id, {resolve, reject, timer});
    ws.send(JSON.stringify({id, method, params}));
  });
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const wait = async expression => {
    for (let n = 0; n < 300; n++) { if (await evaluate(expression)) return; await sleep(100); }
    throw new Error(`等待超时: ${expression}`);
  };
  await send('Emulation.setDeviceMetricsOverride', {width: mobile ? 390 : 1024, height: mobile ? 844 : 800, deviceScaleFactor: 1, mobile});
  if (mobile) await send('Emulation.setTouchEmulationEnabled', {enabled: true, maxTouchPoints: 5});
  const results = [];
  console.log('隔离 Chrome profile:', profile);
  console.log('CPU:', (await import('node:os')).cpus()[0]?.model);
  console.log('Chrome:', (await send('Browser.getVersion')).product, 'headless:', !visible, 'mobile viewport emulation:', mobile);
  async function sample(mode) {
    return evaluate(`(async () => {
      const api = window.__nebula;
      const tierCounts = {full: 0, eco: 0, asleep: 0};
      const dt = [], steps = [], longTasks = [];
      const observer = new PerformanceObserver(list => longTasks.push(...list.getEntries().map(e => e.duration)));
      observer.observe({entryTypes: ['longtask']});
      const original = api.field.step;
      api.field.step = function() { const t = performance.now(); original.call(this); steps.push(performance.now() - t); };
      const world = document.querySelector('#world');
      const saved = world.style.transform;
      const from = performance.now(); let previous = null;
      if (${JSON.stringify(mode)} === 'active') api.field.wake(0.6);
      // Refresh starts the actual App loop. The active sample is taken immediately after it.
      await new Promise(resolve => {
        function frame(t) {
          if (previous !== null) dt.push(t - previous);
          previous = t;
          tierCounts[api.field.tier()]++;
          if (${JSON.stringify(mode)} === 'pan') world.style.transform = saved + ' translateX(' + (Math.sin(t / 500) * 80) + 'px)';
          if (t - from < 3000) requestAnimationFrame(frame); else resolve();
        }
        requestAnimationFrame(frame);
      });
      api.field.step = original;
      world.style.transform = saved;
      await new Promise(r => setTimeout(r, 0)); observer.disconnect();
      const sorted = [...dt].sort((a,b) => a-b), sortedSteps = [...steps].sort((a,b) => a-b);
      const percentile = (values,p) => values[Math.min(values.length-1, Math.floor(values.length*p))] ?? 0;
      return {
        mode: ${JSON.stringify(mode)}, frames: dt.length,
        fps: dt.length * 1000 / dt.reduce((a,b) => a+b, 0),
        p95Ms: percentile(sorted,.95), maxMs: Math.max(0,...dt),
        over33Ms: dt.filter(t => t > 33.4).length, over50Ms: dt.filter(t => t > 50).length,
        forceSteps: steps.length, forceP95Ms: percentile(sortedSteps,.95),
        longTasks: longTasks.length, longestTaskMs: Math.max(0,...longTasks), tierCounts,
      };
    })()`);
  }
  for (const count of counts) {
    // Only this newly created profile is cleared. Never target a user's regular Chrome.
    await send('Storage.clearDataForOrigin', {origin: new URL(url).origin, storageTypes: 'all'});
    await send('Page.navigate', {url});
    await sleep(300);
    await wait('!!window.__nebula && document.readyState === "complete"');
    const snapshot = await evaluate(`(${seedStress.toString()})(${count})`);
    const active = await sample('active');
    await wait('window.__nebula.field.tier() === "asleep"');
    const pan = await sample('pan');
    results.push({count, ...snapshot, active, pan});
    console.log(JSON.stringify(results.at(-1), null, 2));
  }
  if (process.env.STRESS_REPORT) writeFileSync(resolve(process.env.STRESS_REPORT), JSON.stringify(results, null, 2));
  if (process.env.STRESS_SCREENSHOT) {
    await send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'F2', code: 'F2', windowsVirtualKeyCode: 113});
    await sleep(600);
    const shot = await send('Page.captureScreenshot', {format: 'png'});
    writeFileSync(resolve(process.env.STRESS_SCREENSHOT), Buffer.from(shot.data, 'base64'));
  }
  if (visible) {
    console.log('已灌数据。按 F2 看面板；测试数据不会进入你的常用浏览器。按 Enter 关闭测试窗口。');
    await new Promise(r => {process.stdin.resume(); process.stdin.once('data', r);});
    process.stdin.pause();
  }
} finally {
  ws?.close(); child.kill();
  await sleep(500);
  // profile is an absolute mkdtemp result beneath the explicitly named OS temp directory.
  if (resolve(profile).startsWith(resolve(tmpdir()) + '\\') || resolve(profile).startsWith(resolve(tmpdir()) + '/')) {
    try { rmSync(profile, {recursive: true, force: true}); } catch {}
  }
}
