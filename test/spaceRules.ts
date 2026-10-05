/**
 * 空间命名的纯规则测试。
 *
 * 这些函数住在 store.ts 里，但**不需要数据库**（纯函数），所以能在 Node 里验。
 * 把它们单独测的理由：命名冲突是"恢复空间"这个不可逆操作里唯一容易算错的一环，
 * 而算错的后果是两个空间同名 —— 之后你就分不清该恢复哪一个了。
 */

import { eq, ok, section } from './assert';
import { nextSpaceName, pickHue, uniqueSpaceName } from '../src/store';
import type { Space } from '../src/types';

function space(hue: number): Space {
  return {
    id: `s${hue}`,
    name: 'x',
    hue,
    createdAt: 0,
    updatedAt: 0,
    deleted: 0,
    purgeAt: 0,
  };
}

export function runSpaceRulesTests(): void {
  section('空间规则 · 新建空间的默认名');

  eq(nextSpaceName(new Set()), '未命名 1', '空环境 → 未命名 1');
  eq(nextSpaceName(new Set(['未命名 1'])), '未命名 2', '已有 1 → 未命名 2');
  eq(
    nextSpaceName(new Set(['未命名 1', '未命名 2', '未命名 3'])),
    '未命名 4',
    '已有 1/2/3 → 未命名 4',
  );
  // 中间被删掉时应该补空位，而不是一直往后加
  eq(nextSpaceName(new Set(['未命名 1', '未命名 3'])), '未命名 2', '中间有空位时补空位');
  // 用户自己起过名字，不影响默认名的编号
  eq(nextSpaceName(new Set(['星际', '深海'])), '未命名 1', '用户自定义名字不占编号');

  section('空间规则 · 恢复时的命名冲突');

  eq(uniqueSpaceName('星际', new Set()), '星际', '不冲突就用原名');
  eq(uniqueSpaceName('星际', new Set(['深海'])), '星际', '别的名字不冲突');
  eq(uniqueSpaceName('星际', new Set(['星际'])), '星际（恢复）', '冲突一次 → 加（恢复）');
  eq(
    uniqueSpaceName('星际', new Set(['星际', '星际（恢复）'])),
    '星际（恢复 2）',
    '冲突两次 → （恢复 2）',
  );
  eq(
    uniqueSpaceName('星际', new Set(['星际', '星际（恢复）', '星际（恢复 2）'])),
    '星际（恢复 3）',
    '冲突三次 → （恢复 3）',
  );

  section('空间规则 · 色板分配');

  eq(pickHue([]), 0, '第一个空间用 0 号色');
  eq(pickHue([space(0)]), 1, '0 号已被用 → 1 号');
  eq(pickHue([space(0), space(1)]), 2, '0/1 已用 → 2 号');
  eq(pickHue([space(0), space(3)]), 1, '0/3 已用 → 挑最小可用的 1 号');
  eq(pickHue([space(0), space(0), space(1)]), 2, '0 号用了两次 → 挑更少的 2 号');

  // 九个都用过一遍之后应回到 0 号（循环）
  const all = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((h) => space(h));
  eq(pickHue(all), 0, '九色全用过 → 回到 0 号循环');

  // 越界/异常的 hue 不该让它崩掉
  let safe = true;
  try {
    pickHue([space(-1), space(99)]);
  } catch {
    safe = false;
  }
  ok(safe, '遇到越界的 hue 不抛错（按 9 取模处理）');
}
