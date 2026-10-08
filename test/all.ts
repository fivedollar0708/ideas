/**
 * 测试入口。`npm test` 会把它打包成 test/bundle.js 再用 node 跑。
 *
 * 分层原则：这里只跑**不依赖浏览器**的纯逻辑（rng / text / force / 空间命名规则）。
 * 依赖 IndexedDB 与 DOM 的部分（store 的读写、main 的编排、渲染）由
 * `npm run smoke` 用真实 Chrome 验 —— 两边合起来才算完整覆盖。
 *
 * 不引测试框架，也不引 @types/node，所以拿不到 process 的类型，
 * 用一个最小结构代替：失败时既设置退出码（脚本能判断），也抛错（人能看到清单）。
 */

import { runRngTests } from './rng';
import { runTextTests } from './text';
import { runForceTests } from './force';
import { runSpaceRulesTests } from './spaceRules';
import { runDragTests } from './drag';
import { runAnimTests } from './anim';
import { runSearchTests } from './search';
import { runMergeTests } from './merge';
import { summary } from './assert';
import { runMobilePerformanceTests } from './mobilePerformance';

runRngTests();
runTextTests();
runForceTests();
runSpaceRulesTests();
runDragTests();
runAnimTests();
runSearchTests();
runMergeTests();
runMobilePerformanceTests();

const result = summary();

const proc = (globalThis as { process?: { exit(code: number): void } }).process;

if (result.failed > 0) {
  proc?.exit(1);
  throw new Error(`有 ${result.failed} 项断言失败：\n  · ${result.failures.join('\n  · ')}`);
}
