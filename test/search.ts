/**
 * search.ts 的纯函数测试。
 *
 * 只测能脱离浏览器跑的部分：文本分段、节点复用计划、命中排序、跳转步进。
 * 真正的输入框链路（debounce、输入法守卫、Enter 跳转、DOM 落到实处）
 * 由 `npm run smoke` 用真 Chrome 验。
 *
 * 为什么这四条值得单独钉住：
 *  · 分段算错 ⇒ 高亮标在错的位置（用户一眼就能看出，但很难定位是哪个字符算错了）
 *  · 复用计划算错 ⇒ 要么每次都重建 DOM（闪），要么该改的没改（高亮不更新）
 *  · 排序不稳定 ⇒ 同分的几条每次输入都换位置，按 Enter 跳转的次序不可预期
 *  · 步进算错 ⇒ Enter 跳转会卡住或跳过
 */

import { eq, eqJson, ok, section } from './assert';
import {
  countLabel,
  otherSpaceHint,
  planReconcile,
  pulseKeyframes,
  rankMatches,
  splitByQuery,
  stepIndex,
  type NodeShape,
  type Segment,
} from '../src/ui/search';

/** 把分段压成好断言的形状。 */
function compact(segments: readonly Segment[]): string {
  return segments.map((s) => (s.hit ? `[${s.text}]` : s.text)).join('');
}

/** 把分段还原成原文（用来验证"分段不丢字"）。 */
function flatten(segments: readonly Segment[]): string {
  return segments.map((s) => s.text).join('');
}

