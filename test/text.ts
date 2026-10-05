/**
 * text.ts 的测试。
 *
 * 只测纯函数部分（norm / clampText / ellipseFromMeasurement / scoreMatch）。
 * measureText 与 radiusOf 需要 canvas，只能在浏览器里验 —— 这也是当初把
 * 排版数学抽成纯函数的原因：最需要回归的部分不依赖浏览器。
 */

import { close, eq, eqJson, ok, section } from './assert';
import { clampText, ellipseFromMeasurement, MAX_RADIUS, MIN_RADIUS, norm, scoreMatch, type Measured } from '../src/text';

/** 造一个测量结果，省去手写 lines。 */
function measured(w: number, h: number, lineCount = 1): Measured {
  return { w, h, lines: new Array<string>(lineCount).fill('例') };
}

export function runTextTests(): void {
  section('text · norm');

  eq(norm('a\r\nb'), 'a\nb', 'CRLF 统一成 LF');
  eq(norm('  hi  '), 'hi', '去掉首尾空白');
  eq(norm('a\n\n\n\nb'), 'a\n\nb', '连续空行压成一行空行');
  eq(norm('\n\n x \n\n'), 'x', '纯空白输入归零');
  eq(norm('a  \nb'), 'a\nb', '去掉行尾空白');

  section('text · clampText');

  eqJson(clampText('abc', 5), { text: 'abc', clipped: false }, '未超限不截断');
  eqJson(clampText('', 5), { text: '', clipped: false }, '空串原样返回');
  eqJson(clampText('abcdef', 5), { text: 'abcd…', clipped: true }, '超限截断并加省略号');
  eq(clampText('abcdef', 5).text.length, 5, '截断后长度不超过上限');

  // 🔴 代理对保护：不能把 emoji 从中间劈开，留下孤立的高代理字符
  const emoji = clampText('😀😀😀', 4);
  eq(emoji.text, '😀…', '截断不劈开 emoji 的代理对');
  ok(!/[\uD800-\uDBFF]$/.test(emoji.text), '截断结果末尾不是孤立的高代理字符');

  section('text · ellipseFromMeasurement · 形状规则');

  // 单字：强制正圆
  const one = ellipseFromMeasurement(measured(13, 19), 1);
  eq(one.rx, one.ry, '单字 → 正圆（rx === ry）');
  close(one.rx, 27.36, 0.01, '单字半径 27.36（回归锚点）');

  // 4 字单行：仍走正圆分支
  const four = ellipseFromMeasurement(measured(52, 19), 4);
  eq(four.rx, four.ry, '4 字单行 → 正圆');
  close(four.rx, 46.08, 0.01, '4 字半径 46.08（回归锚点）');

  // 5 字单行：跨出正圆分支，变成椭圆
  const five = ellipseFromMeasurement(measured(65, 19), 5);
  ok(five.rx > five.ry, '5 字单行 → 椭圆（宽大于高）');

  // 长单行：被 MAX_RADIUS 夹住
  const long = ellipseFromMeasurement(measured(400, 19), 40);
  ok(long.rx <= MAX_RADIUS, `长文本横向不超上限（${long.rx.toFixed(1)} ≤ ${MAX_RADIUS}）`);
  ok(long.rx / long.ry <= 2 + 1e-9, '长文本比例不超过 2:1');

  // 多行：不能竖成一根柱
  const multi = ellipseFromMeasurement(measured(44, 38, 2), 6);
  ok(multi.rx / multi.ry >= 1 - 1e-9, '多行文本比例不低于 1:1');

  // 极小输入：至少 MIN_RADIUS
  const tiny = ellipseFromMeasurement(measured(1, 1), 0);
  ok(tiny.rx >= MIN_RADIUS, `极小输入仍不小于 MIN_RADIUS（${tiny.rx} ≥ ${MIN_RADIUS}）`);

  section('text · ellipseFromMeasurement · 全量性质扫描');

  let aspectOk = true;
  let boundOk = true;
  let positiveOk = true;

  for (let w = 1; w <= 400; w += 7) {
    for (let h = 1; h <= 220; h += 13) {
      for (let len = 1; len <= 40; len += 13) {
        const e = ellipseFromMeasurement(measured(w, h), len);
        const aspect = e.rx / e.ry;

        if (!(aspect >= 1 - 1e-9 && aspect <= 2 + 1e-9)) aspectOk = false;
        if (e.rx > MAX_RADIUS + 1e-9 || e.ry > MAX_RADIUS + 1e-9) boundOk = false;
        if (!(e.rx > 0 && e.ry > 0) || !Number.isFinite(e.rx) || !Number.isFinite(e.ry)) positiveOk = false;
      }
    }
  }

  ok(aspectOk, '任意测量值下，比例恒在 1:1 ~ 2:1 之间');
  ok(boundOk, '任意测量值下，半径恒不超过 MAX_RADIUS');
  ok(positiveOk, '任意测量值下，半径恒为正的有限数');

  section('text · scoreMatch · 权重梯度');

  const exact = scoreMatch('水', '水');
  const prefix = scoreMatch('水泥路', '水');
  const substring = scoreMatch('凌晨的水', '水');
  const charset = scoreMatch('凌晨三点', '三凌');

  eq(exact, 1000, '完全相等 → 1000');
  eq(prefix, 500, '前缀命中 → 500');
  ok(substring > 0 && substring < prefix, `子串命中分数低于前缀（${substring}）`);
  ok(charset > 0 && charset < substring, `字符集重叠分数最低（${charset}）`);

  // 前缀比子串高，子串比"更靠后的子串"高
  ok(scoreMatch('凌晨三点', '凌晨') > scoreMatch('凌晨三点', '三点'), '越靠前的命中分越高');

  section('text · scoreMatch · 具体场景');

  ok(scoreMatch('凌晨三点', '三点') > 0, '搜"三点"命中"凌晨三点"');
  ok(scoreMatch('凌晨三点', '三凌') > 0, '打错顺序"三凌"仍能捞出来（字符集路径）');
  ok(scoreMatch('凌晨三点', '凌晨三点') === 1000, '完全一致得满分');
  eq(scoreMatch('凌晨三点', 'xyz'), 0, '毫不相干 → 0');
  eq(scoreMatch('凌晨三点', ''), 0, '空查询 → 0');
  eq(scoreMatch('', '水'), 0, '空文本 → 0');

  // 拉丁字母大小写不敏感
  eq(scoreMatch('Hello World', 'hello'), scoreMatch('hello world', 'hello'), '大小写不敏感');
}
