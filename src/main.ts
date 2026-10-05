/**
 * 启动编排 —— 全项目唯一的胶水层。
 *
 * 启动顺序（刻意的）：
 *   1. 注入字体栈（必须在任何测量之前）
 *   2. 打开 IndexedDB；顺手清一次过期回收站
 *   3. 读空间 → 决定"当前在哪个"
 *   4. **立即渲染本地泡泡（0 延迟）** ← 绝不"等同步完再显示"（同步在阶段 6）
 *   5. 唤醒力导向，跑 rAF
 *
 * 阶段 2 的范围：多空间 + 心泡泡 + 切换浮层 + 回收站 + 力导向引擎。
 * 拖拽、锁定、飞入动画、搜索分别属于阶段 3/4/5，这里刻意不做。
 */

import { mountDrag, type DragHandle } from './interact/drag';
import { ForceField, type Body } from './physics/force';
import {
  applyAccent,
  createHeartBubble,
  createIdeaBubble,
  setDragging,
  setHidden,
  setPinned,
  updateHeartLabel,
  writePosition,
  type BubbleView,
} from './render/bubble';
import { flyIn, getLastFlight, playPop } from './render/flyIn';
import { getLastZoom, openZoom, type ZoomHandle } from './render/zoom';
import { makeRng, newId } from './rng';
import { NebulaStore } from './store';
import { installFontStackVar, radiusOfCached } from './text';
import { mountInput, type NoticeKind } from './ui/input';
import { SpaceLayer } from './ui/spaceLayer';
import { TrashLayer } from './ui/trash';
import {
  fitToContent,
  identityViewport,
  screenToWorld,
  worldToScreen,
  worldTransform,
  zoomAt,
} from './view';
import {
  HEART_ORIGIN,
  SPAWN_MAX_RADIUS,
  SPAWN_MIN_RADIUS,
  type Idea,
  type Space,
  type Viewport,
} from './types';

/** 心泡泡的 body id。带前缀是为了永不和 UUID 撞上。 */
const HEART_ID = '__heart__';

/**
 * 单击与双击的判别窗口（ms）。
 * 单击（放大）要等它、双击（锁定）要在这个窗口内把单击取消掉。见 handleTap 的注释。
 */
const DOUBLE_CLICK_GUARD_MS = 220;

function must<T extends HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`页面缺少必需的元素：${selector}`);
  return el;
}

function makeNotice(el: HTMLElement) {
  return (message: string, kind: NoticeKind = 'info'): void => {
    el.textContent = message;
    el.dataset.kind = kind;
    if (message === '') delete el.dataset.kind;
  };
}

/**
 * 由想法 id 推导一个**确定性的**落点。
 *
 * 🔴 用 id 做种子而不是 Math.random：
 *    同一台设备刷新、和换一台设备打开，同一条想法都会落在同一个位置。
 *    拖动之前，星云的样子就是可复现的 —— 这是"位置持久化"能成立的前提。
 *
 * 落在圆环 [SPAWN_MIN_RADIUS, SPAWN_MAX_RADIUS] 内（面积均匀）：
 * 太近会被心泡泡盖住，太远会飞到看不见的地方。
 */
