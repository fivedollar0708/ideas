/**
 * 泡泡的 DOM 渲染。
 *
 * 🔴 三层元素铁律（整个项目的动画地基）：
 *
 *     .bubble        ← 位置，力导向每帧写 `translate3d(x, y, 0)`
 *       .bubble-scale← 悬停缩放 + 落定"啵"的动画（WAAPI，不加 fill）
 *         .bubble-inner ← 视觉（底色、描边、圆角、内外边距）
 *
 * **绝不能让两个东西抢同一个 transform 属性**。力导向每帧改外层、hover 与落定动画改中层、
 * 视觉全在内层。这个分层定下来之前不要写任何动画代码 ——
 * 否则会出现"拖一下泡泡的缩放就没了"或"动画一播位置就跳"这类极难查的问题。
 *
 * 🔴 落定动画用 WAAPI 且 **fill 必须留空**：fill: 'both' 会让动画的最终值
 *    一直压住 hover 的 transform，动画结束后悬停就永久失效（阶段 2 踩过）。
 *
 * 另一条：**尺寸只在创建时写一次**（width/height/margin），之后每帧只改 transform。
 * 逐帧改宽高会触发布局重算，几百个泡泡直接掉帧。
 */

import type { Body } from '../physics/force';
import { FONT_SIZE, lineHeight, radiusOfCached, heartRadiusOf } from '../text';

/** Nine space identities, brightened for the user-approved dark universe. */
const HUE_ACCENTS = [
  '#B7AAFF', '#75DCC8', '#8CBDFF', '#F2A68B', '#E7C57F',
  '#EB9FC8', '#A4D69A', '#F09AAB', '#B1BFDA',
];

const HUE_SOFTS = [
  '#24223E', '#162E31', '#1A2942', '#342A33', '#322E2E',
  '#33233B', '#233132', '#342338', '#232B3B',
];

export function hueAccent(hue: number): string {
  return HUE_ACCENTS[((hue % 9) + 9) % 9];
}

export function hueSoft(hue: number): string {
  return HUE_SOFTS[((hue % 9) + 9) % 9];
}

/**
 * 把某个空间的主色写进 world 容器，让里面所有泡泡继承（CSS 变量天然继承）。
 *
 * 🔴 同时写到 documentElement(:root)：飞入的**影子泡泡**和**涟漪**挂在 body 下的
 *    固定图层里（不在 #world 内），不这样的话它们拿不到当前空间的主色，
 *    交接瞬间会从紫色（:root 默认值）跳到该空间的颜色。
 */
export function applyAccent(worldEl: HTMLElement, hue: number): void {
  const accent = hueAccent(hue);
  const soft = hueSoft(hue);
  const line = `${accent}55`;

  worldEl.style.setProperty('--accent', accent);
  worldEl.style.setProperty('--accent-soft', soft);
  worldEl.style.setProperty('--accent-line', line);

  const root = document.documentElement;
  root.style.setProperty('--accent', accent);
  root.style.setProperty('--accent-soft', soft);
  root.style.setProperty('--accent-line', line);
}

export interface BubbleHandlers {
  onClick?(view: BubbleView, event: Event): void;
  onDblClick?(view: BubbleView, event: Event): void;
}

/**
 * 一个泡泡的 DOM 视图。**三层，每层只管一件事**：
 *
 *   .bubble        ← 位置。力导向每帧写 `translate3d(x, y, 0)`
 *     .bubble-scale← 悬停 / 选中缩放，写 `scale(...)`
 *       .bubble-inner ← 视觉（底色、描边、圆角）+ 入场动画
 *
 * 🔴 为什么必须是三层而不是两层：
 *    入场动画用 `animation-fill-mode: both` 时，动画的最终值会**压过**
 *    普通 CSS 声明（动画在层叠里优先级更高）。如果悬停缩放和入场动画
 *    写在同一个元素上，动画结束后 hover 就永远失效了。
 *    分开两层后，入场动画在结束后被移除，hover 才生效。
 *    代价是每个泡泡多一个 div —— 这点开销远小于"hover 突然不灵"的排查成本。
 */
export interface BubbleView {
  /** 外层：只负责位置。 */
  el: HTMLDivElement;
  /** 中间层：只负责缩放。 */
  scale: HTMLDivElement;
  /** 内层：视觉。 */
  inner: HTMLDivElement;
  /** 文字容器。搜索高亮要往里塞 <mark>，所以要暴露出来。 */
  label: HTMLElement;
  body: Body;
  /** 这个泡泡上的文本。放大动画与搜索都要用它，省得回头去 DOM 里捞。 */
  text: string;
  destroy(): void;
}

function makeShell(): { el: HTMLDivElement; scale: HTMLDivElement; inner: HTMLDivElement } {
  const el = document.createElement('div');
  const scale = document.createElement('div');
  const inner = document.createElement('div');

  el.className = 'bubble';
  scale.className = 'bubble-scale';
  inner.className = 'bubble-inner';

  // 🔴 用负 margin 把元素中心对齐到 (0,0)，这样外层 transform 可以直接写
  //    世界坐标，不用每帧减去半径。margin 只在创建时写一次。
  el.style.position = 'absolute';
  el.style.left = '0';
  el.style.top = '0';

  scale.appendChild(inner);
  el.appendChild(scale);
  return { el, scale, inner };
}

/** 标记"这个泡泡正在被拖拽"，用来关掉 hover 效果（否则会一边拖一边胀大）。 */
export function setDragging(view: BubbleView, dragging: boolean): void {
  view.el.classList.toggle('bubble--dragging', dragging);
}

