/**
 * 测试入口。`npm test` 会把它打包成 test/bundle.js 再用 node 跑。
 *
 * 这里不引任何测试框架，也不引 @types/node，所以拿不到 process 的类型 ——
 * 用一个最小结构代替。失败时既设置退出码（让 CI/脚本能判断），
 * 也抛错（让人一眼看到失败清单）。
 */

import { runRngTests } from './rng';
import { runTextTests } from './text';
import { summary } from './assert';

runRngTests();
runTextTests();

const result = summary();

const proc = (globalThis as { process?: { exit(code: number): void } }).process;

if (result.failed > 0) {
  proc?.exit(1);
  throw new Error(`有 ${result.failed} 项断言失败：\n  · ${result.failures.join('\n  · ')}`);
}