function spawnPointFor(ideaId: string): { x: number; y: number } {
  const rng = makeRng(`spawn:${ideaId}`);
  const angle = rng.range(0, Math.PI * 2);
  const min2 = SPAWN_MIN_RADIUS * SPAWN_MIN_RADIUS;
  const max2 = SPAWN_MAX_RADIUS * SPAWN_MAX_RADIUS;
  // 半径要开平方才是面积均匀；否则会挤在内圈
  const radius = Math.sqrt(min2 + rng.next() * (max2 - min2));
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

class App {
  private readonly store = new NebulaStore();
  private readonly field = new ForceField();

  private readonly stage: HTMLElement;
  private readonly world: HTMLElement;
  private readonly spaceNameEl: HTMLElement;
  private readonly spaceCountEl: HTMLElement;
  private readonly inputEl: HTMLTextAreaElement;
  private readonly notice: (m: string, k?: NoticeKind) => void;

  private readonly spaceLayer: SpaceLayer;
  private readonly trashLayer: TrashLayer;

  private spaces: Space[] = [];
  private current: Space | null = null;

  /** ideaId → 泡泡 DOM */
  private readonly views = new Map<string, BubbleView>();
  private heartView: BubbleView | null = null;
  private heartBody: Body | null = null;

  private viewport: Viewport = identityViewport();
  private rafId = 0;
  private frameIndex = 0;
  private viewportSaveTimer = 0;

  private drag: DragHandle | null = null;

  /** 当前打开的放大态。同一时刻只允许一个。 */
  private zoom: ZoomHandle | null = null;

  /**
   * 拖拽过、但还没把最终坐标写回数据库的 idea。
   * 值是该位置的"被放下时刻"（写进 movedAt，不是写入时刻 —— 两者差几百毫秒，
   * 但 movedAt 是给同步合并做 LWW 比较用的，越接近真实变化时刻越准）。
   */
  private readonly pendingPosition = new Map<string, number>();
  private positionSaveTimer = 0;

  /** 待处理的单击（等双击判别窗口过去才真正放大）。 */
  private tapTimer = 0;

  constructor() {
    this.stage = must<HTMLElement>('#stage');
    this.world = must<HTMLElement>('#world');
    this.spaceNameEl = must<HTMLElement>('#space-name');
    this.spaceCountEl = must<HTMLElement>('#space-count');
    this.inputEl = must<HTMLTextAreaElement>('#input');
    const noticeEl = must<HTMLElement>('#notice');
    this.notice = makeNotice(noticeEl);

    this.spaceLayer = new SpaceLayer(must<HTMLElement>('#space-layer'), {
      onSwitch: (id) => void this.switchSpace(id),
      onRename: (id, name) => void this.renameSpace(id, name),
      onCreate: () => void this.createSpace(),
      onOpenTrash: () => void this.openTrash(),
      onDelete: (id) => void this.deleteSpace(id),
    });

    this.trashLayer = new TrashLayer(must<HTMLElement>('#trash-layer'), {
      onRestore: (id) => void this.restoreTrash(id),
      onEmpty: () => void this.emptyTrash(),
    });

    this.bindViewportGestures();
    this.mountDragController();
    this.bindLifecycleFlush();
  }

  // ── 拖拽 ──────────────────────────────────────────────

  private mountDragController(): void {
    this.drag = mountDrag(this.stage, {
      hitTest: (target) => {
        const el = target instanceof Element ? (target.closest('.bubble') as HTMLElement | null) : null;
        const id = el?.dataset.id;
        if (!id) return null;
        if (id === HEART_ID) return this.heartBody;
        return this.views.get(id)?.body ?? null;
      },

      toWorld: (clientX, clientY) => {
        const rect = this.stage.getBoundingClientRect();
        return screenToWorld(this.viewport, { x: clientX - rect.left, y: clientY - rect.top });
      },

      onDragStart: (body) => {
        // 速度清零：不然上一次的甩出速度会叠在这一次的手势上
        body.vx = 0;
        body.vy = 0;
        // 🔴 关掉这个泡泡的 hover 效果，否则拖的时候它会一直胀大
        const view = this.views.get(body.id);
        if (view) setDragging(view, true);
        this.field.wake(0.35);
        this.startLoop();
      },

      onDragMove: () => {
        // 持续唤醒：让被"犁开"的邻居及时让位，观感上像拖着一颗球划过水面
        this.field.wake(0.35);
        this.startLoop();
      },

      onDrop: (body, velocity) => {
        const view = this.views.get(body.id);
        if (view) setDragging(view, false);
        // 🔴 把松手那一刻的手速交给引擎 —— 它不会硬停，会"飘一点"再被力场拉住
        body.vx = velocity.x;
        body.vy = velocity.y;
        this.field.wake(0.5);
        this.startLoop();
        this.schedulePositionSave(body.id, Date.now());
      },

      onTap: (body, at) => {
        const view = this.views.get(body.id);
        if (view) this.handleTap(view, at);
      },
    });
  }

  /**
   * 单击泡泡。
   *
   * 🔴 这里必须**延迟 220ms 再放大**，因为单击（放大）和双击（锁定）落在同一个元素上，
   *    天然冲突：如果单击立刻打开放大浮层，第二次点击就会打在浮层的遮罩上，
   *    dblclick 永远收不到 —— 表现是"双击锁定失灵"（阶段 4 实测踩到）。
   *    延迟这段时间用来等"是不是双击"。
   *
   *    代价是放大有 220ms 的延迟。取舍：锁定是个低频动作，但双击一旦失灵就是彻底坏掉，
   *    所以宁可让放大稍钝一点。
   */
  private handleTap(view: BubbleView, at: { x: number; y: number }): void {
    window.clearTimeout(this.tapTimer);
    this.tapTimer = window.setTimeout(() => {
      this.tapTimer = 0;
      this.zoomToCenter(view, at);
    }, DOUBLE_CLICK_GUARD_MS);
  }

  /** 双击泡泡 → 切换锁定。同时取消那次待处理的单击。 */
  private handleDblClick(view: BubbleView): void {
    window.clearTimeout(this.tapTimer);
    this.tapTimer = 0;
    this.togglePin(view);
  }

  // ── 放大到中央（FLIP）────────────────────────────────

  /**
   * 点一个泡泡 → 放大到屏幕中央。
   *
   * 做法是**克隆**而不是直接动真泡泡：真泡泡住在被 translate+scale 变换过的 #world 里，
   * 把它拖出来做 FLIP 会先经历一次坐标系跳变，而且它每帧还被力导向写 transform。
   * 克隆到 body 下的固定图层里动画，真泡泡只暂时隐藏，收回时原地复活、位置分毫不动。
   */
  private zoomToCenter(view: BubbleView, pointer: { x: number; y: number }): void {
    if (this.zoom) return; // 已经有一个开着，先让它收

    const domRect = view.el.getBoundingClientRect();
    const srcRect = { x: domRect.left, y: domRect.top, w: domRect.width, h: domRect.height };
    setHidden(view, true);

    this.zoom = openZoom({
      text: view.text,
      srcRect,
      pointer,
      onClose: () => {
        setHidden(view, false);
        this.zoom = null;
      },
    });
  }

  /** 关掉放大态（切空间、重命名等会改动布局的操作前调用）。 */
  private closeZoom(): void {
    this.zoom?.close();
  }

  /** 记下"这个泡泡被拖过"，等星云停稳再落库。 */
  private schedulePositionSave(ideaId: string, movedAt: number): void {
    this.pendingPosition.set(ideaId, movedAt);
    this.armPositionFlush();
  }

  private armPositionFlush(): void {
    window.clearTimeout(this.positionSaveTimer);
    this.positionSaveTimer = window.setTimeout(() => void this.flushPositions(), 250);
  }

  /**
   * 把待保存的位置写回 IndexedDB。**默认只在星云停稳之后才写。**
   *
   * 🔴 为什么不能松手就写：松手后泡泡还会滑一段（这是刻意的"飘一点"）。
   *    如果那时就落库，下次打开它会停在半路，而不是你看着它停下的地方。
   *    实测踩过：500ms 防抖写下的坐标比最终静止位置差 9 个单位。
   *
   * 还没停稳就不写，重新排一次检查；实在等不到（用户一直在操作），
   * 由 pagehide / 切空间 / 关浮层时以 force = true 强制写。
   */
  private async flushPositions(force = false): Promise<void> {
    if (this.pendingPosition.size === 0) return;
    window.clearTimeout(this.positionSaveTimer);

    if (!force && this.field.tier() !== 'asleep') {
      this.armPositionFlush();
      return;
    }

    const pending = [...this.pendingPosition.entries()];
    this.pendingPosition.clear();

    for (const [ideaId, movedAt] of pending) {
      const body = this.views.get(ideaId)?.body;
      if (!body) continue; // 已经切了空间，这次的坐标作废（切空间前会先 flush）

      const idea = await this.store.getIdea(ideaId);
      if (!idea) continue;

      await this.store.putIdea({
        ...idea,
        x: body.x,
        y: body.y,
        // 🔴 只动位置就只更新 movedAt。updatedAt 留给文本/归档 ——
        //    两者分离是阶段 6 同步合并的前提：否则拖一下泡泡
        //    会用本地时间戳把另一台设备上刚改的文本压掉。
        movedAt,
      });
    }
  }

  private async savePinned(ideaId: string, pinned: boolean): Promise<void> {
    const idea = await this.store.getIdea(ideaId);
    if (!idea) return;
    await this.store.putIdea({
      ...idea,
      pinned: pinned ? 1 : 0,
      // 锁定是"设置"而不是"移动"，所以走 updatedAt
      updatedAt: Date.now(),
    });
  }

  /** 双击泡泡：切换锁定。锁定的泡泡力场完全绕过它。 */
  private togglePin(view: BubbleView): void {
    const body = view.body;
    if (body.fixed) return; // 心泡泡本来就钉住，不需要也不能锁定

    body.pinned = !body.pinned;
    setPinned(view, body.pinned);

    this.field.wake(0.35);
    this.startLoop();
    void this.savePinned(body.id, body.pinned);

    this.notice(body.pinned ? '已锁定这个位置' : '已解锁，它会跟着星云流动', 'info');
  }

  /** 页面被藏起来 / 要关掉之前，把没落库的位置补上。 */
  private bindLifecycleFlush(): void {
    const flush = (): void => {
      void this.flushPositions(true);
      void this.saveViewportNow();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
  }

  // ── 启动 ──────────────────────────────────────────────

  async start(): Promise<void> {
    try {
      await this.store.open();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.notice(`打不开本地数据库：${message}`, 'error');
      return;
    }

    try {
      const purged = await this.store.purgeExpired();
      if (purged > 0) this.notice(`回收站有 ${purged} 项已到期，已清理`, 'info');
    } catch {
      // 清理失败不该挡住启动
    }

    this.spaces = await this.store.getAllSpaces();
    if (this.spaces.length === 0) {
      const first = await this.store.createSpace();
      await this.store.setLastSpaceId(first.id);
      this.spaces = [first];
    }

    await this.openSpace(await this.resolveCurrent());

    mountInput({
      el: this.inputEl,
      onNotice: this.notice,
      onSubmit: (text) => this.addIdea(text),
    });

    this.expose();
    this.bindSelfTest();
    this.inputEl.focus();
  }

  /** 自检按钮：把 store 层的真读写结果打印出来（阶段 1 起就有的验证工具）。 */
  private bindSelfTest(): void {
    const btn = must<HTMLButtonElement>('#selftest');
    const out = must<HTMLElement>('#selftest-out');

    btn.addEventListener('click', () => {
      out.textContent = '正在自检…';
      void this.selfTest().then((lines) => {
        out.textContent = lines.join('\n');
        const failed = lines.filter((l) => l.startsWith('[FAIL]')).length;
        this.notice(
          failed === 0 ? `自检通过（${lines.length} 项）` : `自检有 ${failed} 项失败`,
          failed === 0 ? 'info' : 'error',
        );
      });
    });
  }

  private async resolveCurrent(): Promise<Space> {
    const lastId = await this.store.getLastSpaceId();
    const remembered = lastId ? this.spaces.find((s) => s.id === lastId) : undefined;
    return remembered ?? this.spaces[0];
  }

  // ── 打开一个空间 ──────────────────────────────────────

  private async openSpace(space: Space, opts: { ignoreSaved?: boolean } = {}): Promise<void> {
    // 切空间会重建所有泡泡，放大态的克隆体会指向已销毁的源泡泡 —— 先收掉
    this.closeZoom();

    this.current = space;
    await this.store.setLastSpaceId(space.id);

    // 拆掉上一个空间的所有泡泡（只拆 DOM，数据不动）
    for (const view of this.views.values()) view.destroy();
    this.views.clear();
    this.heartView?.destroy();
    this.heartView = null;

    // 一个空间一个主色：写进 world 容器，里面所有泡泡通过 CSS 变量继承
    applyAccent(this.world, space.hue);

    // 心泡泡：钉在世界原点
    const heartBody: Body = {
      id: HEART_ID,
      spaceId: space.id,
      x: HEART_ORIGIN.x,
      y: HEART_ORIGIN.y,
      vx: 0,
      vy: 0,
      rx: 0,
      ry: 0,
      fixed: true,
      pinned: true,
      dragging: false,
    };
    this.heartBody = heartBody;

    this.heartView = createHeartBubble(heartBody, space.name, {
      onClick: () => this.openSpaceLayer(),
      // 双击心泡泡 = 直接进改名，省掉"点开浮层再双击"这一步
      onDblClick: () => this.openSpaceLayer(space.id),
    });
    this.world.appendChild(this.heartView.el);

    // 想法泡泡
    const ideas = await this.store.getIdeasBySpace(space.id);
    const bodies: Body[] = [heartBody];
    for (const idea of ideas) {
      const body = this.bodyFromIdea(idea);
      bodies.push(body);
      const view = createIdeaBubble(body, idea.text, {
        onDblClick: (v) => this.handleDblClick(v),
      });
      this.views.set(idea.id, view);
      this.world.appendChild(view.el);
    }

    // 🔴 力场的空间分区在这里登记：这个空间之后只和它自己的泡泡互相作用
    this.field.setActiveSpace(space.id);
    this.field.setSpaceBodies(space.id, bodies);

    // 首屏装配：错开一点点播"轻落定"，像星云自己聚拢起来，而不是"啪"地全出现。
    // 总错开量封顶 380ms —— 再长会让人等。
    if (this.heartView) playPop(this.heartView.scale, true, 0);
    let order = 1;
    for (const view of this.views.values()) {
      playPop(view.scale, true, Math.min(order * 18, 380));
      order++;
    }

    // 视口：有记住的就恢复；没有就以心泡泡为屏幕中心、1:1 起步
    const saved = opts.ignoreSaved ? undefined : await this.store.getViewport(space.id);
    this.viewport = saved ?? this.centeredViewport();
    this.applyViewport();

    this.field.wake(0.6);
    this.kick();
    this.writeAll();
    this.updateStatusLine();
  }

  /**
   * 由想法记录造一个 body。
   *
   * 🔴 (0, 0) 是心泡泡的保留位置，所以它同时可以当作"这条想法还没被摆过"的标记。
   *    这样就不用给数据模型加 `placed` 字段 —— 文本仍然是唯一真相来源。
   */
  private bodyFromIdea(idea: Idea): Body {
    let { x, y } = idea;
    if (x === 0 && y === 0) {
      const p = spawnPointFor(idea.id);
      x = p.x;
      y = p.y;
    }
    // 尺寸在这里就算好：飞入前要先知道它多大，才能判断落点会不会超出视野
    const { rx, ry } = radiusOfCached(idea.text);
    return {
      id: idea.id,
      spaceId: idea.spaceId,
      x,
      y,
      vx: 0,
      vy: 0,
      rx,
      ry,
      fixed: false,
      pinned: idea.pinned === 1,
      dragging: false,
    };
  }

  // ── 动画循环（三档降频）────────────────────────────────

  private kick(): void {
    this.field.wake(0.35);
    this.startLoop();
  }

  private startLoop(): void {
    if (this.rafId !== 0) return;
    this.rafId = requestAnimationFrame(this.loop);
  }

  /**
   * 🔴 三档降频：静止时把 rAF 彻底停掉，CPU 真的是 0，而不是"一直在跑只是幅度小"。
   *    手机上这一条决定了"开着网页放一晚上会不会掉电"。
   */
  private readonly loop = (): void => {
    this.frameIndex++;
    const tier = this.field.tier();

    if (tier === 'asleep') {
      this.rafId = 0;
      // 引擎停下来 ⇒ 泡泡停在了它最终该在的地方，这时候才把坐标写回数据库
      if (this.pendingPosition.size > 0) void this.flushPositions();
      return;
    }

    // 余温档：每 4 帧算一次，CPU 降到约 1/4，肉眼看不出来
    if (tier === 'full' || this.frameIndex % 4 === 0) {
      this.field.step();
      this.writeAll();
    }

    this.rafId = requestAnimationFrame(this.loop);
  };

  /** 把所有 body 的位置写进 DOM。只改 transform，不碰宽高。 */
  private writeAll(): void {
    for (const view of this.views.values()) writePosition(view);
    if (this.heartView) writePosition(this.heartView);
  }

  // ── 视口 ──────────────────────────────────────────────

  private applyViewport(): void {
    this.world.style.transform = worldTransform(this.viewport);
  }

  /**
   * 默认视口：**以心泡泡（世界原点）为屏幕中心，缩放 1:1**。
   *
   * 🔴 为什么默认不是"把全部泡泡塞进一屏"（fitToContent）：
   *    那样 8 条想法就要缩到 0.55、50 条要缩到 0.4，13px 的字会变成 5px，根本看不清。
   *    星云的用法是"以心泡泡为锚点往外探索"，不是一眼看全。
   *    "看全"这件事交给双击空白（fitAll），那是用户主动要求的动作。
   */
  private centeredViewport(): Viewport {
    const rect = this.stage.getBoundingClientRect();
    return { scale: 1, tx: rect.width / 2, ty: rect.height / 2 };
  }

  /**
   * 把某个泡泡拉进视野。
   *
   * 🔴 这是"不想错过任何想法"在视口上的落点：刚记下的东西必须看得见。
   *    刻意只做**最小必要的平移**，不改缩放 —— 用户放大看过某个角落之后再记一条，
   *    不该被强制拉回全景。
   */
  private ensureVisible(body: Body): void {
    const rect = this.stage.getBoundingClientRect();
    const margin = 28;
    const scale = this.viewport.scale;

    const screenX = body.x * scale + this.viewport.tx;
    const screenY = body.y * scale + this.viewport.ty;
    const halfW = body.rx * scale;
    const halfH = body.ry * scale;

    let dx = 0;
    let dy = 0;

    if (screenX - halfW < margin) dx = margin - (screenX - halfW);
    else if (screenX + halfW > rect.width - margin) dx = rect.width - margin - (screenX + halfW);

    if (screenY - halfH < margin) dy = margin - (screenY - halfH);
    else if (screenY + halfH > rect.height - margin) dy = rect.height - margin - (screenY + halfH);

    if (dx === 0 && dy === 0) return;

    this.viewport = { ...this.viewport, tx: this.viewport.tx + dx, ty: this.viewport.ty + dy };
    this.applyViewport();
    this.scheduleViewportSave();
  }

  private computeFit(): Viewport {
    const rect = this.stage.getBoundingClientRect();
    const points = this.field.activeBodies.map((b) => ({ x: b.x, y: b.y }));
    const pad = this.heartBody?.rx ?? 60;
    return fitToContent(points, pad, { w: rect.width, h: rect.height });
  }

  private fitAll(): void {
    this.viewport = this.computeFit();
    this.applyViewport();
    void this.saveViewportNow();
  }

  private scheduleViewportSave(): void {
    window.clearTimeout(this.viewportSaveTimer);
    this.viewportSaveTimer = window.setTimeout(() => void this.saveViewportNow(), 400);
  }

  private async saveViewportNow(): Promise<void> {
    if (!this.current) return;
    await this.store.setViewport(this.current.id, this.viewport);
  }

  /** 滚轮缩放 + 拖空白平移 + 双击空白回全貌。手感的精细打磨在阶段 4。 */
  private bindViewportGestures(): void {
    this.stage.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const rect = this.stage.getBoundingClientRect();
        const anchor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        const factor = Math.exp(-e.deltaY * 0.0016);
        this.viewport = zoomAt(this.viewport, anchor, factor);
        this.applyViewport();
        this.scheduleViewportSave();
      },
      { passive: false },
    );

    let panning = false;
    let lastX = 0;
    let lastY = 0;
    let moved = false;

    this.stage.addEventListener('pointerdown', (e) => {
      // 只在真正的空白处起拖（#world 是 0 尺寸容器，背景点击的 target 就是 #stage）
      if (e.target !== this.stage) return;
      panning = true;
      moved = false;
      lastX = e.clientX;
      lastY = e.clientY;
      this.stage.setPointerCapture(e.pointerId);
    });

    this.stage.addEventListener('pointermove', (e) => {
      if (!panning) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      if (dx !== 0 || dy !== 0) moved = true;
      lastX = e.clientX;
      lastY = e.clientY;
      this.viewport = { ...this.viewport, tx: this.viewport.tx + dx, ty: this.viewport.ty + dy };
      this.applyViewport();
    });

    const endPan = (e: PointerEvent): void => {
      if (!panning) return;
      panning = false;
      try {
        this.stage.releasePointerCapture(e.pointerId);
      } catch {
        /* 可能已经释放 */
      }
      if (moved) this.scheduleViewportSave();
    };
    this.stage.addEventListener('pointerup', endPan);
    this.stage.addEventListener('pointercancel', endPan);

    this.stage.addEventListener('dblclick', (e) => {
      if (e.target !== this.stage) return;
      this.fitAll();
    });
  }

  // ── 空间操作 ──────────────────────────────────────────

  private openSpaceLayer(focusRename?: string): void {
    // 两个浮层互斥：否则它们会叠在一起，上层的遮罩会挡住下层的所有点击
    this.trashLayer.close();
    this.spaceLayer.show(this.spaces, this.current?.id ?? '', focusRename);
  }

  private async switchSpace(spaceId: string): Promise<void> {
    const space = this.spaces.find((s) => s.id === spaceId);
    if (!space) return;
    if (space.id === this.current?.id) {
      this.spaceLayer.close();
      return;
    }
    // 切空间前先把拖拽的坐标落库 —— 切完之后 body 就没了，那次拖拽会白费
    await this.flushPositions(true);
    await this.saveViewportNow();
    this.spaceLayer.close();
    await this.openSpace(space);
  }

  /**
   * 新建空间。
   *
   * 决策（用户确认过）：**新建后直接切过去，并让心泡泡进入改名态**。
   * 理由：用户此刻的注意力就在新空间上；把"建空间"和"起名字"合成一个动作，
   * 不用再去找改名入口。
   */
  private async createSpace(): Promise<void> {
    const space = await this.store.createSpace();
    this.spaces = await this.store.getAllSpaces();
    await this.store.setLastSpaceId(space.id);
    await this.openSpace(space, { ignoreSaved: true });
    this.spaceLayer.show(this.spaces, space.id, space.id);
    this.notice('新建了空间，给它起个名字', 'info');
  }

  private async renameSpace(spaceId: string, name: string): Promise<void> {
    const updated = await this.store.renameSpace(spaceId, name);
    if (!updated) return;

    this.spaces = await this.store.getAllSpaces();

    if (this.current?.id === spaceId) {
      this.current = updated;
      if (this.heartView) updateHeartLabel(this.heartView, name);
      // 名字变了 ⇒ 心泡泡的半径变了 ⇒ 唤醒布局，让周围泡泡重新让位
      this.field.wake(0.3);
      this.startLoop();
      this.writeAll();
      this.updateStatusLine();
    }

    this.spaceLayer.render(this.spaces);
  }

  private async deleteSpace(spaceId: string): Promise<void> {
    const space = this.spaces.find((s) => s.id === spaceId);
    if (!space) return;

    if (this.spaces.length <= 1) {
      this.notice('至少要留一个空间', 'warn');
      return;
    }

    const count = await this.store.countIdeasBySpace(spaceId);
    const confirmed = window.confirm(
      count > 0
        ? `「${space.name}」里有 ${count} 条想法，会一起进回收站。\n30 天内都能恢复。确定删除？`
        : `确定删除空间「${space.name}」？它会进回收站，30 天内可恢复。`,
    );
    if (!confirmed) return;

    await this.store.deleteSpaceToTrash(spaceId);
    this.spaces = await this.store.getAllSpaces();

    if (this.current?.id === spaceId) {
      await this.openSpace(this.spaces[0], { ignoreSaved: true });
    }
    this.spaceLayer.render(this.spaces);
    this.notice(`「${space.name}」已进回收站，30 天内可恢复`, 'info');
  }

  // ── 回收站 ────────────────────────────────────────────

  private async openTrash(): Promise<void> {
    // 🔴 打开回收站时也扫一次过期（另一处是启动时）——
    //    启动时用户在别的空间，可能永远不打开回收站
    await this.store.purgeExpired();
    const entries = await this.store.getAllTrash();
    this.spaceLayer.close();
    this.trashLayer.show(entries);
  }

  private async restoreTrash(trashId: string): Promise<void> {
    const restored = await this.store.restoreFromTrash(trashId);
    if (!restored) return;

    this.spaces = await this.store.getAllSpaces();
    this.trashLayer.render(await this.store.getAllTrash());
    this.spaceLayer.render(this.spaces);
    this.notice(`已恢复「${restored.name}」`, 'info');
  }

  private async emptyTrash(): Promise<void> {
    const entries = await this.store.getAllTrash();
    if (entries.length === 0) return;

    const confirmed = window.confirm(
      `回收站里的 ${entries.length} 项会被永久删除，无法恢复。确定？`,
    );
    if (!confirmed) return;

    await this.store.purgeAllTrash();
    this.trashLayer.render([]);
    this.notice('回收站已清空', 'info');
  }

  // ── 录入 ──────────────────────────────────────────────

  private async addIdea(text: string): Promise<void> {
    const space = this.current;
    if (!space) throw new Error('当前没有空间，无法记录');

    const id = newId();
    const spawn = spawnPointFor(id);
    const now = Date.now();

    const idea: Idea = {
      id,
      spaceId: space.id,
      text,
      createdAt: now,
      updatedAt: now,
      // 0 = 从未手动移动过。位置合并只看 movedAt，0 会让"这台设备摆的位置"
      // 在同步时不至于压过另一台设备上用户亲手拖过的位置（阶段 6 用）
      movedAt: 0,
      x: spawn.x,
      y: spawn.y,
      pinned: 0,
      linksAlwaysOn: 0,
      archived: 0,
    };

    // 🔴 本地写入 —— 这一步成功就算"记下来了"。
    //    飞入动画是锦上添花，绝不能挡在数据前面。
    await this.store.putIdea(idea);

    const body = this.bodyFromIdea(idea);

    // 刻意**不 await** 飞入：让输入框立刻空出来，用户能马上记下一条。
    // 真泡泡在飞完之后才出现（见 launchFlight）。
    void this.launchFlight(idea, body, space);

    this.updateStatusLine();
  }

  /**
   * 把一个刚记下的想法"扔"进星云。
   *
   * 🔴 顺序是刻意的：先落库（毫秒级）→ 再飞 → **飞完才把 body 交给力场、才建真泡泡**。
   *    为什么不在飞的过程中就交给力场：力场会立刻开始推它，
   *    于是"影子落在哪"和"泡泡出现在哪"就对不上了 —— 会看到一个明显的跳变。
   */
  private async launchFlight(idea: Idea, body: Body, space: Space): Promise<void> {
    // 飞之前先把落点拉进视野，否则影子会飞到屏幕外，人会以为没记上
    this.ensureVisible(body);

    const from = this.inputCenter();
    const to = this.worldToStageScreen(body.x, body.y);

    const record = await flyIn({ text: idea.text, from, to });

    // 飞入期间用户可能切了空间。那就先不建视图 —— 数据已经在库里，
    // 下次打开这个空间时它会自然出现在落点上。
    if (this.current?.id !== space.id) return;

    const view = createIdeaBubble(body, idea.text, {
      onDblClick: (v) => this.handleDblClick(v),
    });
    this.views.set(idea.id, view);
    this.world.appendChild(view.el);
    // 先摆到位再画，避免它从 (0,0) 弹到落点
    writePosition(view);

    // 🔴 就在这一刻记录真泡泡的位置：再晚一点力场就开始推它了，
    //    测出来的就变成"力场推了多远"而不是"交接有没有跳"
    const landedRect = view.el.getBoundingClientRect();
    record.landedAt = {
      x: landedRect.left + landedRect.width / 2,
      y: landedRect.top + landedRect.height / 2,
    };

    // 落定之后引擎才接手：它会立刻把周围泡泡推开，观感像"掉进池子里"
    const bodies = this.field.bodiesOf(space.id);
    bodies.push(body);
    this.field.setSpaceBodies(space.id, bodies);

    // "啵"
    playPop(view.scale);

    this.field.wake(0.45);
    this.startLoop();
    this.writeAll();
    this.updateStatusLine();
  }

  /** 输入框中心（视口坐标）—— 飞入的起点。 */
  private inputCenter(): { x: number; y: number } {
    const r = this.inputEl.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  /**
   * world 坐标 → 视口坐标。
   *
   * 🔴 需要这一步是因为 `offset-path` 的 path() 坐标是**视口绝对坐标**，
   *    而泡泡的位置是 world 坐标（还要经过 #stage 的偏移）。少加 rect.left/top
   *    整条弧线会偏掉一个画布位置，而且偏得很"像对的"，很难一眼看出来。
   */
  private worldToStageScreen(x: number, y: number): { x: number; y: number } {
    const rect = this.stage.getBoundingClientRect();
    const p = worldToScreen(this.viewport, { x, y });
    return { x: rect.left + p.x, y: rect.top + p.y };
  }

  private updateStatusLine(): void {
    if (!this.current) return;
    this.spaceNameEl.textContent = this.current.name;
    const count = this.field.activeBodies.filter((b) => b.id !== HEART_ID).length;
    this.spaceCountEl.textContent = `${count} 条`;
  }

  // ── 调试 / 验证出口 ───────────────────────────────────

  private expose(): void {
    const api = {
      store: this.store,
      field: this.field,
      spaces: () => this.spaces,
      current: () => this.current,
      switchSpace: (id: string) => this.switchSpace(id),
      createSpace: () => this.createSpace(),
      renameSpace: (id: string, name: string) => this.renameSpace(id, name),
      deleteSpace: (id: string) => this.deleteSpace(id),
      openTrash: () => this.openTrash(),
      restoreTrash: (id: string) => this.restoreTrash(id),
      emptyTrash: () => this.emptyTrash(),
      listIdeas: () => this.store.getAllIdeas(),
      positions: (spaceId: string) =>
        this.field.bodiesOf(spaceId).map((b) => ({ id: b.id, x: b.x, y: b.y })),

      /** 某个想法泡泡的运行时状态（拖拽 / 锁定的验证用）。 */
      bodyState: (ideaId: string) => {
        const b = this.views.get(ideaId)?.body;
        return b
          ? { x: b.x, y: b.y, vx: b.vx, vy: b.vy, pinned: b.pinned, dragging: b.dragging }
          : null;
      },

      /** 心泡泡的状态（验证"心泡泡永远拖不动"）。 */
      heartState: () => {
        const b = this.heartBody;
        return b ? { x: b.x, y: b.y, fixed: b.fixed, dragging: b.dragging } : null;
      },

      /** 数据库里的那条记录（验证位置持久化与 pinned 落库）。 */
      storedIdea: (ideaId: string) => this.store.getIdea(ideaId),

      isDragging: () => this.drag?.isDragging ?? false,

      /** 回全貌（双击空白走的就是这个）。 */
      fitAll: () => this.fitAll(),

      /** 上一次飞入的几何记录（验证"影子落点 == 真泡泡落点"）。 */
      lastFlight: () => getLastFlight(),

      /** 上一次放大的几何记录（验证形状没有歪、缩放锚点正确）。 */
      lastZoom: () => getLastZoom(),

      /** 当前是否有放大态开着。 */
      isZoomed: () => this.zoom !== null,

      /** 关掉放大态（测试用）。 */
      closeZoom: () => this.closeZoom(),

      /** 把待写回的位置立刻落库（测试与关页面前用）。 */
      flushPositions: () => this.flushPositions(true),
      /**
       * 空间隔离自检：逐个空间重建网格，统计"邻居里有多少属于别的空间"。
       * 正确实现下这个数必须是 0 —— 因为网格按空间分区，查到别的空间在结构上不可能。
       */
      debugIsolation: () => {
        const ids = this.field.spaceIds;
        let checked = 0;
        let crossSpace = 0;
        for (const sid of ids) {
          const bodies = this.field.bodiesOf(sid);
          this.field.setSpaceBodies(sid, bodies);
          for (const b of bodies) {
            for (const n of this.field.neighborsOf(b)) {
              checked++;
              if (n.spaceId !== b.spaceId) crossSpace++;
            }
          }
        }
        return { spaceIds: ids, neighborsChecked: checked, crossSpaceNeighbors: crossSpace };
      },
      selfTest: () => this.selfTest(),
    };

    (window as unknown as { __nebula?: unknown }).__nebula = api;
  }

  /** 浏览器内自检：真写、真读、真删，跑完不留痕迹。 */
  private async selfTest(): Promise<string[]> {
    const out: string[] = [];
    const check = (name: string, ok: boolean, extra = ''): void => {
      out.push(`[${ok ? 'OK  ' : 'FAIL'}] ${name}${extra ? '  ' + extra : ''}`);
    };

    const stamp = Date.now();
    try {
      // 空间：建 → 改名 → 删 → 恢复（含名字冲突）
      const s1 = await this.store.createSpace();
      check('新建空间', s1.deleted === 0 && s1.purgeAt === 0);
      check('新建空间色板在 0..8', s1.hue >= 0 && s1.hue <= 8, `hue=${s1.hue}`);

      const renamed = await this.store.renameSpace(s1.id, `自检-${stamp}`);
      check('重命名空间', renamed?.name === `自检-${stamp}`);

      // 塞一条想法进去，验证删除会把它一起带走
      const idea: Idea = {
        id: newId(),
        spaceId: s1.id,
        text: '自检用的一句话',
        createdAt: stamp,
        updatedAt: stamp,
        movedAt: 0,
        x: 12,
        y: -34,
        pinned: 0,
        linksAlwaysOn: 0,
        archived: 0,
      };
      await this.store.putIdea(idea);

      const entry = await this.store.deleteSpaceToTrash(s1.id);
      check('删除空间 → 进回收站', entry !== null && entry.kind === 'space');
      check('回收站快照含全部想法', (entry?.ideas?.length ?? 0) === 1);
      check('回收站 30 天后过期', (entry?.purgeAt ?? 0) > stamp + 29 * 86400000);

      const gone = await this.store.getSpace(s1.id);
      check('空间已标记删除（墓碑仍在）', gone?.deleted === 1);

      // 恢复时造一个同名空间，验证自动加后缀
      const clash = await this.store.createSpace();
      await this.store.renameSpace(clash.id, `自检-${stamp}`);
      const restored = await this.store.restoreFromTrash(s1.id);
      check('恢复空间', restored !== null && restored.deleted === 0);
      check('名字冲突自动加后缀', (restored?.name ?? '').includes('（恢复）'), restored?.name);

      const ideasBack = await this.store.getIdeasBySpace(s1.id);
      check('想法随空间一起恢复', ideasBack.length === 1);

      // 清理：只清掉自检自己造的，绝不碰用户回收站里真实的东西
      await this.store.purgeTrashEntry(s1.id);
      await this.store.hardDeleteIdea(idea.id);
      await this.store.hardDeleteSpace(s1.id);
      await this.store.hardDeleteSpace(clash.id);
      await this.store.deleteMeta(`viewport:${s1.id}`);

      // 隔离
      const iso = (
        window as unknown as {
          __nebula: { debugIsolation(): { crossSpaceNeighbors: number; spaceIds: string[] } };
        }
      ).__nebula.debugIsolation();
      check('空间隔离：无跨空间邻居', iso.crossSpaceNeighbors === 0, JSON.stringify(iso));
    } catch (err) {
      check('自检过程未抛异常', false, err instanceof Error ? err.message : String(err));
    }

    return out;
  }
}

// 🔴 第一件事就是注入字体栈：必须在任何测量发生之前，
//    否则 canvas 测量用的字体和页面渲染用的可能不一致，尺寸就错了。
installFontStackVar();

const app = new App();
void app.start();
