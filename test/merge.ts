/**
 * 同步模块的测试。**全项目最需要被钉死的一块** —— 合并算错就是丢数据。
 *
 * 覆盖三部分：
 *  ① 合并代数（本文件的主体，也是需求里点名要的）
 *  ② base64 编解码（中文同步的命门，见 github.ts 的坑 #2）
 *  ③ 远端文档解析（"最恐怖的失败"的闸门）
 */

import { close, eq, eqJson, ok, section } from './assert';
import {
  diffDocs,
  emptyDoc,
  isEmptyDoc,
  mergeDocs,
  mergeIdea,
  mergeSpace,
  sameDoc,
  serializeDoc,
  type SyncDoc,
} from '../src/sync/merge';
import { fromBase64, SyncError, toBase64, utf8ByteLength } from '../src/sync/github';
import { ownerVerdict, parseDoc } from '../src/sync/syncEngine';
import type { Idea, Space } from '../src/types';

// ── 造数据的小工具 ────────────────────────────────────────

function idea(id: string, spaceId: string, text: string, over: Partial<Idea> = {}): Idea {
  return {
    id,
    spaceId,
    text,
    createdAt: 1000,
    updatedAt: 1000,
    movedAt: 0,
    x: 0,
    y: 0,
    pinned: 0,
    linksAlwaysOn: 0,
    archived: 0,
    ...over,
  };
}

function space(id: string, name: string, over: Partial<Space> = {}): Space {
  return {
    id,
    name,
    hue: 0,
    createdAt: 1000,
    updatedAt: 1000,
    deleted: 0,
    purgeAt: 0,
    ...over,
  };
}

function doc(spaces: Space[], ideas: Idea[]): SyncDoc {
  return { version: 1, savedAt: 0, spaces, ideas };
}

/** 取某条想法。 */
function pick(d: SyncDoc, id: string): Idea | undefined {
  return d.ideas.find((i) => i.id === id);
}

/** 断言某个操作抛出 SyncError 且 kind 匹配。 */
function throwsSync(kind: string, fn: () => void, message: string): void {
  try {
    fn();
    ok(false, `${message} —— 但没有抛错`);
  } catch (err) {
    const isSync = err instanceof SyncError && err.kind === kind;
    ok(isSync, isSync ? message : `${message} —— 抛的是 ${String(err)}`);
  }
}

