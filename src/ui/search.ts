/**
 * 搜索：聚光，不是清场。
 *
 * 🔴 本文件最重要的一条设计：**绝不筛选掉未命中的泡泡**。
 *    筛选会让星云从"一片海"缩成"几个点" —— 而版图的存在本身就是这个产品的意义，
 *    你搜一个词不是为了把它找出来，是为了在找的过程中看见它周围还有什么。
 *    所以未命中的泡泡只是变暗（opacity），仍然留在原地、仍然可点。
 *
 * 🔴 第二条：**零索引**。500 条 × 12 字 = 6000 字符，朴素扫完 < 0.1ms。
 *    建倒排索引换不回任何可感知的收益，却引入"索引与原文不一致"这一整类 bug
 *    （新增/编辑/删除都要同步索引，任何一条路径漏了就会出现"明明有却搜不到"）。
 *    等真的到几万条再说 —— 那时该换的也不是索引，而是先量一下到底慢在哪。
 *
 * 🔴 第三条：**中文输入法守卫**。`input` 事件在组字过程中每个拼音中间态都会触发，
 *    debounce 回调里如果不判断 isComposing，打"lingsant"会触发 11 次全量搜索 +
 *    全量 DOM class 改写，页面直接卡住。见 mountSearch 里的守卫。
 */

import { scoreMatch } from '../text';

/** 输入后多久开始搜索。太短会跟输入法打架，太长会显得迟钝。 */
export const SEARCH_DEBOUNCE_MS = 120;

/** 未命中的泡泡降到多暗。 */
export const DIM_OPACITY = 0.16;

/** 跳转记忆：多久没跳就认为"重新开始一轮"，下一次 Enter 从最好的那条开始。 */
export const JUMP_IDLE_MS = 4000;

// ─────────────────────────────────────────────────────────────
// 纯函数（可脱离浏览器测试）
// ─────────────────────────────────────────────────────────────

/** 一段文本的命中情况。用于生成 <mark> 与纯文本节点。 */
export interface Segment {
  text: string;
  hit: boolean;
}

/**
 * 把文本按查询串切成"命中 / 未命中"的片段。
 *
 * 两种命中方式，对应 scoreMatch 的两条打分路径：
 *  ① **子串命中**（前缀 / 包含）—— 直接标出那一段连续的字符；
 *  ② **字符集命中**（打错了顺序，比如搜"三凌"要能捞到"凌晨三点"）——
 *     整串找不到，于是退化成"逐个标出查询里的字"。
 *     不这么做的话，明明算它命中了（有分数、有高亮边框）却一个 <mark> 都看不到，
 *     用户会以为搜索坏了。
 */
export function splitByQuery(text: string, query: string): Segment[] {
  if (text === '') return [{ text: '', hit: false }];
  if (query === '') return [{ text, hit: false }];

  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();

  // ① 子串扫描（不重叠，标准做法）
  const out: Segment[] = [];
  let cursor = 0;
  for (;;) {
    const at = lowerText.indexOf(lowerQuery, cursor);
    if (at < 0) break;
    if (at > cursor) out.push({ text: text.slice(cursor, at), hit: false });
    out.push({ text: text.slice(at, at + query.length), hit: true });
    cursor = at + query.length;
  }

  if (out.length > 0) {
    if (cursor < text.length) out.push({ text: text.slice(cursor), hit: false });
    return out;
  }

  // ② 退化：逐个标出查询里出现过的字
  const wanted = new Set<string>();
  for (const ch of lowerQuery) wanted.add(ch);

  let hasAny = false;
  for (const ch of text) {
    if (wanted.has(ch.toLowerCase())) hasAny = true;
  }
  if (!hasAny) return [{ text, hit: false }];

  let buffer = '';
  let bufferHit = false;
  const flush = (): void => {
    if (buffer !== '') out.push({ text: buffer, hit: bufferHit });
    buffer = '';
  };

  for (const ch of text) {
    const hit = wanted.has(ch.toLowerCase());
    if (hit !== bufferHit && buffer !== '') flush();
    bufferHit = hit;
    buffer += ch;
  }
  flush();

  return out.length > 0 ? out : [{ text, hit: false }];
}

/** 已有节点的形状，用于判断能否复用。 */
export interface NodeShape {
  tag: string;
  text: string;
}

/**
 * 算出"每个目标片段能不能复用同位置的已有节点"。
 *
 * 🔴 为什么要复用而不是整段重建：
 *    每敲一个字就重建整个 label 的 DOM，会让文字**闪一下**（浏览器要重新排版、
 *    重绘整段），而搜索是边打边看的过程，闪一下非常干扰。
 *    实际变化很小（往往只是多标一个字），复用同位置形状相同的节点就没有闪烁。
 *
 * 返回的数组长度等于 segments 的长度；true = 复用，false = 需要新建/替换。
 * 调用方还要负责删掉多出来的尾部节点。
 */
