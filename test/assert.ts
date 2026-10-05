/**
 * 极简断言库。
 *
 * 刻意不引测试框架（vitest/jest）：这个项目零运行时依赖，测试也不该为了
 * 一个 expect 拉进来一棵依赖树。这里需要的能力只有"打印、计数、失败时
 * 让进程以非零码退出"，三十行就够。
 */

let passedCount = 0;
let failedCount = 0;
const failureLines: string[] = [];
let currentSection = '(未分组)';

/** 开始一个测试分组，只是为了让输出好读。 */
export function section(name: string): void {
  currentSection = name;
  console.log(`\n── ${name} ──`);
}

/** 断言条件为真。 */
export function ok(condition: boolean, message: string): void {
  if (condition) {
    passedCount++;
    console.log(`  [OK  ] ${message}`);
  } else {
    failedCount++;
    failureLines.push(`${currentSection} :: ${message}`);
    console.log(`  [FAIL] ${message}`);
  }
}

/** 断言严格相等。 */
export function eq<T>(actual: T, expected: T, message: string): void {
  if (actual === expected) {
    ok(true, message);
  } else {
    ok(false, `${message} —— 期望 ${String(expected)}，实际 ${String(actual)}`);
  }
}

/** 断言数值在 [lo, hi] 闭区间内。 */
export function between(actual: number, lo: number, hi: number, message: string): void {
  const inside = Number.isFinite(actual) && actual >= lo && actual <= hi;
  ok(inside, inside ? message : `${message} —— ${actual} 不在 [${lo}, ${hi}] 内`);
}

/** 断言浮点近似相等。 */
export function close(actual: number, expected: number, epsilon: number, message: string): void {
  const diff = Math.abs(actual - expected);
  ok(diff <= epsilon, diff <= epsilon ? message : `${message} —— 期望 ${expected}±${epsilon}，实际 ${actual}（差 ${diff}）`);
}

/** 断言结构化相等（用于对象/数组）。 */
export function eqJson(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(a === b, a === b ? message : `${message} —— 期望 ${b}，实际 ${a}`);
}

/** 断言会抛错。 */
export function throws(fn: () => void, message: string): void {
  try {
    fn();
    ok(false, `${message} —— 但没有抛错`);
  } catch {
    ok(true, message);
  }
}

export interface Summary {
  passed: number;
  failed: number;
  failures: string[];
}

export function summary(): Summary {
  console.log(`\n${'─'.repeat(48)}`);
  if (failedCount === 0) {
    console.log(`全部通过：${passedCount} 项`);
  } else {
    console.log(`通过 ${passedCount} 项，失败 ${failedCount} 项：`);
    for (const line of failureLines) console.log(`  · ${line}`);
  }
  return { passed: passedCount, failed: failedCount, failures: failureLines };
}