export function runSearchTests(): void {
  section('search · 文本分段');

  eqJson(splitByQuery('', '水'), [{ text: '', hit: false }], '空文本 → 一个未命中段');
  eqJson(splitByQuery('水', ''), [{ text: '水', hit: false }], '空查询 → 一个未命中段');
  eqJson(splitByQuery('水', 'x'), [{ text: '水', hit: false }], '不命中 → 一个未命中段');

  eq(compact(splitByQuery('凌晨三点', '凌晨')), '[凌晨]三点', '前缀命中');
  eq(compact(splitByQuery('凌晨三点', '三点')), '凌晨[三点]', '后缀命中');
  eq(compact(splitByQuery('凌晨三点的城市', '三点')), '凌晨[三点]的城市', '中间命中');
  eq(compact(splitByQuery('水', '水')), '[水]', '完全相等');

  eq(
    compact(splitByQuery('三点三点三点', '三点')),
    '[三点][三点][三点]',
    '多次命中全部标出（不重叠）',
  );
  eq(compact(splitByQuery('aaa', 'aa')), '[aa]a', '不重叠扫描（标准 indexOf 行为）');

  eq(compact(splitByQuery('Hello World', 'hello')), '[Hello] World', '拉丁字母大小写不敏感');

  // 换行与空格不能被吃掉
  eq(flatten(splitByQuery('凌晨\n三点', '三点')), '凌晨\n三点', '分段不丢字符（含换行）');

  section('search · 字符集退化（打错顺序也要能标出来）');

  // 搜"三凌"时整串找不到，scoreMatch 会走字符集重叠那条路给出分数。
  // 如果这时一个 <mark> 都不画，用户会看到"边框亮了但文字没高亮"，以为坏了。
  const charset = splitByQuery('凌晨三点', '三凌');
  eq(compact(charset), '[凌]晨[三]点', '整串找不到时，退化成逐字标出查询里的字');
  eq(flatten(charset), '凌晨三点', '退化后也不丢字符');
  ok(
    charset.some((s) => s.hit),
    '确实产生了高亮段（否则会出现"算命中却没有高亮"的怪现象）',
  );

  // 相邻的命中字会合并成一个 <mark>（而不是一个字一个 <mark>）—— 视觉上更整
  eq(
    compact(splitByQuery('凌晨三点', '三三点')),
    '凌晨[三点]',
    '相邻的命中字合并成一段；查询里重复的字只算一次',
  );

  section('search · 节点复用计划（避免闪烁）');

  const shapes = (...items: Array<[string, string]>): NodeShape[] =>
    items.map(([tag, text]) => ({ tag, text }));

  eqJson(
    planReconcile(shapes(['#text', '凌晨'], ['MARK', '三点']), splitByQuery('凌晨三点', '三点')),
    [true, true],
    '形状完全相同 ⇒ 全部复用（一个字都没动过 DOM）',
  );

  eqJson(
    planReconcile(shapes(['#text', '凌晨']), splitByQuery('凌晨三点', '三点')),
    [true, false],
    '第一段形状相同就复用、第二段需要新建',
  );

  eqJson(
    planReconcile(
      shapes(['#text', '凌晨'], ['MARK', '三点'], ['#text', '多余']),
      splitByQuery('凌晨三点', '三点'),
    ),
    [true, true],
    '尾部多出来的节点不在计划里（由调用方负责删）',
  );

  eqJson(
    planReconcile([], splitByQuery('凌晨三点', '三点')),
    [false, false],
    '还没有任何节点 ⇒ 全部需要新建',
  );

  eqJson(
    planReconcile(shapes(['MARK', '凌晨']), [{ text: '凌晨', hit: false }]),
    [false],
    '标签不同（mark vs text）⇒ 必须替换',
  );

  // 关键场景：用户又打了一个字，前面几段不该被重建
  const before = shapes(['#text', '凌晨'], ['MARK', '三点']);
  const afterSegments = splitByQuery('凌晨三点的城市', '三点');
  const plan = planReconcile(before, afterSegments);
  eqJson(plan, [true, true, false], '查询词加长时，前两段仍复用，只新增尾部');

  section('search · 命中排序');

  eqJson(rankMatches([{ id: 'a', text: '水' }], ''), [], '空查询 → 没有命中');
  eqJson(
    rankMatches([{ id: 'a', text: '毫不相干' }], '水'),
    [],
    '不命中 → 被排除出命中列表（但泡泡不会被移走，那由渲染层保证）',
  );

  const ranked = rankMatches(
    [
      { id: 'mid', text: '凌晨的水' },
      { id: 'exact', text: '水' },
      { id: 'prefix', text: '水泥路' },
      { id: 'none', text: '无关内容' },
    ],
    '水',
  );
  eqJson(
    ranked.map((r) => r.id),
    ['exact', 'prefix', 'mid'],
    '按分数排：完全相等 > 前缀 > 子串',
  );

  const scores = ranked.map((r) => r.score);
  ok(scores[0] > scores[1] && scores[1] > scores[2], `分数严格递减（${scores.join(' > ')}）`);

  // 排序必须稳定：同分的保持传入顺序，否则每次输入次序都变，Enter 跳转不可预期
  const sameScore = rankMatches(
    [
      { id: 'first', text: '凌晨三点' },
      { id: 'second', text: '凌晨三点' },
      { id: 'third', text: '凌晨三点' },
    ],
    '凌晨三点',
  );
  eqJson(
    sameScore.map((r) => r.id),
    ['first', 'second', 'third'],
    '同分的保持传入顺序（排序稳定）',
  );

  section('search · Enter 跳转步进');

  eq(stepIndex(-1, 0, false), -1, '没有命中时返回 -1');
  eq(stepIndex(-1, 3, false), 0, '还没跳过 ⇒ 向后从最好的那条（序号 0）开始');
  eq(stepIndex(-1, 3, true), 2, '还没跳过 ⇒ 向前从最后一条开始');
  eq(stepIndex(0, 3, false), 1, '向后步进');
  eq(stepIndex(1, 3, true), 0, '向前步进');
  eq(stepIndex(2, 3, false), 0, '向后到底后循环回第一条');
  eq(stepIndex(0, 3, true), 2, '向前到头后循环到最后一条');
  eq(stepIndex(0, 1, false), 0, '只有一条命中时始终停在它上面');

  section('search · 文案与脉冲');

  eq(countLabel(12, '三点'), '⌕ 12 条', '计数文案');
  eq(countLabel(0, ''), '', '没有查询词时不显示计数');
  eq(otherSpaceHint('深海', 7), '其他空间还有 7 条命中 · 去「深海」看看', '跨空间提示文案');

  const pulse = pulseKeyframes();
  eq(pulse.length, 3, '脉冲三帧');
  ok(String(pulse[1].transform).includes('1.14'), '中间帧放大到 1.14');
  eq(String(pulse[0].transform), String(pulse[2].transform), '起止状态一致（脉冲回到原样）');
}