export function planReconcile(
  existing: ReadonlyArray<NodeShape>,
  segments: ReadonlyArray<Segment>,
): boolean[] {
  return segments.map((seg, i) => {
    const node = existing[i];
    if (!node) return false;
    const wantTag = seg.hit ? 'MARK' : '#text';
    return node.tag === wantTag && node.text === seg.text;
  });
}

export interface SearchTargetLike {
  id: string;
  text: string;
}

export interface RankedMatch {
  id: string;
  score: number;
}

/**
 * 按分数排出命中的泡泡。
 *
 * 排序稳定（同分保持传入顺序）—— 否则同分的几条会在每次输入时跳来跳去，
 * 按 Enter 跳转的次序就不可预期了。
 */
export function rankMatches(
  items: ReadonlyArray<SearchTargetLike>,
  query: string,
): RankedMatch[] {
  if (query === '') return [];
  const scored = items
    .map((item, index) => ({ id: item.id, score: scoreMatch(item.text, query), index }))
    .filter((m) => m.score > 0);

  scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.index - b.index));

  return scored.map((m) => ({ id: m.id, score: m.score }));
}

/**
 * 在命中项之间前后跳转（循环）。
 * current 为 -1 表示"还没跳过"。向后跳时从 -1 走到 0（也就是最好的那条）。
 */
export function stepIndex(current: number, total: number, backward: boolean): number {
  if (total <= 0) return -1;
  if (current < 0) return backward ? total - 1 : 0;
  return backward ? (current - 1 + total) % total : (current + 1) % total;
}

/** 计数文案。 */
export function countLabel(hits: number, query: string): string {
  if (query === '') return '';
  return `⌕ ${hits} 条`;
}

/** 其他空间命中的提示文案。 */
export function otherSpaceHint(spaceName: string, count: number): string {
  return `其他空间还有 ${count} 条命中 · 去「${spaceName}」看看`;
}

/** 跳转时的脉冲：一次短促的放大再收回。 */
export function pulseKeyframes(): Keyframe[] {
  return [
    { transform: 'scale(1)', offset: 0 },
    { transform: 'scale(1.14)', offset: 0.35 },
    { transform: 'scale(1)', offset: 1 },
  ];
}

// ─────────────────────────────────────────────────────────────
// 把命中状态画到 label 上
// ─────────────────────────────────────────────────────────────

function shapeOfNode(node: Node): NodeShape {
  return {
    tag: node.nodeType === Node.TEXT_NODE ? '#text' : (node as Element).tagName,
    text: node.textContent ?? '',
  };
}

/**
 * 把分段渲染进一个 label 元素，尽量复用已有节点。
 * 返回是否真的动过 DOM（没动过 = 可以跳过后续工作）。
 */
export function renderSegments(label: Element, segments: ReadonlyArray<Segment>): boolean {
  const nodes = Array.from(label.childNodes);
  const existing = nodes.map(shapeOfNode);
  const reuse = planReconcile(existing, segments);

  let touched = false;

  // 先删掉多出来的尾部（从后往前，避免索引漂移）
  for (let i = existing.length - 1; i >= segments.length; i--) {
    nodes[i]?.remove();
    touched = true;
  }

  // 再从后往前替换 / 补建
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    const node = label.childNodes[i];

    if (reuse[i] && node) continue;

    const next: Node = seg.hit
      ? document.createElement('mark')
      : document.createTextNode('');
    next.textContent = seg.text;

    if (node) label.replaceChild(next, node);
    else label.appendChild(next);
    touched = true;
  }

  return touched;
}

// ─────────────────────────────────────────────────────────────
// 控制器
// ─────────────────────────────────────────────────────────────

export interface SearchHitState {
  id: string;
  hit: boolean;
}

export interface OtherSpaceMatch {
  spaceId: string;
  name: string;
  count: number;
}

export interface SearchHost {
  /** 当前空间里所有**可见**的泡泡（归档的不算：它没有可高亮的泡泡）。 */
  targets(): SearchTargetLike[];
  /** 应用命中状态。query 决定 label 上的 <mark>。 */
  apply(states: ReadonlyArray<SearchHitState>, query: string): void;
  /** 清空全部命中状态（恢复全貌）。 */
  clear(): void;
  /** 把某个泡泡居中。**移动视口，不移动泡泡。** */
  centerOn(id: string): void;
  /** 给某个泡泡一个脉冲。 */
  pulse(id: string): void;
  /** 统计其他空间的命中，按命中数从多到少。 */
  otherSpaceMatches(query: string): Promise<OtherSpaceMatch[]>;
  /** 用户点了提示条：切到那个空间（搜索词保留）。 */
  goToSpace(spaceId: string): void;
}