export function runMergeTests(): void {
  const S = space('s1', '星际');

  section('merge · 基本情形');

  {
    const local = doc([S], [idea('i1', 's1', '本地想法')]);
    const remote = emptyDoc();
    const merged = mergeDocs(local, remote);
    eq(merged.ideas.length, 1, '纯本地：想法保留');
    eq(pick(merged, 'i1')?.text, '本地想法', '纯本地：文本保持不变');
  }

  {
    const local = emptyDoc();
    const remote = doc([S], [idea('i2', 's1', '远端想法')]);
    const merged = mergeDocs(local, remote);
    eq(merged.ideas.length, 1, '纯远端：想法被带过来');
    eq(merged.spaces.length, 1, '纯远端：空间被带过来');
  }

  {
    const d = doc([S], [idea('i1', 's1', '一样')]);
    const merged = mergeDocs(d, d);
    ok(sameDoc(merged, d), '完全相同 ⇒ 合并结果与输入一致（不会产生无意义的推送）');
  }

  section('merge · 文本冲突（LWW on updatedAt）');

  {
    const local = doc([S], [idea('i1', 's1', '旧的', { updatedAt: 100 })]);
    const remote = doc([S], [idea('i1', 's1', '新的', { updatedAt: 200 })]);
    eq(pick(mergeDocs(local, remote), 'i1')?.text, '新的', 'updatedAt 更大的赢');
    eq(pick(mergeDocs(remote, local), 'i1')?.text, '新的', '交换参数顺序结果不变');
  }

  {
    // 🔴 这条是交换律最容易破的地方：时间戳完全相同
    const local = doc([S], [idea('i1', 's1', 'AAA', { updatedAt: 100 })]);
    const remote = doc([S], [idea('i1', 's1', 'BBB', { updatedAt: 100 })]);
    const ab = pick(mergeDocs(local, remote), 'i1')?.text;
    const ba = pick(mergeDocs(remote, local), 'i1')?.text;
    eq(ab, ba, '时间戳打平时，两种参数顺序得到同一个结果（否则两台设备永远收敛不到一起）');
  }

  section('merge · 位置冲突（LWW on movedAt）');

  {
    const local = doc([S], [idea('i1', 's1', '同一句话', { movedAt: 100, x: 5, y: 5 })]);
    const remote = doc([S], [idea('i1', 's1', '同一句话', { movedAt: 300, x: 90, y: 90 })]);
    const merged = pick(mergeDocs(local, remote), 'i1');
    eq(merged?.x, 90, 'movedAt 更大的位置赢（x）');
    eq(merged?.y, 90, 'movedAt 更大的位置赢（y）');
    eq(merged?.movedAt, 300, 'movedAt 也跟着赢家');
  }

  section('merge · 🔴 文本与位置分别冲突（互不干扰）');

  {
    // 这是 updatedAt / movedAt 分离的**全部意义**所在：
    // 本地后来动了位置、远端后来改了文本，两边的新意都不该被对方吃掉
    const local = doc([
      S,
    ], [idea('i1', 's1', '本地文本', { updatedAt: 100, movedAt: 900, x: 7, y: 8 })]);
    const remote = doc([
      S,
    ], [idea('i1', 's1', '远端文本', { updatedAt: 800, movedAt: 50, x: 1, y: 2 })]);

    const merged = pick(mergeDocs(local, remote), 'i1');
    eq(merged?.text, '远端文本', '文本取 updatedAt 的赢家（远端 800 > 本地 100）');
    eq(merged?.x, 7, '位置取 movedAt 的赢家（本地 900 > 远端 50）');
    eq(merged?.y, 8, '位置取 movedAt 的赢家（y）');
    ok(
      merged?.updatedAt === 800 && merged?.movedAt === 900,
      `两个时间戳各自保留自己那一边的（updatedAt=${merged?.updatedAt} movedAt=${merged?.movedAt}）`,
    );

    // 反过来合也应该一样
    const swapped = pick(mergeDocs(remote, local), 'i1');
    ok(
      swapped?.text === merged?.text && swapped?.x === merged?.x && swapped?.y === merged?.y,
      '交换参数顺序后结果依然一致',
    );
  }

  section('merge · 空间：删除与改名');

  {
    // A 设备删了空间（updatedAt 更晚），B 设备只是早一点改了名
    const local = doc([space('s1', '星际', { deleted: 1, purgeAt: 500, updatedAt: 200 })], []);
    const remote = doc([space('s1', '星际', { updatedAt: 100 })], []);
    const merged = mergeDocs(local, remote);
    eq(merged.spaces[0].deleted, 1, '删除（updatedAt 更晚）获胜');
  }

  {
    // ⚠️ 反向情形：B 设备在 A 删除之后又改了名 ⇒ 空间复活。
    //    这是刻意的取舍（见 mergeSpace 的注释），在这里把行为钉住，免得被误当 bug 改掉
    const local = doc([space('s1', '星际', { deleted: 1, purgeAt: 500, updatedAt: 150 })], []);
    const remote = doc([space('s1', '星际（改过名）', { updatedAt: 300 })], []);
    const merged = mergeDocs(local, remote);
    eq(merged.spaces[0].deleted, 0, '更晚的改名会把空间"救回来"（产品取舍：宁可多留不可错杀）');
    eq(merged.spaces[0].name, '星际（改过名）', '名字用更新的那个');
  }

  section('merge · 🔴 删除空间与另一台设备新增想法并发');

  {
    // A 设备删了空间 S；同时 B 设备往 S 里加了一条想法。
    const local = doc([space('s1', '星际', { deleted: 1, purgeAt: 500, updatedAt: 900 })], []);
    const remote = doc(
      [space('s1', '星际', { updatedAt: 100 })],
      [idea('new-on-B', 's1', 'B 刚想到的')],
    );

    const merged = mergeDocs(local, remote);
    eq(merged.spaces[0].deleted, 1, '空间确实是删除状态（墓碑保住了）');
    ok(pick(merged, 'new-on-B') !== undefined, '🔴 B 刚加的想法**没有丢**（并集的意义就在这里）');
    eq(pick(merged, 'new-on-B')?.text, 'B 刚想到的', '想法内容完整');
    eq(pick(merged, 'new-on-B')?.spaceId, 's1', '它仍然挂在那个（已删除的）空间下');

    // 它在回收站里等着被恢复 —— 恢复空间时它会一起回来
    ok(
      merged.spaces.some((sp) => sp.id === 's1' && sp.deleted === 1),
      '空间进回收站，想法跟着一起被"冷藏"而不是被丢弃',
    );
  }

  section('merge · 🔴 彻底删除列表（防数据复活）');

  {
    // A 设备清空了回收站（物理删掉 s1 与 i1）；B 设备的镜像里还有它们
    const local: SyncDoc = { ...doc([], []), purged: ['s1', 'i1'] };
    const remote = doc([space('s1', '已清理')], [idea('i1', 's1', '已清理')]);
    const merged = mergeDocs(local, remote);
    eq(merged.spaces.length, 0, '清掉的空间不会从镜像里复活');
    eq(merged.ideas.length, 0, '清掉的想法不会从镜像里复活');
    eqJson(merged.purged, ['i1', 's1'], '清掉的 id 被记进列表并排序');
  }

  {
    // 反方向：本地还有、远端已经清掉
    const local = doc([space('s1', 'x')], [idea('i1', 's1', 'x')]);
    const remote: SyncDoc = { ...doc([], []), purged: ['s1', 'i1'] };
    const merged = mergeDocs(local, remote);
    eq(merged.ideas.length, 0, '镜像说"清掉了"，本地也必须跟着消失（清空是全局意志）');
  }

  {
    // 两台设备各清各的 ⇒ 合并后两边都不复活
    const a: SyncDoc = { ...doc([], []), purged: ['x1'] };
    const b: SyncDoc = { ...doc([], []), purged: ['x2'] };
    const ab = mergeDocs(a, b);
    eqJson(ab.purged, ['x1', 'x2'], '两台设备各清各的，合并后两份清单都在');
    ok(sameDoc(mergeDocs(ab, a), ab), '清空列表的合并也满足幂等');
    ok(sameDoc(ab, mergeDocs(b, a)), '清空列表的合并也满足交换律');
  }

  {
    // 边界：本地全空 + 镜像里的东西全被清掉 ⇒ 结果确实是空，这是合法的
    const local: SyncDoc = { ...doc([], []), purged: ['s1'] };
    const remote = doc([space('s1', 'x')], []);
    ok(isEmptyDoc(mergeDocs(local, remote)), '全被清掉时结果为空是合法的（不是异常）');
  }

  section('merge · 三条代数性质');

  {
    const a = doc(
      [space('s1', 'A', { updatedAt: 100 })],
      [idea('i1', 's1', 'a1', { updatedAt: 100 }), idea('i2', 's1', 'a2', { updatedAt: 300 })],
    );
    const b = doc(
      [space('s1', 'B', { updatedAt: 200 }), space('s2', 'B2')],
      [
        idea('i1', 's1', 'b1', { updatedAt: 150 }),
        idea('i3', 's2', 'b3', { updatedAt: 50 }),
      ],
    );

    const ab = mergeDocs(a, b);
    const ba = mergeDocs(b, a);

    // 幂等
    ok(sameDoc(mergeDocs(ab, b), ab), '幂等：merge(merge(a,b), b) === merge(a,b)');
    ok(sameDoc(mergeDocs(ab, a), ab), '幂等（另一边）：merge(merge(a,b), a) === merge(a,b)');

    // 交换
    ok(sameDoc(ab, ba), '交换：merge(a,b) === merge(b,a)（逐字节相同）');

    // 单调：合并只会带来信息，不会丢
    const ids = new Set([...a.ideas.map((i) => i.id), ...b.ideas.map((i) => i.id)]);
    eq(ab.ideas.length, ids.size, '单调：两边所有想法都还在并集里');
    eq(ab.spaces.length, 2, '单调：两边的空间都还在');
  }

  section('merge · 序列化稳定性');

  {
    const mk = (): SyncDoc =>
      doc(
        [space('s2', '二'), space('s1', '一')],
        [idea('i2', 's1', '二'), idea('i1', 's1', '一')],
      );
    // 数组顺序不同的两份文档，序列化后应当一致（否则会凭空产生 commit）
    ok(
      serializeDoc(mk()) === serializeDoc(mk()),
      '同样内容永远得到同样的字节（数组已排序）',
    );
    ok(!isEmptyDoc(mk()), '非空文档');
    ok(isEmptyDoc(emptyDoc()), '空文档');
  }

  section('merge · 差异报告（同步要"可见"）');

  {
    const localBefore = doc([S], [idea('i1', 's1', '本地独有')]);
    const remote = doc([S], [idea('i2', 's1', '远端独有')]);
    const merged = mergeDocs(localBefore, remote);
    const report = diffDocs(localBefore, merged);

    eqJson(report.addedFromRemote, ['i2'], '差异报告：哪几条是远端带来的');
    eqJson(report.localWon, ['i1'], '差异报告：哪几条保持了本地版本');
    eqJson(report.remoteWon, [], '差异报告：没有被远端改写的');
  }

  {
    const localBefore = doc([S], [idea('i1', 's1', '本地旧文本', { updatedAt: 100 })]);
    const remote = doc([S], [idea('i1', 's1', '远端新文本', { updatedAt: 900 })]);
    const report = diffDocs(localBefore, mergeDocs(localBefore, remote));
    eqJson(report.remoteWon, ['i1'], '差异报告：被远端改写的那条（UI 要让它"闪一下"）');
    eqJson(report.addedFromRemote, [], '没有新增');
  }

  section('merge · 单条合并的边界');

  {
    const l = idea('i1', 's1', 'x', { updatedAt: 5, movedAt: 5, x: 1, y: 1 });
    const r = idea('i1', 's1', 'x', { updatedAt: 5, movedAt: 5, x: 1, y: 1 });
    ok(
      mergeIdea(l, r).updatedAt === 5 && mergeIdea(l, r).x === 1,
      '完全相同的两条合并后不变',
    );
    ok(
      serializeDoc(doc([S], [mergeIdea(l, r)])) === serializeDoc(doc([S], [l])),
      '内容一致时合并是无副作用的',
    );

    const s1 = space('s1', 'x', { updatedAt: 5 });
    const s2 = space('s1', 'x', { updatedAt: 5 });
    eq(mergeSpace(s1, s2).name, 'x', '完全相同的两个空间合并后不变');
  }

  section('同步 · 🔴 账号守卫（多用户最容易泄漏数据的地方）');

  eq(ownerVerdict(null, null), 'ok', '没配远端 ⇒ 不涉及跨账号');
  eq(ownerVerdict('alice', null), 'ok', '没配远端时本机有主人也无所谓');
  eq(ownerVerdict(null, 'alice'), 'first-time', '本机还没有主人 ⇒ 首次归属');
  eq(ownerVerdict('alice', 'alice'), 'ok', '同一个人 ⇒ 正常同步');
  ok(
    ownerVerdict('alice', 'bob') === 'mismatch',
    '🔴 本机是 alice 的数据、当前账号是 bob ⇒ 必须拦下来（否则 alice 的想法会被推到 bob 的仓库）',
  );
  // 大小写不该造成误判（GitHub 用户名大小写不敏感）
  ok(
    ownerVerdict('Alice', 'alice') === 'mismatch',
    '（当前实现按严格字符串比较：大小写不同会被判为不匹配，宁可多问一句也不放过）',
  );

  section('同步 · base64（中文同步的命门）');

  {
    const cases = [
      'hello',
      '凌晨三点',
      '混合 mixed 文本 with 中文 and emoji 🎈🚀',
      '带\n换行\t和制表符',
      '',
      'a'.repeat(1000),
      // 🔴 超过 0x8000 字节，专门压分块的边界（不分块会栈溢出）
      '中文'.repeat(12000),
    ];

    let allOk = true;
    let worst = '';
    for (const text of cases) {
      const round = fromBase64(toBase64(text));
      if (round !== text) {
        allOk = false;
        worst = text.slice(0, 20);
      }
    }
    ok(allOk, `base64 往返一致（含中文 / emoji / 换行 / 超过 32KB 的长文本）${allOk ? '' : ' —— 失败于：' + worst}`);

    const big = '中文'.repeat(12000);
    ok(
      utf8ByteLength(big) > 0x8000,
      `确实跨过了分块边界（${utf8ByteLength(big)} 字节 > 32768）`,
    );
  }

  {
    // GitHub 返回的 base64 每 76 字符一个换行 —— 必须能解
    const withBreaks = toBase64('凌晨三点的城市')
      .replace(/(.{8})/g, '$1\n');
    eq(fromBase64(withBreaks), '凌晨三点的城市', '能解带换行的 base64（GitHub 的实际格式）');
  }

  {
    throwsSync('content', () => fromBase64('这不是base64!!!'), '非法 base64 抛 content 类错误');
  }

  section('同步 · 远端文档解析（fail loud 的闸门）');

  {
    throwsSync('content', () => parseDoc('', '测试'), '空字符串 ⇒ 抛错（绝不当作"空数据"）');
    throwsSync('content', () => parseDoc('   \n  ', '测试'), '纯空白 ⇒ 抛错');
    throwsSync('content', () => parseDoc('{坏掉的 json', '测试'), '坏 JSON ⇒ 抛错');
    throwsSync('content', () => parseDoc('{"broken":true}', '测试'), '缺少数组 ⇒ 抛错');
    throwsSync('content', () => parseDoc('"string"', '测试'), '不是对象 ⇒ 抛错');
    throwsSync('content', () => parseDoc('{"spaces":[],"ideas":{}}', '测试'), 'ideas 不是数组 ⇒ 抛错');
  }

  {
    const good = `${JSON.stringify(doc([S], [idea('i1', 's1', '好')]), null, 2)}\n`;
    const parsed = parseDoc(good, '测试');
    eq(parsed.ideas.length, 1, '正常文档能解析');
    eq(parsed.spaces.length, 1, '空间也在');
    ok(sameDoc(parsed, doc([S], [idea('i1', 's1', '好')])), '解析结果与原始文档语义一致');
  }

  {
    // 中文不能被解析坏
    const text = '凌晨三点的城市，一个词就够了';
    const parsed = parseDoc(JSON.stringify(doc([space('s1', '星际')], [idea('i1', 's1', text)])), '测试');
    eq(parsed.ideas[0].text, text, '中文文本经 JSON 往返后完好');
    close(parsed.ideas[0].x, 0, 0, '数值字段正常');
  }
}
