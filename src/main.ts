/**
 * 启动编排 —— 全项目唯一的胶水层。
 *
 * 阶段 1 的目标只有一个：**证明"写进去、刷新还在"这条链路是通的**。
 * 所以这里刻意不做力导向、不做飞入动画、不做搜索，只有一个输入框和一张清单。
 * 泡泡星云在阶段 2/3 接管渲染，届时本文件的渲染部分会被替换掉，
 * 但"启动顺序"与"数据读写"这两段会原样保留。
 *
 * 🔴 启动顺序是刻意设计的：
 *    先渲染本地（0 延迟）→ 后台再做同步（阶段 6）。
 *    绝不能"等同步完再显示"，那会让每一次打开都先卡一下。
 */

import { newId } from './rng';
import { NebulaStore } from './store';
import { installFontStackVar } from './text';
import { mountInput, type NoticeKind } from './ui/input';
import { SPACE_NAME_DEFAULT, type Idea, type Space } from './types';

function must<T extends HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`页面缺少必需的元素：${selector}`);
  return el;
}

/** 提示一行消息。kind 决定配色。 */
function makeNotice(el: HTMLElement) {
  return (message: string, kind: NoticeKind = 'info'): void => {
    el.textContent = message;
    el.dataset.kind = kind;
    if (message === '') delete el.dataset.kind;
  };
}

/**
 * 确保至少有一个空间，并决定"当前是哪个"。
 *
 * 判定顺序：上次所在的空间 → 第一个空间 → 新建一个。
 * 用 lastSpaceId 而不是"第一个"，是因为用户上次在哪、下次就该还在哪。
 */
async function resolveCurrentSpace(store: NebulaStore): Promise<Space> {
  const spaces = await store.getAllSpaces();
  const lastId = await store.getLastSpaceId();

  if (spaces.length > 0) {
    const remembered = lastId ? spaces.find((s) => s.id === lastId) : undefined;
    return remembered ?? spaces[0];
  }

  const now = Date.now();
  const space: Space = {
    id: newId(),
    name: `${SPACE_NAME_DEFAULT} 1`,
    hue: 0,
    createdAt: now,
    updatedAt: now,
    deleted: 0,
    purgeAt: 0,
  };
  await store.putSpace(space);
  await store.setLastSpaceId(space.id);
  return space;
}

/**
 * 渲染想法清单。
 *
 * 🔴 一律用 textContent 而不是 innerHTML —— 这里渲染的是用户自己输入的文本，
 *    用 innerHTML 等于把输入当代码执行。这是最容易留下的一个洞。
 */
function renderIdeas(listEl: HTMLElement, ideas: Idea[]): void {
  listEl.replaceChildren();

  // 最近的排在上面：录入后一眼能看到自己刚写的那条
  for (const idea of [...ideas].reverse()) {
    const li = document.createElement('li');
    li.dataset.id = idea.id;

    const text = document.createElement('span');
    text.className = 'idea-text';
    text.textContent = idea.text;

    const time = document.createElement('span');
    time.className = 'idea-meta';
    time.textContent = new Date(idea.createdAt).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });

    li.append(text, time);
    listEl.append(li);
  }
}

/**
 * 浏览器内自检。
 *
 * Node 里跑不了 IndexedDB，所以 store 的正确性只能在这里验。
 * 每条都真写、真读、真删，跑完不留痕迹。
 */