export interface SearchHandle {
  /** 空间切换 / 数据变化后重建结果（🔴 不重建会残留上一个空间的命中）。 */
  refresh(): void;
  clear(): void;
  readonly query: string;
  readonly hitCount: number;
}

export function mountSearch(
  input: HTMLInputElement,
  countEl: HTMLElement,
  hintEl: HTMLButtonElement,
  host: SearchHost,
): SearchHandle {
  let query = '';
  let hits: RankedMatch[] = [];
  let jumpIndex = -1;
  let lastJumpAt = 0;
  let composing = false;
  let timer = 0;
  /** 每次搜索自增，用来丢弃过期的异步结果。 */
  let generation = 0;

  function applyState(): void {
    const targets = host.targets();
    if (query === '') {
      host.clear();
      countEl.textContent = '';
      hintEl.hidden = true;
      return;
    }

    hits = rankMatches(targets, query);
    const hitIds = new Set(hits.map((h) => h.id));
    host.apply(
      targets.map((t) => ({ id: t.id, hit: hitIds.has(t.id) })),
      query,
    );
    countEl.textContent = countLabel(hits.length, query);

    // 其他空间的命中：异步且可能过期，用 generation 丢弃旧结果
    const gen = generation;
    void host
      .otherSpaceMatches(query)
      .then((others) => {
        if (gen !== generation) return;
        if (others.length === 0) {
          hintEl.hidden = true;
          return;
        }
        const total = others.reduce((sum, o) => sum + o.count, 0);
        // 指向命中最多的那个空间（others 已排序）
        hintEl.textContent = otherSpaceHint(others[0].name, total);
        hintEl.dataset.spaceId = others[0].spaceId;
        hintEl.hidden = false;
      })
      .catch(() => {
        hintEl.hidden = true;
      });
  }

  /** 真正跑一次搜索。 */
  function run(): void {
    // 🔴 中文输入法守卫。放在最前面，不能漏：
    //    没有它，打 "lingsant" 的过程中每个拼音中间态都会触发一次全量搜索
    //    （几百次 scoreMatch + 几百次 DOM class 改写），页面会明显卡顿。
    if (composing) return;

    generation++;
    query = input.value.trim();
    jumpIndex = -1;
    applyState();
  }

  function schedule(): void {
    window.clearTimeout(timer);
    timer = window.setTimeout(run, SEARCH_DEBOUNCE_MS);
  }

  function onInput(e: Event): void {
    // 两道守卫都要：自己跟踪的 composing，以及事件自带的 isComposing
    if (composing || (e as InputEvent).isComposing) return;
    schedule();
  }

  function onCompositionStart(): void {
    composing = true;
  }

  function onCompositionEnd(): void {
    composing = false;
    // 组字结束后补一次：compositionend 之后的 input 事件才是最终文本
    schedule();
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key !== 'Enter') return;
    if (composing || e.isComposing || e.keyCode === 229) return;
    if (hits.length === 0) return;

    e.preventDefault();

    // 隔太久没跳 ⇒ 认为是一轮新的跳转，从最好的那条重新开始
    const now = performance.now();
    if (now - lastJumpAt > JUMP_IDLE_MS) jumpIndex = -1;
    lastJumpAt = now;

    jumpIndex = stepIndex(jumpIndex, hits.length, e.shiftKey);
    const target = hits[jumpIndex];
    if (!target) return;

    // 🔴 只把视口移过去让它居中，**不动泡泡本身**，也不"飞过去" ——
    //    自动滚走会打断"一边搜一边想"
    host.centerOn(target.id);
    host.pulse(target.id);
  }

  function clear(): void {
    window.clearTimeout(timer);
    input.value = '';
    query = '';
    hits = [];
    jumpIndex = -1;
    generation++;
    host.clear();
    countEl.textContent = '';
    hintEl.hidden = true;
  }

  input.addEventListener('input', onInput);
  input.addEventListener('compositionstart', onCompositionStart);
  input.addEventListener('compositionend', onCompositionEnd);
  input.addEventListener('keydown', onKeyDown);
  hintEl.addEventListener('click', () => {
    const spaceId = hintEl.dataset.spaceId;
    if (spaceId) host.goToSpace(spaceId);
  });

  return {
    refresh: () => {
      generation++;
      query = input.value.trim();
      applyState();
    },
    clear,
    get query() {
      return query;
    },
    get hitCount() {
      return hits.length;
    },
  };
}
