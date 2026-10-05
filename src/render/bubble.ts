/**
 * 泡泡的 DOM 渲染。
 *
 * 🔴 三层元素铁律（整个项目的动画地基）：
 *
 *     .bubble        ← 位置，力导向每帧写 `translate3d(x, y, 0)`
 *       .bubble-scale← 悬停 / 选中缩放，写 `scale(...)`
 *         .bubble-inner ← 视觉与入场动画
 *
 * **绝不能让两个东西抢同一个 transform 属性**。力导向每帧改外层、hover 改中层、
 * 入场动画改内层，各写各的。这个分层定下来之前不要写任何动画代码 ——
 * 否则会出现"拖一下泡泡的缩放就没了"或"动画一播位置就跳"这类极难查的问题。
 *
 * 另一条：**尺寸只在创建时写一次**（width/height/margin），之后每帧只改 transform。
 * 逐帧改宽高会触发布局重算，几百个泡泡直接掉帧。
 */

import type { Body } from '../physics/force';
import { FONT_SIZE, lineHeight, radiusOfCached, heartRadiusOf } from '../text';

/** 9 个色板（PROJECT-SPEC.md §4.3）。主色用于描边/心泡泡，浅色用于底色。 */
const HUE_ACCENTS = [
  '#534AB7', // 0 紫
  '#0F6E56', // 1 青
  '#185FA5', // 2 蓝
  '#993C1D', // 3 珊瑚
  '#854F0B', // 4 琥珀
  '#993556', // 5 粉
  '#3B6D11', // 6 绿
  '#A32D2D', // 7 红
  '#5F5E5A', // 8 灰
];

const HUE_SOFTS = [
  '#EEEDFE',
  '#E1F5EE',
  '#E6F1FB',
  '#FAECE7',
  '#FAEEDA',
  '#FBEAF0',
  '#EAF3DE',
  '#FCEBEB',
  '#F1EFE8',
];

export function hueAccent(hue: number): string {
  return HUE_ACCENTS[((hue % 9) + 9) % 9];
}

export function hueSoft(hue: number): string {
  return HUE_SOFTS[((hue % 9) + 9) % 9];
}

/** 把某个空间的主色写进 world 容器，让里面所有泡泡继承（CSS 变量天然继承）。 */
export function applyAccent(worldEl: HTMLElement, hue: number): void {
  const accent = hueAccent(hue);
  worldEl.style.setProperty('--accent', accent);
  worldEl.style.setProperty('--accent-soft', hueSoft(hue));
  // 8 位 hex 的末两位是 alpha：用于"看得见但不抢眼"的描边
  worldEl.style.setProperty('--accent-line', `${accent}55`);
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
  /** 内层：视觉与入场动画。 */
  inner: HTMLDivElement;
  body: Body;
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

/** 播一次入场动画。动画结束后把类摘掉，否则会压住 hover 的 scale。 */
function markEntering(inner: HTMLDivElement): void {
  inner.classList.add('is-entering');
  inner.addEventListener(
    'animationend',
    () => {
      inner.classList.remove('is-entering');
    },
    { once: true },
  );
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
  label.style.fontSize = `${FONT_SIZE}px`;
  inner.style.setProperty('--lines', String(fitLines(ry)));
  inner.appendChild(label);
  markEntering(inner);

  const view: BubbleView = { el, scale, inner, body, destroy: () => {} };
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
  el.style.width = `${r * 2}px`;
  el.style.height = `${r * 2}px`;
  el.style.marginLeft = `${-r}px`;
  el.style.marginTop = `${-r}px`;

  const label = document.createElement('div');
  label.className = 'bubble-label bubble-label--single';
  label.textContent = name;

  const hint = document.createElement('div');
  hint.className = 'bubble-hint';
  hint.textContent = '切换空间';

  inner.appendChild(label);
  inner.appendChild(hint);
  markEntering(inner);

  const view: BubbleView = { el, scale, inner, body, destroy: () => {} };
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

/** 更新心跳泡的文字（重命名后调用）。 */
export function updateHeartLabel(view: BubbleView, name: string): void {
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