/**
 * 搜索命中态。
 *
 * 🔴 未命中只是加 `bubble--dim`（CSS 里只改 opacity），**绝不把泡泡移走或删掉** ——
 *    筛选会让星云从"一片海"缩成"几个点"，而版图本身就是这个产品的意义。
 */
export function setSearchState(view: BubbleView, hit: boolean): void {
  view.el.classList.toggle('bubble--hit', hit);
  view.el.classList.toggle('bubble--dim', !hit);
}

/** 清空搜索状态（恢复全貌）。 */
export function clearSearchState(view: BubbleView): void {
  view.el.classList.remove('bubble--hit', 'bubble--dim');
}

/** 暂时隐藏 / 显示一个泡泡（放大到中央时用）。 */
export function setHidden(view: BubbleView, hidden: boolean): void {
  view.el.classList.toggle('bubble--hidden', hidden);
}

function bindHandlers(view: BubbleView, handlers: BubbleHandlers): () => void {
  const onClick = (e: Event): void => handlers.onClick?.(view, e);
  const onDblClick = (e: Event): void => handlers.onDblClick?.(view, e);

  if (handlers.onClick) view.el.addEventListener('click', onClick);
  if (handlers.onDblClick) view.el.addEventListener('dblclick', onDblClick);

  return () => {
    view.el.removeEventListener('click', onClick);
    view.el.removeEventListener('dblclick', onDblClick);
  };
}

/** 算泡泡里能放下几行，超出部分用 line-clamp 截掉（长文本的兜底）。 */
function fitLines(ry: number): number {
  const usable = 2 * ry - 12;
  return Math.max(1, Math.floor(usable / lineHeight()));
}

/**
 * 创建一个"想法泡泡"。
 *
 * 尺寸由文本推导（radiusOfCached），**不存进数据模型** —— 文本是唯一真相来源，
 * 所以以后改排版规则时，历史数据一个字节都不用动。
 */
export function createIdeaBubble(
  body: Body,
  text: string,
  handlers: BubbleHandlers = {},
): BubbleView {
  const { el, scale, inner } = makeShell();
  const { rx, ry } = radiusOfCached(text);

  body.rx = rx;
  body.ry = ry;

  el.classList.add('bubble--idea');
  el.dataset.id = body.id;
  el.style.width = `${rx * 2}px`;
  el.style.height = `${ry * 2}px`;
  el.style.marginLeft = `${-rx}px`;
  el.style.marginTop = `${-ry}px`;

  const label = document.createElement('div');
  label.className = 'bubble-label';
  // 🔴 一律 textContent：这里渲染的是用户自己输入的文本，用 innerHTML 等于执行用户输入
  label.textContent = text;
  label.style.fontSize = `calc(${FONT_SIZE}px - var(--bubble-font-reduction, 0px))`;
  inner.style.setProperty('--lines', String(fitLines(ry)));
  inner.appendChild(label);

  const view: BubbleView = { el, scale, inner, label, body, text, destroy: () => {} };
  const unbind = bindHandlers(view, handlers);
  view.destroy = () => {
    unbind();
    el.remove();
  };

  return view;
}

/**
 * 创建一个"心泡泡"。
 *
 * 与想法泡泡的三处差别：
 *  - 始终正圆（不走椭圆）—— 它是唯一的锚点，正圆才像球心
 *  - 用空间的主色（--accent），一眼看出这是哪个空间
 *  - 名字单行 + 省略号，不换行
 */
export function createHeartBubble(
  body: Body,
  name: string,
  handlers: BubbleHandlers = {},
): BubbleView {
  const { el, scale, inner } = makeShell();
  const r = heartRadiusOf(name);

  body.rx = r;
  body.ry = r;
  body.fixed = true;

  el.classList.add('bubble--heart');
  el.dataset.id = body.id;
  el.dataset.role = 'heart';
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  el.setAttribute('aria-label', `${name} · 打开空间星图`);
  el.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); el.click(); }
  });
  el.style.width = `${r * 2}px`;
  el.style.height = `${r * 2}px`;
  el.style.marginLeft = `${-r}px`;
  el.style.marginTop = `${-r}px`;

  const label = document.createElement('div');
  label.className = 'bubble-label bubble-label--single';
  label.textContent = name;

  const hint = document.createElement('div');
  hint.className = 'bubble-hint';
  hint.textContent = '空间星图';

  inner.appendChild(label);
  inner.appendChild(hint);

  // 心泡泡的 text 就是空间名（放大动画理论上不会作用在它身上，但保持一致）
  const view: BubbleView = { el, scale, inner, label, body, text: name, destroy: () => {} };
  const unbind = bindHandlers(view, handlers);
  view.destroy = () => {
    unbind();
    el.remove();
  };

  return view;
}

/**
 * 把泡泡的位置写进 DOM。**每帧只改这一个属性。**
 * 世界坐标即元素中心（负 margin 已经把中心对齐好了）。
 */
export function writePosition(view: BubbleView): void {
  const { x, y } = view.body;
  view.el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
}

/** 切换"已锁定"的外观。锁定 = 位置由你定，力场不再推动它。 */
export function setPinned(view: BubbleView, pinned: boolean): void {
  view.el.classList.toggle('bubble--pinned', pinned);
}

/** 更新心跳泡的文字（重命名后调用）。 */
export function updateHeartLabel(view: BubbleView, name: string): void {
  view.text = name;
  view.el.setAttribute('aria-label', `${name} · 打开空间星图`);
  const label = view.inner.querySelector('.bubble-label');
  if (label) label.textContent = name;

  const r = heartRadiusOf(name);
  view.body.rx = r;
  view.body.ry = r;
  view.el.style.width = `${r * 2}px`;
  view.el.style.height = `${r * 2}px`;
  view.el.style.marginLeft = `${-r}px`;
  view.el.style.marginTop = `${-r}px`;
}