async function runSelfTest(store: NebulaStore): Promise<string[]> {
  const results: string[] = [];
  const check = (name: string, ok: boolean, extra = ''): void => {
    results.push(`[${ok ? 'OK  ' : 'FAIL'}] ${name}${extra ? '  ' + extra : ''}`);
  };

  const now = Date.now();
  const probeSpaceId = newId();
  const probeIdeaId = newId();
  const probeMetaKey = `__selftest:${now}`;

  try {
    // 1. 空间写入 → 读回
    const space: Space = {
      id: probeSpaceId,
      name: '自检空间',
      hue: 3,
      createdAt: now,
      updatedAt: now,
      deleted: 0,
      purgeAt: 0,
    };
    await store.putSpace(space);
    const readSpace = await store.getSpace(probeSpaceId);
    check('空间 写入→读回', readSpace?.name === '自检空间' && readSpace.hue === 3);

    // 2. 想法写入 → 按 spaceId 索引读回（顺带验证索引可用）
    const idea: Idea = {
      id: probeIdeaId,
      spaceId: probeSpaceId,
      text: '自检用的一句话',
      createdAt: now,
      updatedAt: now,
      movedAt: now,
      x: 0,
      y: 0,
      pinned: 0,
      linksAlwaysOn: 0,
      archived: 0,
    };
    await store.putIdea(idea);
    const bySpace = await store.getIdeasBySpace(probeSpaceId);
    check('想法 索引查询（spaceId）', bySpace.length === 1 && bySpace[0].id === probeIdeaId);

    // 3. 计数
    const count = await store.countIdeasBySpace(probeSpaceId);
    check('想法 计数', count === 1, `count=${count}`);

    // 4. archived 过滤：归档的想法不该出现在星云里
    await store.putIdea({ ...idea, archived: 1, updatedAt: now + 1 });
    const visible = await store.getIdeasBySpace(probeSpaceId);
    const all = await store.getIdeasBySpace(probeSpaceId, true);
    check('归档过滤', visible.length === 0 && all.length === 1);

    // 5. meta 写入 → 读回
    await store.setMeta(probeMetaKey, { hello: '世界', n: 42 });
    const meta = await store.getMeta<{ hello: string; n: number }>(probeMetaKey);
    check('meta 写入→读回', meta?.hello === '世界' && meta.n === 42);

    // 6. 视口按空间隔离（这是"多空间互不影响"的前置条件）
    const otherId = newId();
    await store.setViewport(probeSpaceId, { scale: 1.5, tx: 10, ty: 20 });
    await store.setViewport(otherId, { scale: 0.5, tx: 0, ty: 0 });
    const vpA = await store.getViewport(probeSpaceId);
    const vpB = await store.getViewport(otherId);
    check('视口按空间隔离', vpA?.scale === 1.5 && vpB?.scale === 0.5);

    // 7. 删除
    await store.hardDeleteIdea(probeIdeaId);
    await store.hardDeleteSpace(probeSpaceId);
    await store.deleteMeta(probeMetaKey);
    await store.deleteMeta(`viewport:${otherId}`);
    await store.deleteMeta(`viewport:${probeSpaceId}`);
    const gone = await store.getIdea(probeIdeaId);
    check('删除生效', gone === undefined);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    check('自检过程未抛异常', false, message);
  }

  return results;
}

async function main(): Promise<void> {
  const spaceNameEl = must<HTMLElement>('#space-name');
  const spaceCountEl = must<HTMLElement>('#space-count');
  const listEl = must<HTMLElement>('#list');
  const noticeEl = must<HTMLElement>('#notice');
  const inputEl = must<HTMLTextAreaElement>('#input');
  const selfTestBtn = must<HTMLButtonElement>('#selftest');
  const selfTestOut = must<HTMLElement>('#selftest-out');

  const notice = makeNotice(noticeEl);

  const store = new NebulaStore();

  try {
    await store.open();
  } catch (err) {
    // 最常见的失败就是把 index.html 双击用 file:// 打开 —— 直接说清楚怎么修
    const message = err instanceof Error ? err.message : String(err);
    notice(`打不开本地数据库：${message}`, 'error');
    listEl.replaceChildren();
    spaceNameEl.textContent = '无法启动';
    return;
  }

  // 启动时清一次过期回收站（另一处是打开回收站时，在阶段 2 接）
  try {
    const purged = await store.purgeExpired();
    if (purged > 0) notice(`回收站有 ${purged} 项已到期，已清理`, 'info');
  } catch {
    // 清理失败不该挡住启动
  }

  const space = await resolveCurrentSpace(store);

  const refresh = async (): Promise<void> => {
    const ideas = await store.getIdeasBySpace(space.id);
    renderIdeas(listEl, ideas);
    spaceNameEl.textContent = space.name;
    spaceCountEl.textContent = `${ideas.length} 条`;
  };

  await refresh();

  mountInput({
    el: inputEl,
    onNotice: notice,
    async onSubmit(text: string) {
      const now = Date.now();
      const idea: Idea = {
        id: newId(),
        spaceId: space.id,
        text,
        createdAt: now,
        updatedAt: now,
        movedAt: now,
        // 阶段 3 由力导向接管；现在先落在原点附近
        x: 0,
        y: 0,
        pinned: 0,
        linksAlwaysOn: 0,
        archived: 0,
      };

      // 🔴 本地写入 —— 这一步成功就算"记下来了"，网络同步在阶段 6 之后异步进行
      await store.putIdea(idea);
      await refresh();
      notice('记下了', 'info');
    },
  });

  selfTestBtn.addEventListener('click', () => {
    selfTestOut.textContent = '正在自检…';
    void runSelfTest(store).then((lines) => {
      selfTestOut.textContent = lines.join('\n');
      const failed = lines.filter((l) => l.startsWith('[FAIL]')).length;
      notice(failed === 0 ? `自检通过（${lines.length} 项）` : `自检有 ${failed} 项失败`, failed === 0 ? 'info' : 'error');
    });
  });

  // 方便在控制台里查数据，也是阶段 1 手工验证用的入口
  (window as unknown as { __nebula?: unknown }).__nebula = {
    store,
    selfTest: () => runSelfTest(store),
    listIdeas: () => store.getAllIdeas(),
    currentSpace: space,
  };

  inputEl.focus();
}

// 🔴 第一件事就是把字体栈注入 CSS 变量 —— 必须在任何测量发生之前，
//    否则 canvas 测量用的字体和页面渲染用的字体可能不一致，尺寸就错了。
installFontStackVar();

void main();
