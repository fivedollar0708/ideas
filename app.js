"use strict";
(() => {
  // src/interact/drag.ts
  var DRAG_THRESHOLD_PX = 8;
  var TAP_MAX_MS = 300;
  var VELOCITY_WINDOW_MS = 90;
  var MAX_SAMPLES = 24;
  function classifyGesture(samples, thresholdPx = DRAG_THRESHOLD_PX, tapMaxMs = TAP_MAX_MS) {
    if (samples.length < 2) return "tap";
    const first = samples[0];
    const last = samples[samples.length - 1];
    const moved = Math.hypot(last.x - first.x, last.y - first.y);
    const elapsed = last.t - first.t;
    return moved > thresholdPx || elapsed > tapMaxMs ? "drag" : "tap";
  }
  function velocityFromSamples(samples, windowMs = VELOCITY_WINDOW_MS) {
    if (samples.length < 2) return { x: 0, y: 0 };
    const last = samples[samples.length - 1];
    let first = last;
    for (let i = samples.length - 1; i >= 0; i--) {
      if (last.t - samples[i].t > windowMs) break;
      first = samples[i];
    }
    const dt = last.t - first.t;
    if (dt <= 0) return { x: 0, y: 0 };
    return { x: (last.x - first.x) / dt * 1e3, y: (last.y - first.y) / dt * 1e3 };
  }
  function mountDrag(stage, hooks) {
    let active = null;
    let dragging = false;
    let activePointerId = -1;
    let grabDx = 0;
    let grabDy = 0;
    let samples = [];
    const pushSample = (e) => {
      const w = hooks.toWorld(e.clientX, e.clientY);
      const s = { x: w.x, y: w.y, t: performance.now() };
      samples.push(s);
      if (samples.length > MAX_SAMPLES) samples.shift();
      return s;
    };
    const onPointerDown = (e) => {
      if (hooks.blocked?.()) return;
      if (active) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      const hit = hooks.hitTest(e.target);
      if (!hit) return;
      if (hit.fixed) return;
      active = hit;
      dragging = false;
      activePointerId = e.pointerId;
      samples = [];
      const w = pushSample(e);
      grabDx = hit.x - w.x;
      grabDy = hit.y - w.y;
    };
    const onPointerMove = (e) => {
      if (!active || e.pointerId !== activePointerId) return;
      if (e.pointerType === "touch" && e.cancelable) e.preventDefault();
      const w = pushSample(e);
      if (!dragging) {
        const first = samples[0];
        if (Math.hypot(w.x - first.x, w.y - first.y) <= DRAG_THRESHOLD_PX) return;
        dragging = true;
        active.dragging = true;
        hooks.onDragStart(active);
      }
      active.x = w.x + grabDx;
      active.y = w.y + grabDy;
      hooks.onDragMove(active);
    };
    const finish = (e, cancelled) => {
      if (!active || e.pointerId !== activePointerId) return;
      const target = active;
      const wasDragging = dragging;
      active = null;
      dragging = false;
      activePointerId = -1;
      if (wasDragging) {
        target.dragging = false;
        const velocity = cancelled ? { x: 0, y: 0 } : velocityFromSamples(samples);
        hooks.onDrop(target, velocity);
        return;
      }
      if (!cancelled && classifyGesture(samples) === "tap") {
        hooks.onTap(target, { x: e.clientX, y: e.clientY });
      }
    };
    const onPointerUp = (e) => finish(e, false);
    const onPointerCancel = (e) => finish(e, true);
    stage.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    return {
      cancel: () => {
        if (active) finish({ pointerId: activePointerId }, true);
      },
      get isDragging() {
        return dragging;
      },
      destroy: () => {
        stage.removeEventListener("pointerdown", onPointerDown);
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerCancel);
      }
    };
  }

  // src/types.ts
  var MAX_TEXT = 280;
  var SPACE_NAME_DEFAULT = "\u672A\u547D\u540D";
  var TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1e3;
  var HEART_ORIGIN = { x: 0, y: 0 };
  var VIEW_SCALE_MIN = 0.25;
  var VIEW_SCALE_MAX = 3;
  var HEART_SCALE = 1.15;
  var HEART_MIN_RADIUS = 44;
  var HEART_MAX_RADIUS = 88;
  var HEART_NAME_MEASURE_MAX = 12;
  var SPACE_RESTORE_SUFFIX = "\uFF08\u6062\u590D\uFF09";
  var SPAWN_MIN_RADIUS = 200;
  var SPAWN_MAX_RADIUS = 320;

  // src/view.ts
  function identityViewport() {
    return { scale: 1, tx: 0, ty: 0 };
  }
  function worldToScreen(vp, p) {
    return { x: p.x * vp.scale + vp.tx, y: p.y * vp.scale + vp.ty };
  }
  function screenToWorld(vp, p) {
    return { x: (p.x - vp.tx) / vp.scale, y: (p.y - vp.ty) / vp.scale };
  }
  function worldTransform(vp) {
    return `translate3d(${vp.tx}px, ${vp.ty}px, 0) scale(${vp.scale})`;
  }
  function zoomAt(vp, anchorScreen, factor) {
    const scale = clampScale(vp.scale * factor);
    const applied = scale / vp.scale;
    return {
      scale,
      tx: anchorScreen.x - (anchorScreen.x - vp.tx) * applied,
      ty: anchorScreen.y - (anchorScreen.y - vp.ty) * applied
    };
  }
  function clampScale(scale) {
    return Math.min(VIEW_SCALE_MAX, Math.max(VIEW_SCALE_MIN, scale));
  }
  function fitToContent(points, radiusPad, viewportSize, padding = 64) {
    if (points.length === 0) {
      return { scale: 1, tx: viewportSize.w / 2, ty: viewportSize.h / 2 };
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of points) {
      if (p.x - radiusPad < minX) minX = p.x - radiusPad;
      if (p.y - radiusPad < minY) minY = p.y - radiusPad;
      if (p.x + radiusPad > maxX) maxX = p.x + radiusPad;
      if (p.y + radiusPad > maxY) maxY = p.y + radiusPad;
    }
    const contentW = Math.max(1, maxX - minX);
    const contentH = Math.max(1, maxY - minY);
    const availW = Math.max(1, viewportSize.w - padding * 2);
    const availH = Math.max(1, viewportSize.h - padding * 2);
    const fitted = Math.min(availW / contentW, availH / contentH);
    const scale = Math.max(VIEW_SCALE_MIN, Math.min(1, fitted));
    const centerWorld = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
    return {
      scale,
      tx: viewportSize.w / 2 - centerWorld.x * scale,
      ty: viewportSize.h / 2 - centerWorld.y * scale
    };
  }

  // src/interact/mobile.ts
  function keyboardShift(layoutBottom, height, offsetTop, scale) {
    return Math.abs(scale - 1) > 0.01 ? 0 : Math.max(0, layoutBottom - height - offsetTop);
  }
  function mountKeyboard(dock) {
    const viewport = window.visualViewport;
    if (!viewport) return;
    let shift = 0;
    const update = () => {
      const focused = document.activeElement?.matches('input, textarea, [contenteditable="true"]');
      const baseline = dock.getBoundingClientRect().bottom + shift;
      shift = focused ? keyboardShift(baseline, viewport.height, viewport.offsetTop, viewport.scale) : 0;
      document.documentElement.style.setProperty("--kb", `${shift}px`);
    };
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", () => requestAnimationFrame(update));
    new ResizeObserver(update).observe(dock);
    update();
  }
  function pinchViewport(start, anchor, center, ratio) {
    const world = screenToWorld(start, anchor);
    const scale = Math.max(0.25, Math.min(3, start.scale * ratio));
    return { scale, tx: center.x - world.x * scale, ty: center.y - world.y * scale };
  }
  function mountPinch(stage, hooks) {
    let blocked = false;
    let start = null;
    const geometry = (touches) => {
      const a = touches[0], b = touches[1];
      const rect = stage.getBoundingClientRect();
      return {
        center: { x: (a.clientX + b.clientX) / 2 - rect.left, y: (a.clientY + b.clientY) / 2 - rect.top },
        distance: Math.max(1, Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)),
        ids: [a.identifier, b.identifier]
      };
    };
    stage.addEventListener("touchstart", (e) => {
      if (e.touches.length < 2) return;
      e.preventDefault();
      blocked = true;
      hooks.cancelSingle();
      start = { ...geometry(e.touches), viewport: { ...hooks.viewport() } };
    }, { passive: false });
    stage.addEventListener("touchmove", (e) => {
      if (e.cancelable) e.preventDefault();
      if (!start || e.touches.length < 2) return;
      const next = geometry(e.touches);
      if (next.ids.some((id, i) => id !== start.ids[i])) {
        start = { ...next, viewport: { ...hooks.viewport() } };
        return;
      }
      hooks.apply(pinchViewport(start.viewport, start.center, next.center, next.distance / start.distance));
    }, { passive: false });
    const end = (e) => {
      if (!blocked) return;
      if (e.cancelable) e.preventDefault();
      if (e.touches.length < 2 && start) {
        start = null;
        hooks.save();
      }
      if (e.touches.length === 0) blocked = false;
    };
    stage.addEventListener("touchend", end, { passive: false });
    stage.addEventListener("touchcancel", end, { passive: false });
    stage.addEventListener("click", (e) => {
      if (blocked) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }, true);
    return { get active() {
      return blocked;
    } };
  }

  // src/render.ts
  var PERFORMANCE = {
    fullLimit: 300,
    cullAfter: 800,
    largestCount: 300,
    fontReduction: 1
  };
  function renderPolicy(count) {
    return {
      tier: count <= PERFORMANCE.fullLimit ? "full" : count <= PERFORMANCE.cullAfter ? "light" : "culled",
      ripple: count <= PERFORMANCE.fullLimit,
      glow: count <= PERFORMANCE.fullLimit,
      fontReduction: count <= PERFORMANCE.fullLimit ? 0 : PERFORMANCE.fontReduction,
      culled: count > PERFORMANCE.cullAfter
    };
  }
  function renderedIds(bodies, hits) {
    const ids = renderPolicy(bodies.length).culled ? [...bodies].sort((a, b) => b.rx * b.ry - a.rx * a.ry || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, PERFORMANCE.largestCount).map((b) => b.id) : bodies.map((b) => b.id);
    return /* @__PURE__ */ new Set([...ids, ...hits]);
  }

  // src/ui/performance.ts
  function mountPerformancePanel(snapshot) {
    const panel = document.createElement("output");
    panel.className = "performance-panel";
    panel.hidden = true;
    document.body.appendChild(panel);
    let raf = 0;
    let from = 0;
    let frames = 0;
    let fps = 0;
    const draw = (now) => {
      frames++;
      if (now - from >= 500) {
        fps = frames * 1e3 / (now - from);
        from = now;
        frames = 0;
        const s = snapshot();
        panel.textContent = `${fps.toFixed(1)} fps (rAF)
\u6CE1\u6CE1 ${s.ideas} \xB7 DOM ${s.rendered}
\u6E32\u67D3 ${s.renderTier} \xB7 \u529B\u573A ${s.forceTier}`;
      }
      raf = requestAnimationFrame(draw);
    };
    const start = () => {
      from = performance.now();
      frames = 0;
      raf = requestAnimationFrame(draw);
    };
    window.addEventListener("keydown", (e) => {
      if (e.key !== "F2" || e.repeat) return;
      e.preventDefault();
      panel.hidden = !panel.hidden;
      cancelAnimationFrame(raf);
      if (!panel.hidden && !document.hidden) start();
    });
    document.addEventListener("visibilitychange", () => {
      cancelAnimationFrame(raf);
      if (!panel.hidden && !document.hidden) start();
    });
  }

  // src/rng.ts
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function next() {
      a = a + 1831565813 >>> 0;
      let t = a;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function hashString(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  function makeRng(seed) {
    const next = mulberry32(typeof seed === "string" ? hashString(seed) : seed);
    return {
      next,
      range: (lo, hi) => lo + next() * (hi - lo),
      int: (lo, hi) => Math.floor(lo + next() * (hi - lo + 1)),
      inDisc(radius) {
        const angle = next() * Math.PI * 2;
        const r = Math.sqrt(next()) * radius;
        return { x: Math.cos(angle) * r, y: Math.sin(angle) * r };
      }
    };
  }
  function newId() {
    const c = globalThis.crypto;
    if (c && typeof c.randomUUID === "function") {
      return c.randomUUID();
    }
    if (c && typeof c.getRandomValues === "function") {
      const b = new Uint8Array(16);
      c.getRandomValues(b);
      b[6] = b[6] & 15 | 64;
      b[8] = b[8] & 63 | 128;
      let hex = "";
      for (const byte of b) hex += byte.toString(16).padStart(2, "0");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
    throw new Error("\u5F53\u524D\u73AF\u5883\u6CA1\u6709 crypto\uFF0C\u65E0\u6CD5\u751F\u6210 id");
  }

  // src/physics/force.ts
  function isImmovable(body) {
    return body.fixed || body.pinned || body.dragging;
  }
  var DEFAULT_PARAMS = {
    repulsion: 52e4,
    centering: 0.9,
    damping: 0.885,
    interactionRadius: 260,
    maxVelocity: 900,
    dt: 1 / 60,
    alphaDecay: 0.0225,
    alphaMin: 2e-3,
    collisionRelax: 0.8,
    collisionSpacing: 1.22
  };
  function cellKey(cx, cy) {
    return `${cx},${cy}`;
  }
  var ForceField = class {
    params;
    /** 🔴 按空间分区的泡泡表。每个空间一份，互不可见。 */
    partitions = /* @__PURE__ */ new Map();
    /** 🔴 按空间分区的 spatial grid。这是空间隔离的执行点。 */
    grids = /* @__PURE__ */ new Map();
    active = null;
    alphaValue = 0;
    reducedMotion = false;
    setReducedMotion(reduced) {
      this.reducedMotion = reduced;
      if (reduced && this.alphaValue <= 0.02) this.stop();
    }
    stop() {
      this.alphaValue = 0;
      for (const body of this.activeBodies) {
        body.vx = 0;
        body.vy = 0;
      }
    }
    constructor(params = {}) {
      this.params = { ...DEFAULT_PARAMS, ...params };
    }
    get alpha() {
      return this.alphaValue;
    }
    get activeSpaceId() {
      return this.active;
    }
    /** 已登记的空间 id 列表（测试与调试用）。 */
    get spaceIds() {
      return [...this.partitions.keys()];
    }
    bodiesOf(spaceId) {
      return this.partitions.get(spaceId) ?? [];
    }
    /** 当前正在模拟的空间的泡泡。 */
    get activeBodies() {
      return this.active ? this.bodiesOf(this.active) : [];
    }
    setSpaceBodies(spaceId, bodies) {
      this.partitions.set(spaceId, bodies);
      this.rebuildGrid(spaceId);
    }
    removeSpace(spaceId) {
      this.partitions.delete(spaceId);
      this.grids.delete(spaceId);
      if (this.active === spaceId) this.active = null;
    }
    setActiveSpace(spaceId) {
      this.active = spaceId;
    }
    /** 唤醒布局。新泡泡落定、拖动、窗口变化时调用。 */
    wake(strength = 0.35) {
      if (this.reducedMotion && strength <= 0.02) return;
      if (strength > this.alphaValue) this.alphaValue = strength;
    }
    /** 三档降频。让静止时 CPU 真的是 0，而不是一直在跑。 */
    tier() {
      if (this.alphaValue > 0.02) return "full";
      if (this.alphaValue > this.params.alphaMin) return "eco";
      return "asleep";
    }
    /**
     * 查某个泡泡的邻居。
     *
     * 🔴 注意这里**没有任何 spaceId 过滤条件** —— 因为网格本身就是按空间分的，
     *    查到别的空间在结构上不可能。这正是"空间互不影响"的实现方式。
     */
    neighborsOf(body) {
      const grid = this.grids.get(body.spaceId);
      if (!grid) return [];
      const { cellSize } = this.gridMetrics();
      const cx = Math.floor(body.x / cellSize);
      const cy = Math.floor(body.y / cellSize);
      const r2 = this.params.interactionRadius * this.params.interactionRadius;
      const out = [];
      for (let ix = cx - 1; ix <= cx + 1; ix++) {
        for (let iy = cy - 1; iy <= cy + 1; iy++) {
          const bucket = grid.get(cellKey(ix, iy));
          if (!bucket) continue;
          for (const other of bucket) {
            if (other === body) continue;
            const dx = other.x - body.x;
            const dy = other.y - body.y;
            if (dx * dx + dy * dy <= r2) out.push(other);
          }
        }
      }
      return out;
    }
    /** 推进一步。只推进当前活动空间。 */
    step() {
      const spaceId = this.active;
      if (!spaceId) return;
      const bodies = this.partitions.get(spaceId);
      if (!bodies || bodies.length === 0) {
        this.decayAlpha();
        return;
      }
      this.rebuildGrid(spaceId);
      const p = this.params;
      const alpha = this.alphaValue;
      for (const body of bodies) {
        if (isImmovable(body)) {
          body.vx = 0;
          body.vy = 0;
          continue;
        }
        let vx = body.vx;
        let vy = body.vy;
        for (const other of this.neighborsOf(body)) {
          let dx = body.x - other.x;
          let dy = body.y - other.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1e-9) {
            const h = hashString(`${body.id}|${other.id}`);
            const angle = h % 3600 / 3600 * Math.PI * 2;
            dx = Math.cos(angle);
            dy = Math.sin(angle);
            d2 = 1;
          }
          const d = Math.sqrt(d2);
          const magnitude = p.repulsion * alpha / d2;
          vx += dx / d * magnitude * p.dt;
          vy += dy / d * magnitude * p.dt;
        }
        vx += -body.x * p.centering * alpha * p.dt;
        vy += -body.y * p.centering * alpha * p.dt;
        vx *= p.damping;
        vy *= p.damping;
        const speed = Math.hypot(vx, vy);
        if (speed > p.maxVelocity) {
          const k = p.maxVelocity / speed;
          vx *= k;
          vy *= k;
        }
        body.vx = vx;
        body.vy = vy;
      }
      for (const body of bodies) {
        if (isImmovable(body)) continue;
        body.x += body.vx * p.dt;
        body.y += body.vy * p.dt;
      }
      this.resolveCollisions(bodies);
      this.grids.delete(spaceId);
      this.rebuildGrid(spaceId);
      this.decayAlpha();
    }
    /** 椭圆碰撞。不可推动的泡泡不动，只推开对方。 */
    resolveCollisions(bodies) {
      const relax = this.params.collisionRelax;
      const spacing = this.params.collisionSpacing;
      for (const body of bodies) {
        for (const other of this.neighborsOf(body)) {
          if (body.id >= other.id) continue;
          const dx = other.x - body.x;
          const dy = other.y - body.y;
          const sumRx = (body.rx + other.rx) * spacing;
          const sumRy = (body.ry + other.ry) * spacing;
          if (sumRx <= 0 || sumRy <= 0) continue;
          const nx = dx / sumRx;
          const ny = dy / sumRy;
          const dist = Math.hypot(nx, ny);
          if (dist >= 1) continue;
          let ux = nx;
          let uy = ny;
          if (dist < 1e-6) {
            const h = hashString(`${body.id}#${other.id}`);
            const angle = h % 3600 / 3600 * Math.PI * 2;
            ux = Math.cos(angle);
            uy = Math.sin(angle);
          } else {
            ux /= dist;
            uy /= dist;
          }
          const overlap = (1 - dist) * Math.min(sumRx, sumRy) * relax;
          const pushX = ux * overlap * 0.5;
          const pushY = uy * overlap * 0.5;
          const bodyMovable = !isImmovable(body);
          const otherMovable = !isImmovable(other);
          if (bodyMovable && otherMovable) {
            body.x -= pushX;
            body.y -= pushY;
            other.x += pushX;
            other.y += pushY;
          } else if (bodyMovable) {
            body.x -= pushX * 2;
            body.y -= pushY * 2;
          } else if (otherMovable) {
            other.x += pushX * 2;
            other.y += pushY * 2;
          }
        }
      }
    }
    decayAlpha() {
      const next = this.alphaValue * (1 - this.params.alphaDecay);
      if (this.reducedMotion && next <= 0.02) {
        this.stop();
        return;
      }
      this.alphaValue = next < this.params.alphaMin ? 0 : next;
    }
    gridMetrics() {
      return { cellSize: Math.max(32, this.params.interactionRadius) };
    }
    rebuildGrid(spaceId) {
      const bodies = this.partitions.get(spaceId);
      if (!bodies || bodies.length === 0) {
        this.grids.delete(spaceId);
        return;
      }
      const { cellSize } = this.gridMetrics();
      const grid = /* @__PURE__ */ new Map();
      for (const body of bodies) {
        const key = cellKey(Math.floor(body.x / cellSize), Math.floor(body.y / cellSize));
        const bucket = grid.get(key);
        if (bucket) bucket.push(body);
        else grid.set(key, [body]);
      }
      this.grids.set(spaceId, grid);
    }
  };

  // src/text.ts
  var FONT_STACK = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Source Han Sans SC", "Noto Sans CJK SC", system-ui, -apple-system, "Segoe UI", sans-serif';
  var FONT_SIZE = 13;
  var LINE_HEIGHT_RATIO = 1.45;
  var MIN_RADIUS = 26;
  var MAX_RADIUS = 78;
  var CIRCLE_MAX_CHARS = 8;
  function shapeOf(text) {
    const flat = text.replace(/\n/g, "");
    return flat.length <= CIRCLE_MAX_CHARS ? "circle" : "card";
  }
  var PAD_X = 22;
  var PAD_Y = 18;
  var MIN_LINE_CAP = 56;
  var MIN_ASPECT = 1;
  var MAX_ASPECT = 2;
  var CAP_MAX = 2 * (MAX_RADIUS - PAD_X);
  function lineHeight() {
    return Math.round(FONT_SIZE * LINE_HEIGHT_RATIO);
  }
  function norm(raw) {
    return raw.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
  }
  function clampText(s, max = MAX_TEXT) {
    if (s.length <= max) return { text: s, clipped: false };
    let cut = s.slice(0, Math.max(0, max - 1));
    if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
    return { text: cut.trimEnd() + "\u2026", clipped: true };
  }
  function ellipseFromMeasurement(m, textLength, minR = MIN_RADIUS, maxR = MAX_RADIUS) {
    let rx = m.w / 2 + PAD_X;
    let ry = m.h / 2 + PAD_Y;
    rx *= 0.96;
    ry *= 0.98;
    let aspect = rx / ry;
    if (aspect > MAX_ASPECT) aspect = MAX_ASPECT;
    else if (aspect < MIN_ASPECT) aspect = MIN_ASPECT;
    let w = clampNumber(rx, minR, maxR);
    let h = w / aspect;
    if (h > maxR) {
      h = maxR;
      w = h * aspect;
    }
    if (h < minR * 0.7) {
      h = minR * 0.7;
      w = h * aspect;
    }
    if (m.lines.length <= 1 && textLength <= CIRCLE_MAX_CHARS) {
      const r = clampNumber(Math.max(w, h), minR, maxR);
      return { rx: r, ry: r };
    }
    return { rx: w, ry: h };
  }
  function clampNumber(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }
  var measureCtx = null;
  function getMeasureCtx() {
    if (measureCtx) return measureCtx;
    if (typeof document === "undefined") {
      throw new Error("measureText \u9700\u8981 canvas\uFF08\u6D4F\u89C8\u5668\u73AF\u5883\uFF09\u3002Node \u91CC\u8BF7\u76F4\u63A5\u6D4B ellipseFromMeasurement\u3002");
    }
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const got = canvas.getContext("2d");
    if (!got) throw new Error("\u65E0\u6CD5\u521B\u5EFA canvas 2d \u4E0A\u4E0B\u6587");
    got.font = `${FONT_SIZE}px ${FONT_STACK}`;
    measureCtx = got;
    return got;
  }
  function measureWithCap(text, cap) {
    const ctx = getMeasureCtx();
    const lh = lineHeight();
    const lines = [];
    for (const paragraph of text.split("\n")) {
      if (paragraph === "") {
        lines.push("");
        continue;
      }
      let cur = "";
      for (const ch of paragraph) {
        const test = cur + ch;
        if (cur !== "" && ctx.measureText(test).width > cap) {
          lines.push(cur);
          cur = ch;
        } else {
          cur = test;
        }
      }
      if (cur !== "") lines.push(cur);
    }
    let w = 1;
    for (const line of lines) {
      const lineW = ctx.measureText(line).width;
      if (lineW > w) w = lineW;
    }
    return { w, h: Math.max(1, lines.length) * lh, lines };
  }
  function radiusOf(text, minR = MIN_RADIUS, maxR = MAX_RADIUS) {
    const safe = text.length === 0 ? " " : text;
    let cap = CAP_MAX;
    let m = measureWithCap(safe, cap);
    let size = ellipseFromMeasurement(m, safe.length, minR, maxR);
    for (let pass = 0; pass < 2; pass++) {
      const implied = 2 * (size.rx - PAD_X);
      const lowerBound = Math.max(m.w, MIN_LINE_CAP);
      const nextCap = clampNumber(implied, lowerBound, CAP_MAX);
      if (Math.abs(nextCap - cap) < 4) break;
      cap = nextCap;
      m = measureWithCap(safe, cap);
      size = ellipseFromMeasurement(m, safe.length, minR, maxR);
    }
    return size;
  }
  function heartRadiusOf(name) {
    const clipped = name.slice(0, HEART_NAME_MEASURE_MAX);
    const m = measureWithCap(clipped === "" ? " " : clipped, Number.MAX_SAFE_INTEGER);
    const needed = Math.max(m.w / 2 + PAD_X, m.h / 2 + PAD_Y) * HEART_SCALE;
    return clampNumber(needed, HEART_MIN_RADIUS, HEART_MAX_RADIUS);
  }
  var sizeCache = /* @__PURE__ */ new Map();
  var SIZE_CACHE_MAX = 2e3;
  function radiusOfCached(text) {
    const hit = sizeCache.get(text);
    if (hit) return hit;
    const v = radiusOf(text);
    if (sizeCache.size >= SIZE_CACHE_MAX) {
      const oldest = sizeCache.keys().next();
      if (!oldest.done) sizeCache.delete(oldest.value);
    }
    sizeCache.set(text, v);
    return v;
  }
  function remeasureFont() {
    if (measureCtx) measureCtx.font = `${FONT_SIZE}px ${FONT_STACK}`;
  }
  function installFontStackVar() {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    root.style.setProperty("--font-stack", FONT_STACK);
    root.style.setProperty("--font-size", `${FONT_SIZE}px`);
    remeasureFont();
  }
  var SCORE_EXACT = 1e3;
  var SCORE_PREFIX = 500;
  var SCORE_SUBSTRING = 200;
  var SCORE_POSITION_PENALTY_MAX = 150;
  var SCORE_CHARSET_MAX = 20;
  function scoreMatch(text, query) {
    if (query === "") return 0;
    const t = text.toLowerCase();
    const q = query.toLowerCase();
    if (t === q) return SCORE_EXACT;
    if (t.startsWith(q)) return SCORE_PREFIX;
    const at = t.indexOf(q);
    if (at >= 0) {
      return SCORE_SUBSTRING - Math.min(SCORE_POSITION_PENALTY_MAX, at);
    }
    const chars = /* @__PURE__ */ new Set();
    for (const ch of q) chars.add(ch);
    if (chars.size === 0) return 0;
    let hit = 0;
    for (const ch of chars) {
      if (t.includes(ch)) hit++;
    }
    if (hit === 0) return 0;
    return hit / chars.size * SCORE_CHARSET_MAX;
  }

  // src/render/bubble.ts
  var HUE_ACCENTS = [
    "#534AB7",
    // 0 紫
    "#0F6E56",
    // 1 青
    "#185FA5",
    // 2 蓝
    "#993C1D",
    // 3 珊瑚
    "#854F0B",
    // 4 琥珀
    "#993556",
    // 5 粉
    "#3B6D11",
    // 6 绿
    "#A32D2D",
    // 7 红
    "#5F5E5A"
    // 8 灰
  ];
  var HUE_SOFTS = [
    "#EEEDFE",
    "#E1F5EE",
    "#E6F1FB",
    "#FAECE7",
    "#FAEEDA",
    "#FBEAF0",
    "#EAF3DE",
    "#FCEBEB",
    "#F1EFE8"
  ];
  function hueAccent(hue) {
    return HUE_ACCENTS[(hue % 9 + 9) % 9];
  }
  function hueSoft(hue) {
    return HUE_SOFTS[(hue % 9 + 9) % 9];
  }
  function applyAccent(worldEl, hue) {
    const accent = hueAccent(hue);
    const soft = hueSoft(hue);
    const line = `${accent}55`;
    worldEl.style.setProperty("--accent", accent);
    worldEl.style.setProperty("--accent-soft", soft);
    worldEl.style.setProperty("--accent-line", line);
    const root = document.documentElement;
    root.style.setProperty("--accent", accent);
    root.style.setProperty("--accent-soft", soft);
    root.style.setProperty("--accent-line", line);
  }
  function makeShell() {
    const el = document.createElement("div");
    const scale = document.createElement("div");
    const inner = document.createElement("div");
    el.className = "bubble";
    scale.className = "bubble-scale";
    inner.className = "bubble-inner";
    el.style.position = "absolute";
    el.style.left = "0";
    el.style.top = "0";
    scale.appendChild(inner);
    el.appendChild(scale);
    return { el, scale, inner };
  }
  function setDragging(view, dragging) {
    view.el.classList.toggle("bubble--dragging", dragging);
  }
  function setSearchState(view, hit) {
    view.el.classList.toggle("bubble--hit", hit);
    view.el.classList.toggle("bubble--dim", !hit);
  }
  function clearSearchState(view) {
    view.el.classList.remove("bubble--hit", "bubble--dim");
  }
  function setHidden(view, hidden) {
    view.el.classList.toggle("bubble--hidden", hidden);
  }
  function bindHandlers(view, handlers) {
    const onClick = (e) => handlers.onClick?.(view, e);
    const onDblClick = (e) => handlers.onDblClick?.(view, e);
    if (handlers.onClick) view.el.addEventListener("click", onClick);
    if (handlers.onDblClick) view.el.addEventListener("dblclick", onDblClick);
    return () => {
      view.el.removeEventListener("click", onClick);
      view.el.removeEventListener("dblclick", onDblClick);
    };
  }
  function fitLines(ry) {
    const usable = 2 * ry - 12;
    return Math.max(1, Math.floor(usable / lineHeight()));
  }
  function createIdeaBubble(body, text, handlers = {}) {
    const { el, scale, inner } = makeShell();
    const { rx, ry } = radiusOfCached(text);
    body.rx = rx;
    body.ry = ry;
    el.classList.add("bubble--idea");
    el.dataset.id = body.id;
    el.style.width = `${rx * 2}px`;
    el.style.height = `${ry * 2}px`;
    el.style.marginLeft = `${-rx}px`;
    el.style.marginTop = `${-ry}px`;
    const label = document.createElement("div");
    label.className = "bubble-label";
    label.textContent = text;
    label.style.fontSize = `calc(${FONT_SIZE}px - var(--bubble-font-reduction, 0px))`;
    inner.style.setProperty("--lines", String(fitLines(ry)));
    inner.appendChild(label);
    const view = { el, scale, inner, label, body, text, destroy: () => {
    } };
    const unbind = bindHandlers(view, handlers);
    view.destroy = () => {
      unbind();
      el.remove();
    };
    return view;
  }
  function createHeartBubble(body, name, handlers = {}) {
    const { el, scale, inner } = makeShell();
    const r = heartRadiusOf(name);
    body.rx = r;
    body.ry = r;
    body.fixed = true;
    el.classList.add("bubble--heart");
    el.dataset.id = body.id;
    el.dataset.role = "heart";
    el.style.width = `${r * 2}px`;
    el.style.height = `${r * 2}px`;
    el.style.marginLeft = `${-r}px`;
    el.style.marginTop = `${-r}px`;
    const label = document.createElement("div");
    label.className = "bubble-label bubble-label--single";
    label.textContent = name;
    const hint = document.createElement("div");
    hint.className = "bubble-hint";
    hint.textContent = "\u5207\u6362\u7A7A\u95F4";
    inner.appendChild(label);
    inner.appendChild(hint);
    const view = { el, scale, inner, label, body, text: name, destroy: () => {
    } };
    const unbind = bindHandlers(view, handlers);
    view.destroy = () => {
      unbind();
      el.remove();
    };
    return view;
  }
  function writePosition(view) {
    const { x, y } = view.body;
    view.el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  }
  function setPinned(view, pinned) {
    view.el.classList.toggle("bubble--pinned", pinned);
  }
  function updateHeartLabel(view, name) {
    const label = view.inner.querySelector(".bubble-label");
    if (label) label.textContent = name;
    const r = heartRadiusOf(name);
    view.body.rx = r;
    view.body.ry = r;
    view.el.style.width = `${r * 2}px`;
    view.el.style.height = `${r * 2}px`;
    view.el.style.marginLeft = `${-r}px`;
    view.el.style.marginTop = `${-r}px`;
  }

  // src/render/flyIn.ts
  var FLY_MS = 540;
  var POP_MS = 240;
  var ARC_LIFT_MIN = 60;
  var ARC_LIFT_MAX = 120;
  var RIPPLE_SCALE = 2.2;
  var POP_START = 0.15;
  var POP_OVERSHOOT = 1.22;
  var POP_UNDERSHOOT = 0.92;
  var POP_SETTLE = 1.05;
  var POP_LOAD_START = 0.72;
  var FX_ID = "nebula-fx";
  function arcControlPoint(from, to, lift) {
    return {
      x: (from.x + to.x) / 2,
      y: (from.y + to.y) / 2 - lift
    };
  }
  function pathDataFor(from, control, to) {
    const r = (n) => Math.round(n * 100) / 100;
    return `path("M ${r(from.x)} ${r(from.y)} Q ${r(control.x)} ${r(control.y)} ${r(to.x)} ${r(to.y)}")`;
  }
  function popKeyframes(start = POP_START, overshoot = POP_OVERSHOOT, undershoot = POP_UNDERSHOOT, settle = POP_SETTLE) {
    const scale = (s) => ({ transform: `scale(${s})` });
    return [
      { ...scale(start), offset: 0 },
      { ...scale(overshoot), offset: 0.42 },
      { ...scale(undershoot), offset: 0.68 },
      { ...scale(settle), offset: 0.86 },
      { ...scale(1), offset: 1 }
    ];
  }
  function loadPopKeyframes() {
    return [
      { transform: `scale(${POP_LOAD_START})`, opacity: "0", offset: 0 },
      { transform: "scale(1.04)", opacity: "1", offset: 0.7 },
      { transform: "scale(1)", opacity: "1", offset: 1 }
    ];
  }
  function rippleKeyframes() {
    return [
      { transform: "scale(0.6)", opacity: "1", offset: 0 },
      { transform: `scale(${RIPPLE_SCALE})`, opacity: "0", offset: 1 }
    ];
  }
  function prefersReducedMotion() {
    return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  }
  function ensureFxLayer() {
    const existing = document.getElementById(FX_ID);
    if (existing) return existing;
    const layer = document.createElement("div");
    layer.id = FX_ID;
    layer.className = "fx-layer";
    document.body.appendChild(layer);
    return layer;
  }
  function buildShadow(text, rx, ry) {
    const el = document.createElement("div");
    el.className = "bubble bubble--idea bubble--shadow";
    el.dataset.role = "shadow";
    el.style.width = `${rx * 2}px`;
    el.style.height = `${ry * 2}px`;
    const scale = document.createElement("div");
    scale.className = "bubble-scale";
    const inner = document.createElement("div");
    inner.className = "bubble-inner";
    const lines = Math.max(1, Math.floor((2 * ry - 12) / lineHeight()));
    inner.style.setProperty("--lines", String(lines));
    const label = document.createElement("div");
    label.className = "bubble-label";
    label.textContent = text;
    inner.appendChild(label);
    scale.appendChild(inner);
    el.appendChild(scale);
    return el;
  }
  function spawnRipple(at) {
    const layer = ensureFxLayer();
    const el = document.createElement("div");
    el.className = "ripple";
    el.style.left = `${at.x}px`;
    el.style.top = `${at.y}px`;
    layer.appendChild(el);
    const anim = el.animate(rippleKeyframes(), {
      duration: 460,
      easing: "cubic-bezier(.2,.7,.4,1)"
    });
    anim.finished.catch(() => void 0).then(() => el.remove());
  }
  var lastFlight = null;
  function getLastFlight() {
    return lastFlight;
  }
  async function flyIn(req) {
    const { text, from, to } = req;
    const { rx, ry } = radiusOfCached(text);
    const lift = req.lift ?? ARC_LIFT_MIN + (ARC_LIFT_MAX - ARC_LIFT_MIN) * 0.5;
    const control = arcControlPoint(from, to, lift);
    const reduced = prefersReducedMotion();
    const record = { mode: reduced ? "fade" : "arc", from, control, to, shadowEnd: null, landedAt: null };
    lastFlight = record;
    const layer = ensureFxLayer();
    const shadow = buildShadow(text, rx, ry);
    if (reduced) {
      shadow.style.transform = `translate(${to.x}px, ${to.y}px)`;
      shadow.style.marginLeft = `${-rx}px`;
      shadow.style.marginTop = `${-ry}px`;
    } else {
      shadow.style.offsetPath = pathDataFor(from, control, to);
    }
    layer.appendChild(shadow);
    const anim = shadow.animate(
      reduced ? [{ opacity: "0" }, { opacity: "1" }] : [{ offsetDistance: "0%" }, { offsetDistance: "100%" }],
      {
        duration: reduced ? 140 : FLY_MS,
        easing: "cubic-bezier(.3,.1,.35,1)",
        // 🔴 必须 fill: 'forwards'。默认的 'none' 会在动画一结束就把 offset-distance
        //    弹回基础值（0%），于是"影子已经飞到了"这件事在测量时根本看不到 ——
        //    实测表现为落点与终点差了整整一个飞行距离（694px）。
        //    这里加 fill 是安全的：影子下一行就被销毁，不存在"fill 压住 hover"的问题。
        fill: "forwards"
      }
    );
    try {
      await anim.finished;
    } catch {
    }
    const rect = shadow.getBoundingClientRect();
    record.shadowEnd = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    shadow.remove();
    if (!reduced && req.ripple !== false) spawnRipple(to);
    return record;
  }
  function playPop(scaleEl, light = false, delay = 0) {
    if (prefersReducedMotion()) return;
    const frames = light ? loadPopKeyframes() : popKeyframes();
    const anim = scaleEl.animate(frames, {
      duration: light ? 260 : POP_MS,
      delay,
      easing: "linear",
      // 🔴 必须用 'backwards' 而不是 'both'：
      //    'both' 会连**结束值**也保留下来，于是动画结束后它一直压着 hover 的 transform，
      //    悬停就永久失效（阶段 2 踩过这个坑）。
      //    'backwards' 只在 delay 期间保留起始值（否则带 delay 的首屏装配会先闪一下全尺寸），
      //    结束后一切交还给 CSS。
      fill: "backwards"
    });
    anim.finished.catch(() => void 0);
  }

  // src/render/zoom.ts
  var ZOOM_IN_MS = 320;
  var ZOOM_OUT_MS = 220;
  var ZOOM_MAX_W = 620;
  var ZOOM_MAX_H = 0.62;
  var ZOOM_MAX_SCALE = 3.4;
  var ZOOM_MAX_FONT = FONT_SIZE * ZOOM_MAX_SCALE;
  var ZOOM_MIN_FONT = 13;
  var LINE_HEIGHT_RATIO2 = 1.45;
  var ZOOM_ID = "nebula-zoom";
  function zoomScaleFor(src, fit) {
    if (src.w <= 0 || src.h <= 0) return 1;
    const byFit = Math.min(fit.maxW / src.w, fit.maxH / src.h);
    return Math.max(1, Math.min(fit.maxScale, byFit));
  }
  function zoomTargetRect(src, scale, viewport) {
    const w = src.w * scale;
    const h = src.h * scale;
    return { x: (viewport.w - w) / 2, y: (viewport.h - h) / 2, w, h };
  }
  function computeZoomTransform(src, target, pointer) {
    const k = target.w > 0 ? src.w / target.w : 1;
    const ox = (pointer.x - src.x) / k;
    const oy = (pointer.y - src.y) / k;
    const tx2 = src.x - target.x - ox * (1 - k);
    const ty = src.y - target.y - oy * (1 - k);
    return {
      origin: { x: ox, y: oy },
      start: { x: tx2, y: ty },
      k,
      startTransform: `translate(${round(tx2)}px, ${round(ty)}px) scale(${round(k, 5)})`
    };
  }
  function round(n, digits = 3) {
    const f = 10 ** digits;
    return Math.round(n * f) / f;
  }
  function zoomRadiusFor(shape, target) {
    return shape === "circle" ? "50%" : `${Math.round(Math.min(target.w, target.h) * 0.12)}px`;
  }
  function zoomFontSize(text, target, scale) {
    const len = Math.max(1, text.replace(/\n/g, "").length);
    const usableW = Math.max(8, target.w - 20 * scale);
    const usableH = Math.max(8, target.h - 16 * scale);
    let best = ZOOM_MIN_FONT;
    for (let lines = 1; lines <= 64; lines++) {
      const perLine = Math.ceil(len / lines);
      const byWidth = usableW / perLine;
      const byHeight = usableH / (lines * LINE_HEIGHT_RATIO2);
      const font = Math.min(byWidth, byHeight);
      if (font > best) best = font;
    }
    const byScale = FONT_SIZE * scale;
    const chosen = Math.min(best, byScale);
    return Math.max(ZOOM_MIN_FONT, Math.min(ZOOM_MAX_FONT, chosen));
  }
  var lastZoom = null;
  function getLastZoom() {
    return lastZoom;
  }
  function planZoom(src, pointer, viewport, text) {
    const shape = shapeOf(text);
    const scale = zoomScaleFor(src, {
      maxW: Math.min(ZOOM_MAX_W, viewport.w - 64),
      maxH: viewport.h * ZOOM_MAX_H,
      maxScale: ZOOM_MAX_SCALE
    });
    const target = zoomTargetRect(src, scale, viewport);
    return { src, target, pointer, transform: computeZoomTransform(src, target, pointer), shape, scale };
  }
  function ensureZoomLayer() {
    const existing = document.getElementById(ZOOM_ID);
    if (existing) return existing;
    const layer = document.createElement("div");
    layer.id = ZOOM_ID;
    layer.className = "zoom-layer";
    layer.hidden = true;
    document.body.appendChild(layer);
    return layer;
  }
  function buildClone(text, target, record) {
    const el = document.createElement("div");
    el.className = "bubble bubble--idea bubble--zoom";
    el.style.left = `${target.x}px`;
    el.style.top = `${target.y}px`;
    el.style.width = `${target.w}px`;
    el.style.height = `${target.h}px`;
    el.style.transformOrigin = `${record.transform.origin.x}px ${record.transform.origin.y}px`;
    const scale = document.createElement("div");
    scale.className = "bubble-scale";
    const inner = document.createElement("div");
    inner.className = "bubble-inner";
    inner.style.borderRadius = zoomRadiusFor(record.shape, target);
    inner.style.padding = `${8 * record.scale}px ${10 * record.scale}px`;
    inner.style.setProperty("--lines", "99");
    const label = document.createElement("div");
    label.className = "bubble-label";
    label.textContent = text;
    label.style.fontSize = `${zoomFontSize(text, target, record.scale)}px`;
    inner.appendChild(label);
    scale.appendChild(inner);
    el.appendChild(scale);
    return el;
  }
  function openZoom(opts) {
    const layer = ensureZoomLayer();
    const rect = layer.getBoundingClientRect();
    const viewport = { w: rect.width || window.innerWidth, h: rect.height || window.innerHeight };
    const record = planZoom(opts.srcRect, opts.pointer, viewport, opts.text);
    lastZoom = record;
    const backdrop = document.createElement("div");
    backdrop.className = "zoom-backdrop";
    const clone = buildClone(opts.text, record.target, record);
    layer.replaceChildren(backdrop, clone);
    layer.hidden = false;
    layer.classList.add("zoom-layer--visible");
    let closed = false;
    const anim = clone.animate(
      [{ transform: record.transform.startTransform }, { transform: "none" }],
      {
        duration: ZOOM_IN_MS,
        easing: "cubic-bezier(.2,.85,.3,1.02)",
        fill: "backwards"
      }
    );
    backdrop.animate([{ opacity: "0" }, { opacity: "1" }], {
      duration: ZOOM_IN_MS,
      easing: "ease-out"
    }).finished.catch(() => void 0);
    const onKeyDown = (e) => {
      if (e.key === "Escape") close();
    };
    function close() {
      if (closed) return;
      closed = true;
      document.removeEventListener("keydown", onKeyDown, true);
      const fade = clone.animate(
        [{ transform: "none" }, { transform: record.transform.startTransform }],
        {
          duration: ZOOM_OUT_MS,
          easing: "cubic-bezier(.4,0,.7,.4)",
          // 收回时用 'forwards'：动画结束到元素被移除之间有几十毫秒，
          // 不加的话会先弹回全尺寸再消失（闪一下）。
          fill: "forwards"
        }
      );
      backdrop.animate([{ opacity: "1" }, { opacity: "0" }], {
        duration: ZOOM_OUT_MS,
        easing: "ease-in"
      });
      fade.finished.catch(() => void 0).then(() => {
        layer.classList.remove("zoom-layer--visible");
        layer.hidden = true;
        layer.replaceChildren();
        opts.onClose?.();
      });
    }
    clone.addEventListener("click", (e) => {
      e.stopPropagation();
      close();
    });
    backdrop.addEventListener("click", close);
    document.addEventListener("keydown", onKeyDown, true);
    anim.finished.catch(() => void 0);
    void anim;
    return {
      close,
      get isOpen() {
        return !closed;
      }
    };
  }

  // src/store.ts
  var DB_NAME = "nebula";
  var DB_VERSION = 1;
  var STORE_SPACES = "spaces";
  var STORE_IDEAS = "ideas";
  var STORE_META = "meta";
  var STORE_TRASH = "trash";
  var META_LAST_SPACE_ID = "lastSpaceId";
  var META_PURGED_IDS = "purgedIds";
  var META_OWNER_HANDLE = "ownerHandle";
  var viewportKey = (spaceId) => `viewport:${spaceId}`;
  function nextSpaceName(taken) {
    for (let n = 1; n <= 999; n++) {
      const candidate = `${SPACE_NAME_DEFAULT} ${n}`;
      if (!taken.has(candidate)) return candidate;
    }
    return `${SPACE_NAME_DEFAULT} ${Date.now()}`;
  }
  function uniqueSpaceName(desired, taken) {
    if (!taken.has(desired)) return desired;
    const first = `${desired}${SPACE_RESTORE_SUFFIX}`;
    if (!taken.has(first)) return first;
    for (let n = 2; n <= 999; n++) {
      const candidate = `${desired}\uFF08\u6062\u590D ${n}\uFF09`;
      if (!taken.has(candidate)) return candidate;
    }
    return `${desired}\uFF08\u6062\u590D ${Date.now()}\uFF09`;
  }
  function pickHue(spaces) {
    const counts = new Array(9).fill(0);
    for (const s of spaces) {
      const idx = (s.hue % 9 + 9) % 9;
      counts[idx] += 1;
    }
    let best = 0;
    for (let h = 1; h < 9; h++) {
      if (counts[h] < counts[best]) best = h;
    }
    return best;
  }
  var NebulaStore = class {
    db = null;
    opening = null;
    /** 打开数据库。可重复调用，只会真正打开一次。 */
    open() {
      if (this.db) return Promise.resolve();
      if (!this.opening) this.opening = this.doOpen();
      return this.opening;
    }
    close() {
      this.db?.close();
      this.db = null;
      this.opening = null;
    }
    get isOpen() {
      return this.db !== null;
    }
    doOpen() {
      return new Promise((resolve, reject) => {
        if (typeof indexedDB === "undefined") {
          reject(
            new Error(
              "\u5F53\u524D\u73AF\u5883\u6CA1\u6709 IndexedDB\u3002\u5982\u679C\u4F60\u662F\u7528 file:// \u76F4\u63A5\u6253\u5F00\u9875\u9762\u7684\uFF0C\u8BF7\u6539\u7528 HTTP \u670D\u52A1\uFF08npm run serve\uFF09\u3002"
            )
          );
          return;
        }
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE_SPACES)) {
            const s = db.createObjectStore(STORE_SPACES, { keyPath: "id" });
            s.createIndex("deleted", "deleted");
          }
          if (!db.objectStoreNames.contains(STORE_IDEAS)) {
            const s = db.createObjectStore(STORE_IDEAS, { keyPath: "id" });
            s.createIndex("spaceId", "spaceId");
            s.createIndex("archived", "archived");
            s.createIndex("updatedAt", "updatedAt");
          }
          if (!db.objectStoreNames.contains(STORE_META)) {
            db.createObjectStore(STORE_META, { keyPath: "key" });
          }
          if (!db.objectStoreNames.contains(STORE_TRASH)) {
            const s = db.createObjectStore(STORE_TRASH, { keyPath: "id" });
            s.createIndex("purgeAt", "purgeAt");
          }
        };
        req.onsuccess = () => {
          const db = req.result;
          db.onversionchange = () => {
            db.close();
            this.db = null;
            this.opening = null;
          };
          this.db = db;
          resolve();
        };
        req.onerror = () => reject(req.error ?? new Error("\u6253\u5F00 IndexedDB \u5931\u8D25"));
        req.onblocked = () => reject(new Error("IndexedDB \u6B63\u88AB\u5176\u5B83\u6807\u7B7E\u9875\u5360\u7528\uFF0C\u8BF7\u5173\u95ED\u5176\u5B83\u6807\u7B7E\u9875\u540E\u5237\u65B0\u91CD\u8BD5"));
      });
    }
    requireDb() {
      if (!this.db) throw new Error("\u6570\u636E\u5E93\u5C1A\u672A\u6253\u5F00\uFF0C\u8BF7\u5148 await store.open()");
      return this.db;
    }
    // ── 底层读写helper ──────────────────────────────────────────
    readOne(store, key) {
      const db = this.requireDb();
      return new Promise((resolve, reject) => {
        const tx2 = db.transaction(store, "readonly");
        const req = tx2.objectStore(store).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error(`\u8BFB\u53D6 ${store} \u5931\u8D25`));
      });
    }
    readAll(store) {
      const db = this.requireDb();
      return new Promise((resolve, reject) => {
        const tx2 = db.transaction(store, "readonly");
        const req = tx2.objectStore(store).getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error(`\u8BFB\u53D6 ${store} \u5168\u90E8\u5931\u8D25`));
      });
    }
    readByIndex(store, index, key) {
      const db = this.requireDb();
      return new Promise((resolve, reject) => {
        const tx2 = db.transaction(store, "readonly");
        const req = tx2.objectStore(store).index(index).getAll(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error(`\u6309 ${index} \u8BFB\u53D6 ${store} \u5931\u8D25`));
      });
    }
    /**
     * 执行一次写事务。
     *
     * 🔴 resolve 挂在 `tx.oncomplete` 上 —— 这是"本地先成功"的技术保证。
     *    调用方 await 到之后，可以确信数据已经真正提交，网络同步随后再做。
     */
    write(stores, mutate) {
      const db = this.requireDb();
      return new Promise((resolve, reject) => {
        const tx2 = db.transaction(stores, "readwrite");
        tx2.oncomplete = () => resolve();
        tx2.onerror = () => reject(tx2.error ?? new Error("IndexedDB \u5199\u4E8B\u52A1\u5931\u8D25"));
        tx2.onabort = () => reject(tx2.error ?? new Error("IndexedDB \u5199\u4E8B\u52A1\u88AB\u4E2D\u6B62"));
        try {
          mutate(tx2);
        } catch (err) {
          try {
            tx2.abort();
          } catch {
          }
          reject(err);
        }
      });
    }
    // ── spaces ─────────────────────────────────────────────────
    putSpace(space) {
      return this.write([STORE_SPACES], (tx2) => {
        tx2.objectStore(STORE_SPACES).put(space);
      });
    }
    getSpace(id) {
      return this.readOne(STORE_SPACES, id);
    }
    /** 取全部空间。默认排除已删除的（回收站里的）。 */
    async getAllSpaces(includeDeleted = false) {
      const all = await this.readAll(STORE_SPACES);
      const list = includeDeleted ? all : all.filter((s) => s.deleted === 0);
      return list.sort((a, b) => a.createdAt - b.createdAt);
    }
    hardDeleteSpace(id) {
      return this.write([STORE_SPACES], (tx2) => {
        tx2.objectStore(STORE_SPACES).delete(id);
      });
    }
    // ── ideas ──────────────────────────────────────────────────
    putIdea(idea) {
      return this.write([STORE_IDEAS], (tx2) => {
        tx2.objectStore(STORE_IDEAS).put(idea);
      });
    }
    /** 批量写入，单事务 —— 多设备合并拉回大量记录时用。 */
    putIdeas(ideas) {
      if (ideas.length === 0) return Promise.resolve();
      return this.write([STORE_IDEAS], (tx2) => {
        const s = tx2.objectStore(STORE_IDEAS);
        for (const idea of ideas) s.put(idea);
      });
    }
    getIdea(id) {
      return this.readOne(STORE_IDEAS, id);
    }
    getAllIdeas() {
      return this.readAll(STORE_IDEAS);
    }
    /** 取某个空间的想法。默认不含归档 —— 归档的定义就是"从星云隐藏"。 */
    async getIdeasBySpace(spaceId, includeArchived = false) {
      const list = await this.readByIndex(STORE_IDEAS, "spaceId", spaceId);
      const filtered = includeArchived ? list : list.filter((i) => i.archived === 0);
      return filtered.sort((a, b) => a.createdAt - b.createdAt);
    }
    countIdeasBySpace(spaceId) {
      const db = this.requireDb();
      return new Promise((resolve, reject) => {
        const tx2 = db.transaction(STORE_IDEAS, "readonly");
        const req = tx2.objectStore(STORE_IDEAS).index("spaceId").count(spaceId);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error("\u7EDF\u8BA1\u60F3\u6CD5\u6570\u91CF\u5931\u8D25"));
      });
    }
    hardDeleteIdea(id) {
      return this.write([STORE_IDEAS], (tx2) => {
        tx2.objectStore(STORE_IDEAS).delete(id);
      });
    }
    // ── meta ───────────────────────────────────────────────────
    async getMeta(key) {
      const rec = await this.readOne(STORE_META, key);
      return rec?.value;
    }
    setMeta(key, value) {
      return this.write([STORE_META], (tx2) => {
        tx2.objectStore(STORE_META).put({ key, value });
      });
    }
    deleteMeta(key) {
      return this.write([STORE_META], (tx2) => {
        tx2.objectStore(STORE_META).delete(key);
      });
    }
    /**
     * 视口状态。按空间分别记忆，**不进同步**（本机偏好）。
     * 若加在 Space 上跟着同步，手机拨到的缩放会把电脑上的也改掉。
     */
    getViewport(spaceId) {
      return this.getMeta(viewportKey(spaceId));
    }
    setViewport(spaceId, vp) {
      return this.setMeta(viewportKey(spaceId), vp);
    }
    /** 本机数据的主人（GitHub 用户名）。null = 还没归属过任何账号。 */
    async getOwnerHandle() {
      const value = await this.getMeta(META_OWNER_HANDLE);
      return typeof value === "string" && value !== "" ? value : null;
    }
    async setOwnerHandle(handle) {
      await this.setMeta(META_OWNER_HANDLE, handle);
    }
    /**
     * 清空本机全部数据。
     *
     * 🔴 只在一件事上用它：**切换账号**。
     *    必须由用户明确确认（界面会弹确认框并说明"原账号的数据在他的备份里不会丢"），
     *    因为这一步之后，本机就再也看不到原来那个账号的数据了。
     */
    wipeAllData() {
      return this.write([STORE_SPACES, STORE_IDEAS, STORE_TRASH, STORE_META], (tx2) => {
        tx2.objectStore(STORE_SPACES).clear();
        tx2.objectStore(STORE_IDEAS).clear();
        tx2.objectStore(STORE_TRASH).clear();
        tx2.objectStore(STORE_META).clear();
      });
    }
    /** 已被彻底清理的 id（空间与想法混合）。 */
    async getPurgedIds() {
      const list = await this.getMeta(META_PURGED_IDS);
      return Array.isArray(list) ? list : [];
    }
    /** 追加彻底清理记录。**只增不减** —— 这是它可安全合并的前提。 */
    async addPurgedIds(ids) {
      if (ids.length === 0) return;
      const existing = new Set(await this.getPurgedIds());
      for (const id of ids) existing.add(id);
      await this.setMeta(META_PURGED_IDS, [...existing].sort());
    }
    async getLastSpaceId() {
      return this.getMeta(META_LAST_SPACE_ID);
    }
    setLastSpaceId(id) {
      return this.setMeta(META_LAST_SPACE_ID, id);
    }
    // ── trash ──────────────────────────────────────────────────
    putTrash(entry) {
      return this.write([STORE_TRASH], (tx2) => {
        tx2.objectStore(STORE_TRASH).put(entry);
      });
    }
    getAllTrash() {
      return this.readAll(STORE_TRASH);
    }
    deleteTrash(id) {
      return this.write([STORE_TRASH], (tx2) => {
        tx2.objectStore(STORE_TRASH).delete(id);
      });
    }
    clearTrash() {
      return this.write([STORE_TRASH], (tx2) => {
        tx2.objectStore(STORE_TRASH).clear();
      });
    }
    /**
     * 删除空间 → 回收站。
     *
     * 🔴 采用「墓碑式」而不是把记录搬走：
     *    空间留在 spaces 表里但标记 deleted=1 + purgeAt，想法也留在 ideas 表里不动。
     *    同时在 trash 表写一份**完整快照**（空间本体 + 它的全部想法）。
     *
     *    为什么两者都要？
     *    - 墓碑让"恢复"变成一次极轻的翻转，不需要把大量记录搬回来，
     *      也不会因为搬到一半失败而留下半截数据；
     *    - 快照是**第二份保险**：万一过期清理逻辑出 bug、或者 ideas 表被误删，
     *      快照还能把整个空间救回来。删除是唯一不可逆的操作，值得存两份。
     *
     *    ⚠️ PROJECT-SPEC.md §5.4 同时写了「从 spaces 表移出」和「标 deleted=1」，
     *       是自相矛盾的。这里按后者实现，因为墓碑式对"不想错过任何想法"更安全。
     */
    async deleteSpaceToTrash(spaceId, now = Date.now()) {
      const space = await this.getSpace(spaceId);
      if (!space || space.deleted === 1) return null;
      const ideas = await this.getIdeasBySpace(spaceId, true);
      const purgeAt = now + TRASH_RETENTION_MS;
      const tombstone = { ...space, deleted: 1, purgeAt, updatedAt: now };
      const entry = {
        id: space.id,
        kind: "space",
        deletedAt: now,
        purgeAt,
        space: tombstone,
        ideas
      };
      await this.write([STORE_SPACES, STORE_TRASH], (tx2) => {
        tx2.objectStore(STORE_SPACES).put(tombstone);
        tx2.objectStore(STORE_TRASH).put(entry);
      });
      return entry;
    }
    /**
     * 从回收站恢复。名字冲突时自动加「（恢复）」后缀。
     *
     * 🔴 恢复时只补回**库里已经不存在**的想法，绝不覆盖现有记录。
     *    否则"在 A 设备恢复了一个空间"会把它在 B 设备上的改动冲掉。
     */
    async restoreFromTrash(trashId, now = Date.now()) {
      const entries = await this.getAllTrash();
      const entry = entries.find((e) => e.id === trashId && e.kind === "space");
      if (!entry?.space) return null;
      const allSpaces = await this.readAll(STORE_SPACES);
      const takenNames = new Set(allSpaces.filter((s) => s.deleted === 0).map((s) => s.name));
      const name = uniqueSpaceName(entry.space.name, takenNames);
      const restored = { ...entry.space, name, deleted: 0, purgeAt: 0, updatedAt: now };
      const existingIds = new Set((await this.readAll(STORE_IDEAS)).map((i) => i.id));
      const missing = (entry.ideas ?? []).filter((i) => !existingIds.has(i.id));
      await this.write([STORE_SPACES, STORE_IDEAS, STORE_TRASH], (tx2) => {
        tx2.objectStore(STORE_SPACES).put(restored);
        const ideas = tx2.objectStore(STORE_IDEAS);
        for (const idea of missing) ideas.put({ ...idea, spaceId: restored.id });
        tx2.objectStore(STORE_TRASH).delete(entry.id);
      });
      return restored;
    }
    /** 创建一个新空间。hue 自动挑用得最少的那个。 */
    async createSpace(now = Date.now()) {
      const all = await this.readAll(STORE_SPACES);
      const taken = new Set(all.filter((s) => s.deleted === 0).map((s) => s.name));
      const space = {
        id: newId(),
        name: nextSpaceName(taken),
        hue: pickHue(all),
        createdAt: now,
        updatedAt: now,
        deleted: 0,
        purgeAt: 0
      };
      await this.putSpace(space);
      return space;
    }
    /** 重命名空间。只改名字，不碰其他字段。 */
    async renameSpace(spaceId, name, now = Date.now()) {
      const space = await this.getSpace(spaceId);
      if (!space) return null;
      const next = { ...space, name, updatedAt: now };
      await this.putSpace(next);
      return next;
    }
    /**
     * 清理过期回收站条目。**启动时与打开回收站时都要调**，因为启动时用户
     * 可能在别的空间，可能永远不打开回收站。
     *
     * 返回清理掉的条目数。
     */
    async purgeExpired(now = Date.now()) {
      const all = await this.getAllTrash();
      const expired = all.filter((e) => e.purgeAt > 0 && e.purgeAt <= now);
      if (expired.length === 0) return 0;
      await this.purgeEntries(expired);
      return expired.length;
    }
    /** 清空回收站（用户手动点"清空"）。返回清理掉的条目数。 */
    async purgeAllTrash() {
      const all = await this.getAllTrash();
      if (all.length === 0) return 0;
      await this.purgeEntries(all);
      return all.length;
    }
    /**
     * 只清理回收站里的某一条。
     *
     * 🔴 存在的理由：自检（diagnostics）必须能"跑完不留痕迹"，但绝不能顺手
     *    把用户回收站里真实的东西也删了。所以自检用它，而不是 purgeAllTrash。
     *    任何"清理自己造的数据"的场景都该用它。
     */
    async purgeTrashEntry(trashId) {
      const all = await this.getAllTrash();
      const entry = all.find((e) => e.id === trashId);
      if (!entry) return false;
      await this.purgeEntries([entry]);
      return true;
    }
    /**
     * 真正物理删除一批回收站条目。
     *
     * ⚠️ 这是全项目**唯一**的不可逆操作。它同时删三处：
     *    回收站条目、空间记录、以及快照里列出的每一条想法。
     *    所以它只该被 purgeExpired / purgeAllTrash 调用，不要在别的地方直接用。
     */
    async purgeEntries(entries) {
      const gone = [];
      await this.write([STORE_TRASH, STORE_SPACES, STORE_IDEAS], (tx2) => {
        const trash = tx2.objectStore(STORE_TRASH);
        const spaces = tx2.objectStore(STORE_SPACES);
        const ideas = tx2.objectStore(STORE_IDEAS);
        for (const entry of entries) {
          trash.delete(entry.id);
          if (entry.kind === "space" && entry.space) {
            spaces.delete(entry.space.id);
            gone.push(entry.space.id);
            for (const idea of entry.ideas ?? []) {
              ideas.delete(idea.id);
              gone.push(idea.id);
            }
          } else if (entry.kind === "idea" && entry.idea) {
            ideas.delete(entry.idea.id);
            gone.push(entry.idea.id);
          }
        }
      });
      await this.addPurgedIds(gone);
    }
  };

  // src/sync/github.ts
  var B64_CHUNK = 32768;
  var REQUEST_TIMEOUT_MS = 12e3;
  async function fetchWithTimeout(url, init = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
  function toBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    for (let i = 0; i < bytes.length; i += B64_CHUNK) {
      const chunk = bytes.subarray(i, i + B64_CHUNK);
      binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
  }
  function fromBase64(b64) {
    const clean = b64.replace(/\s+/g, "");
    let binary;
    try {
      binary = atob(clean);
    } catch (err) {
      throw new SyncError(
        "content",
        `base64 \u89E3\u7801\u5931\u8D25\uFF08\u5185\u5BB9\u53EF\u80FD\u88AB\u622A\u65AD\u6216\u635F\u574F\uFF09\uFF1A${err instanceof Error ? err.message : String(err)}`
      );
    }
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
  var SyncError = class extends Error {
    constructor(kind, message) {
      super(message);
      this.kind = kind;
      this.name = "SyncError";
    }
    kind;
  };
  var GitHubClient = class {
    constructor(opts) {
      this.opts = opts;
    }
    opts;
    url(path) {
      const base = `https://api.github.com/repos/${this.opts.owner}/${this.opts.repo}/contents/${path}`;
      return `${base}?ref=${encodeURIComponent(this.opts.branch)}`;
    }
    headers() {
      return {
        Authorization: `Bearer ${this.opts.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"
      };
    }
    /**
     * 把 HTTP 响应翻译成 SyncError。
     * 分类的意义：'auth' 要停下来让用户换 token，'conflict' 要重新合并重试，
     * 'network' 要稍后再试 —— 三种的处置完全不同。
     */
    async fail(res) {
      let detail = "";
      try {
        const body = await res.json();
        detail = body.message ?? "";
      } catch {
      }
      const status = res.status;
      if (status === 401) throw new SyncError("auth", `\u51ED\u636E\u65E0\u6548\uFF08401\uFF09\uFF1A${detail}`);
      if (status === 403) {
        if (/rate limit|secondary rate/i.test(detail)) {
          throw new SyncError("ratelimit", `\u88AB GitHub \u9650\u901F\uFF08403\uFF09\uFF1A${detail}`);
        }
        throw new SyncError("auth", `\u6CA1\u6709\u6743\u9650\uFF08403\uFF09\uFF1A${detail}`);
      }
      if (status === 404) throw new SyncError("notfound", `\u627E\u4E0D\u5230\uFF08404\uFF09\uFF1A${detail}`);
      if (status === 409) throw new SyncError("conflict", `\u7248\u672C\u51B2\u7A81\uFF08409\uFF09\uFF1A${detail}`);
      if (status === 422) throw new SyncError("content", `\u8BF7\u6C42\u5185\u5BB9\u4E0D\u5408\u6CD5\uFF08422\uFF09\uFF1A${detail}`);
      throw new SyncError("unknown", `GitHub \u8FD4\u56DE ${status}\uFF1A${detail}`);
    }
    async readFile(path) {
      let res;
      try {
        res = await fetchWithTimeout(this.url(path), { headers: this.headers() });
      } catch (err) {
        throw new SyncError("network", `\u8BF7\u6C42\u5931\u8D25\uFF1A${err instanceof Error ? err.message : String(err)}`);
      }
      if (res.status === 404) return null;
      if (!res.ok) await this.fail(res);
      const data = await res.json();
      if (typeof data.sha !== "string" || data.sha === "") {
        throw new SyncError("content", "\u8FDC\u7AEF\u54CD\u5E94\u7F3A\u5C11 sha\uFF0C\u65E0\u6CD5\u5B89\u5168\u5730\u7EE7\u7EED");
      }
      if (typeof data.encoding !== "string" || data.encoding !== "base64") {
        throw new SyncError(
          "content",
          `\u8FDC\u7AEF\u6587\u4EF6\u7684 encoding \u662F "${String(data.encoding)}"\uFF08\u9884\u671F base64\uFF09\u3002\u6587\u4EF6\u53EF\u80FD\u8D85\u8FC7\u4E86 1MB \u2014\u2014 \u8BF7\u5148\u4EBA\u5DE5\u5904\u7406\uFF0C\u4E0D\u8981\u7EE7\u7EED\u540C\u6B65\u3002`
        );
      }
      if (typeof data.content !== "string" || data.content === "") {
        throw new SyncError("content", '\u8FDC\u7AEF\u8FD4\u56DE\u4E86\u7A7A\u5185\u5BB9 \u2014\u2014 \u62D2\u7EDD\u628A\u5B83\u5F53\u4F5C"\u6570\u636E\u4E3A\u7A7A"\u5904\u7406');
      }
      const text = fromBase64(data.content);
      if (text.trim() === "") {
        throw new SyncError("content", "\u8FDC\u7AEF\u6587\u4EF6\u5185\u5BB9\u4E3A\u7A7A\u5B57\u7B26\u4E32 \u2014\u2014 \u62D2\u7EDD\u7EE7\u7EED");
      }
      return { text, sha: data.sha, base64: data.content };
    }
    async writeFile(path, text, message, sha) {
      const body = {
        message,
        content: toBase64(text),
        branch: this.opts.branch,
        // 🔴 缺 committer / author 会得到 422。GitHub 要求提交里必须有身份
        committer: { name: this.opts.owner, email: `${this.opts.owner}@users.noreply.github.com` },
        author: { name: this.opts.owner, email: `${this.opts.owner}@users.noreply.github.com` }
      };
      if (sha) body.sha = sha;
      let res;
      try {
        res = await fetchWithTimeout(
          `https://api.github.com/repos/${this.opts.owner}/${this.opts.repo}/contents/${path}`,
          {
            method: "PUT",
            headers: { ...this.headers(), "Content-Type": "application/json" },
            body: JSON.stringify(body)
          }
        );
      } catch (err) {
        throw new SyncError("network", `\u8BF7\u6C42\u5931\u8D25\uFF1A${err instanceof Error ? err.message : String(err)}`);
      }
      if (!res.ok) await this.fail(res);
    }
    /**
     * 问 GitHub"我是谁"。
     *
     * 🔴 这一步让用户**不用手填 owner** —— 有 token 就知道了。
     *    多用户的第一条体验优化就是它：少填一个字段，少一次填错的机会。
     */
    async identify() {
      const res = await fetchWithTimeout("https://api.github.com/user", {
        headers: this.headers()
      });
      if (!res.ok) await this.fail(res);
      const data = await res.json();
      if (typeof data.login !== "string" || data.login === "") {
        throw new SyncError("content", "GitHub \u7684 /user \u6CA1\u6709\u8FD4\u56DE login\uFF0C\u65E0\u6CD5\u786E\u8BA4\u8D26\u53F7");
      }
      return { login: data.login };
    }
    /**
     * 确保数据仓库存在。
     *
     * 🔴 已存在时**不改动它**，只回报它的可见性 —— 由调用方决定要不要拒绝。
     *    如果用户手上已经有一个同名的公开仓库，我们绝不能把私人想法写进去。
     */
    async ensureRepo(name) {
      const head = await fetchWithTimeout(
        `https://api.github.com/repos/${this.opts.owner}/${name}`,
        { headers: this.headers() }
      );
      if (head.ok) {
        const data = await head.json();
        return {
          created: false,
          private: data.private === true,
          defaultBranch: typeof data.default_branch === "string" ? data.default_branch : void 0
        };
      }
      if (head.status !== 404) await this.fail(head);
      const create = await fetchWithTimeout("https://api.github.com/user/repos", {
        method: "POST",
        headers: { ...this.headers(), "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          private: true,
          auto_init: false,
          description: "\u60F3\u6CD5\u661F\u4E91\u7684\u6570\u636E\u955C\u50CF\uFF08\u79C1\u6709\uFF09"
        })
      });
      if (!create.ok) await this.fail(create);
      return { created: true, private: true, defaultBranch: this.opts.branch };
    }
    /** 读一个文件、取它的文本；不存在返回 null。 */
    async tryReadText(path) {
      const file = await this.readFile(path);
      return file ? { text: file.text, sha: file.sha } : null;
    }
  };

  // src/sync/merge.ts
  var DOC_VERSION = 1;
  function emptyDoc(now = Date.now()) {
    return { version: DOC_VERSION, savedAt: now, spaces: [], ideas: [], purged: [] };
  }
  function compareIdeaContent(l, r) {
    if (l.text !== r.text) return l.text > r.text ? 1 : -1;
    if (l.archived !== r.archived) return l.archived - r.archived;
    if (l.pinned !== r.pinned) return l.pinned - r.pinned;
    if (l.linksAlwaysOn !== r.linksAlwaysOn) return l.linksAlwaysOn - r.linksAlwaysOn;
    if (l.spaceId !== r.spaceId) return l.spaceId > r.spaceId ? 1 : -1;
    return 0;
  }
  function pickByUpdatedAt(l, r) {
    if (l.updatedAt !== r.updatedAt) return l.updatedAt > r.updatedAt ? l : r;
    return compareIdeaContent(l, r) >= 0 ? l : r;
  }
  function pickByMovedAt(l, r) {
    if (l.movedAt !== r.movedAt) return l.movedAt > r.movedAt ? l : r;
    if (l.x !== r.x) return l.x > r.x ? l : r;
    if (l.y !== r.y) return l.y > r.y ? l : r;
    return l;
  }
  function mergeIdea(l, r) {
    const textWinner = pickByUpdatedAt(l, r);
    const posWinner = pickByMovedAt(l, r);
    return {
      ...textWinner,
      x: posWinner.x,
      y: posWinner.y,
      movedAt: posWinner.movedAt
    };
  }
  function mergeSpace(l, r) {
    if (l.updatedAt !== r.updatedAt) return l.updatedAt > r.updatedAt ? l : r;
    if (l.name !== r.name) return l.name > r.name ? l : r;
    if (l.hue !== r.hue) return l.hue > r.hue ? l : r;
    if (l.deleted !== r.deleted) return l.deleted > r.deleted ? l : r;
    if (l.purgeAt !== r.purgeAt) return l.purgeAt > r.purgeAt ? l : r;
    return l;
  }
  function mergeDocs(local, remote) {
    const spaces = /* @__PURE__ */ new Map();
    for (const s of local.spaces) spaces.set(s.id, s);
    for (const s of remote.spaces) {
      const mine = spaces.get(s.id);
      spaces.set(s.id, mine ? mergeSpace(mine, s) : s);
    }
    const ideas = /* @__PURE__ */ new Map();
    for (const i of local.ideas) ideas.set(i.id, i);
    for (const i of remote.ideas) {
      const mine = ideas.get(i.id);
      ideas.set(i.id, mine ? mergeIdea(mine, i) : i);
    }
    const purged = /* @__PURE__ */ new Set([...local.purged ?? [], ...remote.purged ?? []]);
    return {
      version: DOC_VERSION,
      savedAt: Math.max(local.savedAt, remote.savedAt),
      // 排序让结果稳定：同样的输入永远得到字节相同的输出（也就不会产生无意义的 commit）
      spaces: [...spaces.values()].filter((sp) => !purged.has(sp.id)).sort((a, b) => a.id < b.id ? -1 : 1),
      ideas: [...ideas.values()].filter((i) => !purged.has(i.id)).sort((a, b) => a.id < b.id ? -1 : 1),
      purged: [...purged].sort()
    };
  }
  function sameIdea(a, b) {
    if (!a || !b) return a === b;
    return a.text === b.text && a.spaceId === b.spaceId && a.updatedAt === b.updatedAt && a.movedAt === b.movedAt && a.x === b.x && a.y === b.y && a.pinned === b.pinned && a.linksAlwaysOn === b.linksAlwaysOn && a.archived === b.archived;
  }
  function diffDocs(localBefore, merged) {
    const before = new Map(localBefore.ideas.map((i) => [i.id, i]));
    const beforeSpaces = new Set(localBefore.spaces.map((s) => s.id));
    const report = { addedFromRemote: [], remoteWon: [], localWon: [], addedSpaces: [] };
    for (const idea of merged.ideas) {
      const had = before.get(idea.id);
      if (!had) {
        report.addedFromRemote.push(idea.id);
        continue;
      }
      if (sameIdea(had, idea)) report.localWon.push(idea.id);
      else report.remoteWon.push(idea.id);
    }
    for (const space of merged.spaces) {
      if (!beforeSpaces.has(space.id)) report.addedSpaces.push(space.id);
    }
    return report;
  }
  function isEmptyDoc(doc) {
    return doc.spaces.length === 0 && doc.ideas.length === 0;
  }
  function sameDoc(a, b) {
    return serializeDoc(a) === serializeDoc(b);
  }
  function serializeDoc(doc) {
    return `${JSON.stringify(
      {
        version: doc.version,
        savedAt: doc.savedAt,
        spaces: doc.spaces,
        ideas: doc.ideas,
        purged: doc.purged ?? []
      },
      null,
      2
    )}
`;
  }

  // src/sync/settings.ts
  var DB_NAME2 = "nebula-credentials";
  var DB_VERSION2 = 1;
  var STORE = "credentials";
  var RECORD_KEY = "github";
  function hasSubtle() {
    return typeof crypto !== "undefined" && typeof crypto.subtle !== "undefined";
  }
  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME2, DB_VERSION2);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("\u6253\u4E0D\u5F00\u51ED\u636E\u5E93"));
    });
  }
  function tx(mode, fn) {
    return openDb().then(
      (db) => new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error("\u51ED\u636E\u8BFB\u5199\u5931\u8D25"));
        t.oncomplete = () => db.close();
      })
    );
  }
  async function saveCredential(target, token) {
    let record;
    if (hasSubtle()) {
      const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
        "encrypt",
        "decrypt"
      ]);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const cipher = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        new TextEncoder().encode(token)
      );
      record = { target, cipher, iv, key, plain: null };
    } else {
      record = { target, cipher: null, iv: null, key: null, plain: token };
    }
    await tx("readwrite", (store) => store.put(record, RECORD_KEY));
  }
  async function loadCredential() {
    let record;
    try {
      record = await tx("readonly", (store) => store.get(RECORD_KEY));
    } catch {
      return null;
    }
    if (!record?.target) return null;
    if (record.plain) return { target: record.target, token: record.plain };
    if (!record.key || !record.cipher || !record.iv) return null;
    try {
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: record.iv },
        record.key,
        record.cipher
      );
      return { target: record.target, token: new TextDecoder().decode(plain) };
    } catch {
      return null;
    }
  }
  async function clearCredential() {
    await tx("readwrite", (store) => store.delete(RECORD_KEY));
  }
  async function credentialRecordExists() {
    try {
      return await tx("readonly", (store) => store.get(RECORD_KEY)) !== void 0;
    } catch {
      return false;
    }
  }
  function isCredentialEncrypted() {
    return hasSubtle();
  }

  // src/sync/syncEngine.ts
  var DIRTY_DEBOUNCE_MS = 6e4;
  var PUSH_THROTTLE_MS = 2 * 60 * 6e4;
  var MAX_CONFLICT_RETRIES = 2;
  var CONFIG_PATH = "data/sync.config.json";
  function defaultConfig(now = Date.now()) {
    return {
      version: 1,
      file: "data/ideas.json",
      backupFile: "data/ideas.backup.json",
      fallbackToBackup: false,
      savedAt: now
    };
  }
  function ownerVerdict(localOwner, account) {
    if (!account) return "ok";
    if (!localOwner) return "first-time";
    return localOwner === account ? "ok" : "mismatch";
  }
  var SYNC_KINDS = /* @__PURE__ */ new Set([
    "auth",
    "notfound",
    "conflict",
    "ratelimit",
    "network",
    "content",
    "unknown"
  ]);
  function errorKind(err) {
    if (err instanceof SyncError) return err.kind;
    const kind = err?.kind;
    if (typeof kind === "string" && SYNC_KINDS.has(kind)) return kind;
    return "unknown";
  }
  var LOCK_NAME = "nebula-sync";
  var CHANNEL_NAME = "nebula-sync";
  var SyncEngine = class {
    constructor(deps) {
      this.deps = deps;
      if (typeof BroadcastChannel !== "undefined") {
        this.channel = new BroadcastChannel(CHANNEL_NAME);
        this.channel.addEventListener("message", (e) => {
          if (e.data?.type === "local-updated") {
            this.deps.onExternalUpdate?.();
          }
        });
      }
      this.emit();
    }
    deps;
    snapshotValue = {
      status: "local-only",
      detail: "\u53EA\u5B58\u5728\u8FD9\u53F0\u8BBE\u5907",
      lastSyncAt: null,
      lastError: null,
      dirty: false,
      lastAdded: 0,
      lastRemoteWon: 0,
      everPushed: false
    };
    lastPushAt = 0;
    timer = 0;
    running = false;
    channel = null;
    /** 当前远端凭据对应的账号（由上层在配置时通过 setAccount 告知）。 */
    account = null;
    /** 上一次成功写进 backup 的内容，用来避免"内容没变也产生一个 commit"。 */
    lastBackupBody = null;
    get snapshot() {
      return this.snapshotValue;
    }
    /** 告知引擎"这份凭据是谁的"。做账号守卫要用。 */
    setAccount(handle) {
      this.account = handle;
    }
    get accountHandle() {
      return this.account;
    }
    setRemote(remote) {
      this.deps = { ...this.deps, remote };
      if (!remote) {
        this.patch({ status: "local-only", detail: "\u53EA\u5B58\u5728\u8FD9\u53F0\u8BBE\u5907", dirty: false });
      } else if (this.snapshotValue.status === "local-only") {
        this.patch({ status: "idle", detail: "\u7B49\u5F85\u540C\u6B65" });
      }
    }
    /** 标脏：本地有新东西了，稍后自动推。 */
    markDirty() {
      this.patch({ dirty: true });
      window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => void this.sync(), DIRTY_DEBOUNCE_MS);
    }
    patch(next) {
      this.snapshotValue = { ...this.snapshotValue, ...next };
      this.emit();
    }
    emit() {
      this.deps.onState?.(this.snapshotValue);
    }
    /** 跑一轮完整的同步。force = true 时绕过节流与 dirty 判断（手动按钮、关页面时用）。 */
    async sync(opts = {}) {
      const remote = this.deps.remote;
      if (!remote) {
        this.patch({ status: "local-only", detail: "\u53EA\u5B58\u5728\u8FD9\u53F0\u8BBE\u5907" });
        return;
      }
      if (this.running) return;
      const run = async () => {
        this.running = true;
        try {
          await this.runOnce(remote, opts.force === true);
        } finally {
          this.running = false;
        }
      };
      if (typeof navigator !== "undefined" && navigator.locks) {
        await navigator.locks.request(LOCK_NAME, run);
      } else {
        await run();
      }
    }
    async runOnce(remote, force) {
      this.patch({ status: "pulling", detail: "\u6B63\u5728\u540C\u6B65\u2026", lastError: null });
      try {
        const localOwner = await this.deps.readOwnerHandle();
        const verdict = ownerVerdict(localOwner, this.account);
        if (verdict === "mismatch") {
          throw new SyncError(
            "owner-mismatch",
            `\u8FD9\u53F0\u8BBE\u5907\u4E0A\u7684\u6570\u636E\u5C5E\u4E8E @${localOwner}\uFF0C\u800C\u5F53\u524D\u8D26\u53F7\u662F @${this.account}\u3002\u4E3A\u4E86\u4E0D\u628A @${localOwner} \u7684\u60F3\u6CD5\u63A8\u5230 @${this.account} \u7684\u4ED3\u5E93\u91CC\uFF0C\u540C\u6B65\u5DF2\u505C\u6B62\u3002`
          );
        }
        let config = defaultConfig();
        const configFile = await remote.readFile(CONFIG_PATH);
        if (configFile) {
          config = parseConfig(configFile);
        } else {
          await remote.writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}
`, "\u521D\u59CB\u5316\u540C\u6B65\u914D\u7F6E");
        }
        let remoteDoc;
        if (config.fallbackToBackup) {
          const backup = await remote.readFile(config.backupFile);
          if (!backup) {
            throw new SyncError("content", "\u914D\u7F6E\u8981\u6C42\u4ECE\u5907\u4EFD\u56DE\u9000\uFF0C\u4F46\u5907\u4EFD\u6587\u4EF6\u4E0D\u5B58\u5728");
          }
          remoteDoc = parseDoc(backup.text, "\u5907\u4EFD\u6587\u4EF6");
          this.patch({ detail: "\u6B63\u5728\u4ECE\u5907\u4EFD\u6062\u590D\u2026" });
          config = { ...config, fallbackToBackup: false, savedAt: Date.now() };
          await remote.writeFile(
            CONFIG_PATH,
            `${JSON.stringify(config, null, 2)}
`,
            "\u56DE\u9000\u5B8C\u6210\uFF0C\u6E05\u9664 fallbackToBackup",
            configFile?.sha
          );
        } else {
          const file = await remote.readFile(config.file);
          if (file) {
            remoteDoc = parseDoc(file.text, "\u8FDC\u7AEF\u6570\u636E");
          } else {
            remoteDoc = emptyDoc();
          }
        }
        if (verdict === "first-time" && this.account) {
          await this.deps.writeOwnerHandle(this.account);
        }
        const localDoc = await this.deps.readLocal();
        const merged = mergeDocs(localDoc, remoteDoc);
        if (isEmptyDoc(merged) && !isEmptyDoc(localDoc)) {
          throw new SyncError(
            "content",
            "\u5408\u5E76\u7ED3\u679C\u4E3A\u7A7A\u4F46\u672C\u5730\u6709\u6570\u636E \u2014\u2014 \u5DF2\u62D2\u7EDD\u63A8\u9001\uFF0C\u5E76\u4FDD\u7559\u672C\u5730\u6570\u636E\u4E0D\u52A8"
          );
        }
        const report = diffDocs(localDoc, merged);
        const changedLocally = report.addedFromRemote.length > 0 || report.remoteWon.length > 0 || report.addedSpaces.length > 0;
        if (changedLocally) {
          await this.deps.writeLocal(merged);
          this.deps.onMerged?.(report, merged, localDoc);
          this.channel?.postMessage({ type: "local-updated" });
        }
        const throttled = !force && Date.now() - this.lastPushAt < PUSH_THROTTLE_MS;
        const needPush = this.snapshotValue.dirty || changedLocally;
        if (!needPush) {
          this.patch({
            status: changedLocally ? "merged" : "idle",
            detail: changedLocally ? `\u5DF2\u5408\u5E76 ${report.addedFromRemote.length} \u6761` : "\u5DF2\u662F\u6700\u65B0",
            lastSyncAt: Date.now(),
            lastAdded: report.addedFromRemote.length,
            lastRemoteWon: report.remoteWon.length
          });
          return;
        }
        if (throttled && !force) {
          this.patch({
            status: changedLocally ? "merged" : "idle",
            detail: `\u5DF2\u5408\u5E76 ${report.addedFromRemote.length} \u6761 \xB7 \u7A0D\u540E\u63A8\u9001`,
            lastSyncAt: Date.now(),
            lastAdded: report.addedFromRemote.length,
            lastRemoteWon: report.remoteWon.length
          });
          return;
        }
        if (!config.fallbackToBackup && sameDoc(merged, remoteDoc)) {
          this.lastPushAt = Date.now();
          this.patch({
            status: "idle",
            detail: "\u5DF2\u662F\u6700\u65B0\uFF08\u65E0\u9700\u63A8\u9001\uFF09",
            lastSyncAt: Date.now(),
            dirty: false,
            lastAdded: report.addedFromRemote.length,
            lastRemoteWon: report.remoteWon.length
          });
          return;
        }
        this.patch({ status: "pushing", detail: "\u6B63\u5728\u5907\u4EFD\u2026" });
        await this.writeBackupIfChanged(remote, config, remoteDoc);
        await this.pushWithRetry(remote, config, localDoc);
        this.lastPushAt = Date.now();
        this.patch({
          status: "idle",
          detail: `@${this.account ?? ""} \u5DF2\u5907\u4EFD \xB7 ${(/* @__PURE__ */ new Date()).toLocaleTimeString("zh-CN", { hour12: false })}`,
          lastSyncAt: Date.now(),
          dirty: false,
          lastError: null,
          everPushed: true,
          lastAdded: report.addedFromRemote.length,
          lastRemoteWon: report.remoteWon.length
        });
      } catch (err) {
        const kind = errorKind(err);
        const message = err instanceof Error ? err.message : String(err);
        this.patch({
          status: "error",
          detail: detailFor(kind, message),
          lastError: message,
          // 🔴 凭据无效时清理 dirty，避免每次操作都重试一遍必然失败的请求
          dirty: kind === "auth" ? false : this.snapshotValue.dirty
        });
      }
    }
    /** 把远端原文存到 backup。内容没变就跳过（否则每次同步都会多一个 commit）。 */
    async writeBackupIfChanged(remote, config, remoteDoc) {
      const body = serializeDoc(remoteDoc);
      if (this.lastBackupBody === body) return;
      const existing = await remote.readFile(config.backupFile);
      if (existing && normalizeWhitespace(existing.text) === normalizeWhitespace(body)) {
        this.lastBackupBody = body;
        return;
      }
      await remote.writeFile(
        config.backupFile,
        body,
        "\u540C\u6B65\u524D\u5907\u4EFD\uFF08\u56DE\u9000\u7528\uFF09",
        existing?.sha
      );
      this.lastBackupBody = body;
    }
    /** 推送，遇到 409 就重新拉取 + 重新合并 + 再推。 */
    async pushWithRetry(remote, config, localSnapshot) {
      let doc = mergeDocs(localSnapshot, await this.deps.readLocal());
      for (let attempt = 0; attempt <= MAX_CONFLICT_RETRIES; attempt++) {
        const current = await remote.readFile(config.file);
        if (current) {
          const remoteDoc = parseDoc(current.text, "\u8FDC\u7AEF\u6570\u636E");
          doc = mergeDocs(doc, remoteDoc);
          if (sameDoc(doc, remoteDoc)) return;
        }
        try {
          await remote.writeFile(config.file, serializeDoc(doc), `\u540C\u6B65\u60F3\u6CD5\uFF08${doc.ideas.length} \u6761\uFF09`, current?.sha);
          await this.deps.writeLocal(doc);
          return;
        } catch (err) {
          const kind = errorKind(err);
          if (kind !== "conflict" || attempt === MAX_CONFLICT_RETRIES) throw err;
          doc = mergeDocs(doc, await this.deps.readLocal());
        }
      }
    }
    destroy() {
      window.clearTimeout(this.timer);
      this.channel?.close();
    }
  };
  function normalizeWhitespace(s) {
    return s.replace(/\s+/g, " ").trim();
  }
  function detailFor(kind, message) {
    switch (kind) {
      case "auth":
        return "\u5907\u4EFD\u5931\u8D25\uFF1A\u51ED\u636E\u65E0\u6548\u6216\u65E0\u6743\u9650 \xB7 \u70B9\u6B64\u91CD\u65B0\u914D\u7F6E";
      case "ratelimit":
        return "\u5907\u4EFD\u5931\u8D25\uFF1AGitHub \u9650\u901F \xB7 \u7A0D\u540E\u81EA\u52A8\u91CD\u8BD5";
      case "network":
        return "\u5907\u4EFD\u5931\u8D25\uFF1A\u7F51\u7EDC\u4E0D\u901A \xB7 \u672C\u5730\u6570\u636E\u4E0D\u53D7\u5F71\u54CD";
      case "content":
        return "\u5907\u4EFD\u5931\u8D25\uFF1A\u8FDC\u7AEF\u5185\u5BB9\u5F02\u5E38 \xB7 \u5DF2\u505C\u6B62\u540C\u6B65\u4EE5\u4FDD\u62A4\u672C\u5730\u6570\u636E";
      case "conflict":
        return "\u5907\u4EFD\u5931\u8D25\uFF1A\u7248\u672C\u51B2\u7A81 \xB7 \u4F1A\u91CD\u8BD5";
      case "owner-mismatch":
        return "\u672C\u673A\u6570\u636E\u5C5E\u4E8E\u53E6\u4E00\u4E2A\u8D26\u53F7 \xB7 \u70B9\u6B64\u5904\u7406";
      default:
        return `\u5907\u4EFD\u5931\u8D25\uFF1A${message}`;
    }
  }
  function parseConfig(file) {
    let raw;
    try {
      raw = JSON.parse(file.text);
    } catch (err) {
      throw new SyncError(
        "content",
        `sync.config.json \u89E3\u6790\u5931\u8D25\uFF1A${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (typeof raw !== "object" || raw === null) {
      throw new SyncError("content", "sync.config.json \u4E0D\u662F\u5BF9\u8C61");
    }
    const cfg = raw;
    const base = defaultConfig();
    return {
      version: typeof cfg.version === "number" ? cfg.version : base.version,
      file: typeof cfg.file === "string" && cfg.file !== "" ? cfg.file : base.file,
      backupFile: typeof cfg.backupFile === "string" && cfg.backupFile !== "" ? cfg.backupFile : base.backupFile,
      // 只有严格等于 true 才回退 —— 写错字符串不会误触发
      fallbackToBackup: cfg.fallbackToBackup === true,
      savedAt: typeof cfg.savedAt === "number" ? cfg.savedAt : base.savedAt
    };
  }
  function parseDoc(text, label) {
    if (text.trim() === "") {
      throw new SyncError("content", `${label}\u4E3A\u7A7A\u5B57\u7B26\u4E32 \u2014\u2014 \u62D2\u7EDD\u7EE7\u7EED`);
    }
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new SyncError(
        "content",
        `${label}\u89E3\u6790\u5931\u8D25\uFF08\u53EF\u80FD\u88AB\u622A\u65AD\u6216\u635F\u574F\uFF09\uFF1A${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (typeof raw !== "object" || raw === null) {
      throw new SyncError("content", `${label}\u4E0D\u662F\u5BF9\u8C61`);
    }
    const doc = raw;
    if (!Array.isArray(doc.spaces) || !Array.isArray(doc.ideas)) {
      throw new SyncError("content", `${label}\u7F3A\u5C11 spaces / ideas \u6570\u7EC4`);
    }
    return {
      version: typeof doc.version === "number" ? doc.version : 1,
      savedAt: typeof doc.savedAt === "number" ? doc.savedAt : 0,
      spaces: doc.spaces,
      ideas: doc.ideas,
      purged: Array.isArray(doc.purged) ? doc.purged.filter((x) => typeof x === "string") : []
    };
  }

  // src/ui/input.ts
  function mountInput(options) {
    const { el, onSubmit, onNotice } = options;
    let composing = false;
    let busy = false;
    const autoGrow = () => {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
    };
    async function submit() {
      if (busy) return;
      const cleaned = norm(el.value);
      if (cleaned === "") {
        onNotice?.("\u7A7A\u7684\uFF0C\u6CA1\u6709\u8BB0\u4E0B", "warn");
        return;
      }
      const { text, clipped } = clampText(cleaned, MAX_TEXT);
      if (clipped) onNotice?.(`\u8D85\u8FC7 ${MAX_TEXT} \u5B57\uFF0C\u5DF2\u622A\u65AD`, "warn");
      busy = true;
      try {
        await onSubmit(text);
        el.value = "";
        autoGrow();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        onNotice?.(`\u6CA1\u5B58\u4E0A\uFF1A${message}`, "error");
      } finally {
        busy = false;
      }
    }
    const onCompositionStart = () => {
      composing = true;
    };
    const onCompositionEnd = () => {
      composing = false;
    };
    const onKeyDown = (e) => {
      if (e.key !== "Enter") return;
      if (e.shiftKey) return;
      if (composing || e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      void submit();
    };
    const onInput = () => {
      autoGrow();
    };
    el.addEventListener("compositionstart", onCompositionStart);
    el.addEventListener("compositionend", onCompositionEnd);
    el.addEventListener("keydown", onKeyDown);
    el.addEventListener("input", onInput);
    autoGrow();
    return {
      focus: () => el.focus(),
      destroy: () => {
        el.removeEventListener("compositionstart", onCompositionStart);
        el.removeEventListener("compositionend", onCompositionEnd);
        el.removeEventListener("keydown", onKeyDown);
        el.removeEventListener("input", onInput);
      }
    };
  }

  // src/ui/search.ts
  var SEARCH_DEBOUNCE_MS = 120;
  var JUMP_IDLE_MS = 4e3;
  function splitByQuery(text, query) {
    if (text === "") return [{ text: "", hit: false }];
    if (query === "") return [{ text, hit: false }];
    const lowerText = text.toLowerCase();
    const lowerQuery = query.toLowerCase();
    const out = [];
    let cursor = 0;
    for (; ; ) {
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
    const wanted = /* @__PURE__ */ new Set();
    for (const ch of lowerQuery) wanted.add(ch);
    let hasAny = false;
    for (const ch of text) {
      if (wanted.has(ch.toLowerCase())) hasAny = true;
    }
    if (!hasAny) return [{ text, hit: false }];
    let buffer = "";
    let bufferHit = false;
    const flush = () => {
      if (buffer !== "") out.push({ text: buffer, hit: bufferHit });
      buffer = "";
    };
    for (const ch of text) {
      const hit = wanted.has(ch.toLowerCase());
      if (hit !== bufferHit && buffer !== "") flush();
      bufferHit = hit;
      buffer += ch;
    }
    flush();
    return out.length > 0 ? out : [{ text, hit: false }];
  }
  function planReconcile(existing, segments) {
    return segments.map((seg, i) => {
      const node = existing[i];
      if (!node) return false;
      const wantTag = seg.hit ? "MARK" : "#text";
      return node.tag === wantTag && node.text === seg.text;
    });
  }
  function rankMatches(items, query) {
    if (query === "") return [];
    const scored = items.map((item, index) => ({ id: item.id, score: scoreMatch(item.text, query), index })).filter((m) => m.score > 0);
    scored.sort((a, b) => b.score !== a.score ? b.score - a.score : a.index - b.index);
    return scored.map((m) => ({ id: m.id, score: m.score }));
  }
  function stepIndex(current, total, backward) {
    if (total <= 0) return -1;
    if (current < 0) return backward ? total - 1 : 0;
    return backward ? (current - 1 + total) % total : (current + 1) % total;
  }
  function countLabel(hits, query) {
    if (query === "") return "";
    return `\u2315 ${hits} \u6761`;
  }
  function otherSpaceHint(spaceName, count) {
    return `\u5176\u4ED6\u7A7A\u95F4\u8FD8\u6709 ${count} \u6761\u547D\u4E2D \xB7 \u53BB\u300C${spaceName}\u300D\u770B\u770B`;
  }
  function pulseKeyframes() {
    return [
      { transform: "scale(1)", offset: 0 },
      { transform: "scale(1.14)", offset: 0.35 },
      { transform: "scale(1)", offset: 1 }
    ];
  }
  function shapeOfNode(node) {
    return {
      tag: node.nodeType === Node.TEXT_NODE ? "#text" : node.tagName,
      text: node.textContent ?? ""
    };
  }
  function renderSegments(label, segments) {
    const nodes = Array.from(label.childNodes);
    const existing = nodes.map(shapeOfNode);
    const reuse = planReconcile(existing, segments);
    let touched = false;
    for (let i = existing.length - 1; i >= segments.length; i--) {
      nodes[i]?.remove();
      touched = true;
    }
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i];
      const node = label.childNodes[i];
      if (reuse[i] && node) continue;
      const next = seg.hit ? document.createElement("mark") : document.createTextNode("");
      next.textContent = seg.text;
      if (node) label.replaceChild(next, node);
      else label.appendChild(next);
      touched = true;
    }
    return touched;
  }
  function mountSearch(input, countEl, hintEl, host) {
    let query = "";
    let hits = [];
    let jumpIndex = -1;
    let lastJumpAt = 0;
    let composing = false;
    let timer = 0;
    let generation = 0;
    function applyState() {
      const targets = host.targets();
      if (query === "") {
        host.clear();
        countEl.textContent = "";
        hintEl.hidden = true;
        return;
      }
      hits = rankMatches(targets, query);
      const hitIds = new Set(hits.map((h) => h.id));
      host.apply(
        targets.map((t) => ({ id: t.id, hit: hitIds.has(t.id) })),
        query
      );
      countEl.textContent = countLabel(hits.length, query);
      const gen = generation;
      void host.otherSpaceMatches(query).then((others) => {
        if (gen !== generation) return;
        if (others.length === 0) {
          hintEl.hidden = true;
          return;
        }
        const total = others.reduce((sum, o) => sum + o.count, 0);
        hintEl.textContent = otherSpaceHint(others[0].name, total);
        hintEl.dataset.spaceId = others[0].spaceId;
        hintEl.hidden = false;
      }).catch(() => {
        hintEl.hidden = true;
      });
    }
    function run() {
      if (composing) return;
      generation++;
      query = input.value.trim();
      jumpIndex = -1;
      applyState();
    }
    function schedule() {
      window.clearTimeout(timer);
      timer = window.setTimeout(run, SEARCH_DEBOUNCE_MS);
    }
    function onInput(e) {
      if (composing || e.isComposing) return;
      schedule();
    }
    function onCompositionStart() {
      composing = true;
    }
    function onCompositionEnd() {
      composing = false;
      schedule();
    }
    function onKeyDown(e) {
      if (e.key !== "Enter") return;
      if (composing || e.isComposing || e.keyCode === 229) return;
      if (hits.length === 0) return;
      e.preventDefault();
      const now = performance.now();
      if (now - lastJumpAt > JUMP_IDLE_MS) jumpIndex = -1;
      lastJumpAt = now;
      jumpIndex = stepIndex(jumpIndex, hits.length, e.shiftKey);
      const target = hits[jumpIndex];
      if (!target) return;
      host.centerOn(target.id);
      host.pulse(target.id);
    }
    function clear() {
      window.clearTimeout(timer);
      input.value = "";
      query = "";
      hits = [];
      jumpIndex = -1;
      generation++;
      host.clear();
      countEl.textContent = "";
      hintEl.hidden = true;
    }
    input.addEventListener("input", onInput);
    input.addEventListener("compositionstart", onCompositionStart);
    input.addEventListener("compositionend", onCompositionEnd);
    input.addEventListener("keydown", onKeyDown);
    hintEl.addEventListener("click", () => {
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
      }
    };
  }

  // src/ui/spaceLayer.ts
  var SpaceLayer = class {
    root;
    listEl;
    backdrop;
    opts;
    rows = /* @__PURE__ */ new Map();
    currentId = null;
    opened = false;
    pendingRenameId = null;
    renaming = null;
    constructor(root, opts) {
      this.root = root;
      this.opts = opts;
      this.backdrop = root.querySelector(".layer-backdrop");
      this.listEl = root.querySelector(".space-list");
      this.backdrop.addEventListener("click", () => this.close());
      root.querySelector("#space-create").addEventListener(
        "click",
        () => this.opts.onCreate()
      );
      root.querySelector("#space-trash").addEventListener(
        "click",
        () => this.opts.onOpenTrash()
      );
      this.root.addEventListener("keydown", (e) => {
        if (e.key !== "Escape") return;
        if (this.renaming) this.cancelRename();
        else this.close();
      });
    }
    get isOpen() {
      return this.opened;
    }
    show(spaces, currentId, focusRename) {
      this.currentId = currentId;
      this.pendingRenameId = focusRename ?? null;
      this.render(spaces);
      this.root.hidden = false;
      this.root.classList.add("layer--visible");
      this.opened = true;
    }
    close() {
      if (this.renaming) this.cancelRename();
      this.root.classList.remove("layer--visible");
      this.root.hidden = true;
      this.opened = false;
      this.pendingRenameId = null;
    }
    /** 空间列表变化（新建 / 删除 / 恢复 / 改名）后刷新。 */
    render(spaces) {
      const alive = spaces.filter((s) => s.deleted === 0);
      const seen = /* @__PURE__ */ new Set();
      for (const space of alive) {
        seen.add(space.id);
        let row = this.rows.get(space.id);
        if (!row) {
          row = this.buildRow(space);
          this.listEl.appendChild(row.root);
        }
        row.space = space;
        row.label.textContent = space.name;
        row.root.classList.toggle("is-current", space.id === this.currentId);
        row.root.style.setProperty("--accent", hueAccent(space.hue));
        row.root.style.setProperty("--accent-soft", hueSoft(space.hue));
        row.del.title = `\u5220\u9664\u7A7A\u95F4\u300C${space.name}\u300D`;
        row.del.disabled = alive.length <= 1;
      }
      for (const [id, row] of [...this.rows]) {
        if (seen.has(id)) continue;
        row.root.remove();
        this.rows.delete(id);
      }
      let i = 0;
      for (const row of this.rows.values()) {
        row.root.style.setProperty("--delay", `${i * 26}ms`);
        row.root.classList.add("is-visible");
        i++;
      }
      if (this.pendingRenameId) {
        const target = this.pendingRenameId;
        this.pendingRenameId = null;
        window.setTimeout(() => this.startRename(target), 120);
      }
    }
    buildRow(space) {
      const root = document.createElement("div");
      root.className = "space-chip";
      root.dataset.spaceId = space.id;
      root.style.setProperty("--accent", hueAccent(space.hue));
      root.style.setProperty("--accent-soft", hueSoft(space.hue));
      const main = document.createElement("button");
      main.type = "button";
      main.className = "space-chip-main";
      main.setAttribute("aria-label", `\u7A7A\u95F4 ${space.name}`);
      const label = document.createElement("span");
      label.className = "space-chip-label";
      label.textContent = space.name;
      main.appendChild(label);
      const del = document.createElement("button");
      del.type = "button";
      del.className = "space-chip-del";
      del.textContent = "\xD7";
      del.title = `\u5220\u9664\u7A7A\u95F4\u300C${space.name}\u300D`;
      del.setAttribute("aria-label", `\u5220\u9664\u7A7A\u95F4 ${space.name}`);
      root.append(main, del);
      const row = { space, root, main, label, del, renameInput: null };
      this.rows.set(space.id, row);
      main.addEventListener("click", () => this.handleClick(space.id));
      main.addEventListener("dblclick", (e) => {
        e.preventDefault();
        this.startRename(space.id);
      });
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        this.opts.onDelete(space.id);
      });
      return row;
    }
    handleClick(spaceId) {
      if (this.renaming) return;
      if (spaceId === this.currentId) {
        this.close();
        return;
      }
      this.opts.onSwitch(spaceId);
    }
    // ── 原地重命名 ────────────────────────────────────────
    startRename(spaceId) {
      const row = this.rows.get(spaceId);
      if (!row || this.renaming) return;
      this.renaming = spaceId;
      row.root.classList.add("is-renaming");
      const input = document.createElement("input");
      input.type = "text";
      input.className = "space-chip-input";
      input.value = row.space.name;
      input.maxLength = 24;
      input.setAttribute("aria-label", "\u7A7A\u95F4\u540D");
      row.label.replaceWith(input);
      row.renameInput = input;
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          this.commitRename(input.value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          this.cancelRename();
        }
        e.stopPropagation();
      });
      input.addEventListener("click", (e) => e.stopPropagation());
      input.addEventListener("dblclick", (e) => e.stopPropagation());
      input.addEventListener("blur", () => {
        if (this.renaming === spaceId) this.commitRename(input.value);
      });
      input.focus();
      input.select();
    }
    commitRename(raw) {
      const spaceId = this.renaming;
      if (!spaceId) return;
      this.renaming = null;
      const row = this.rows.get(spaceId);
      if (!row) return;
      row.root.classList.remove("is-renaming");
      if (row.renameInput) {
        row.renameInput.replaceWith(row.label);
        row.renameInput = null;
      }
      const name = raw.trim().slice(0, 24);
      if (name === "" || name === row.space.name) return;
      this.opts.onRename(spaceId, name);
    }
    cancelRename() {
      const spaceId = this.renaming;
      if (!spaceId) return;
      this.renaming = null;
      const row = this.rows.get(spaceId);
      if (!row) return;
      row.root.classList.remove("is-renaming");
      if (row.renameInput) {
        row.renameInput.replaceWith(row.label);
        row.renameInput = null;
      }
    }
  };

  // src/ui/trash.ts
  var DAY_MS = 24 * 60 * 60 * 1e3;
  var TrashLayer = class {
    root;
    listEl;
    backdrop;
    emptyEl;
    opts;
    open = false;
    constructor(root, opts) {
      this.root = root;
      this.opts = opts;
      this.backdrop = root.querySelector(".layer-backdrop");
      this.listEl = root.querySelector(".trash-list");
      this.emptyEl = root.querySelector(".trash-empty");
      this.backdrop.addEventListener("click", () => this.close());
      root.querySelector("#trash-close").addEventListener(
        "click",
        () => this.close()
      );
      root.querySelector("#trash-empty-btn").addEventListener(
        "click",
        () => this.opts.onEmpty()
      );
      this.root.addEventListener("keydown", (e) => {
        if (e.key === "Escape") this.close();
      });
    }
    get isOpen() {
      return this.open;
    }
    show(entries, now = Date.now()) {
      this.render(entries, now);
      this.root.hidden = false;
      this.root.classList.add("layer--visible");
      this.open = true;
    }
    close() {
      this.root.classList.remove("layer--visible");
      this.root.hidden = true;
      this.open = false;
    }
    render(entries, now = Date.now()) {
      this.listEl.replaceChildren();
      if (entries.length === 0) {
        this.emptyEl.hidden = false;
        return;
      }
      this.emptyEl.hidden = true;
      const sorted = [...entries].sort((a, b) => a.purgeAt - b.purgeAt);
      for (const entry of sorted) {
        const li = document.createElement("li");
        li.className = "trash-item";
        li.dataset.trashId = entry.id;
        const isSpace = entry.kind === "space";
        const name = isSpace ? entry.space?.name ?? "\uFF08\u65E0\u540D\u7A7A\u95F4\uFF09" : entry.idea?.text ?? "\uFF08\u7A7A\u60F3\u6CD5\uFF09";
        const count = isSpace ? entry.ideas?.length ?? 0 : 1;
        if (isSpace && entry.space) {
          li.style.setProperty("--accent", hueAccent(entry.space.hue));
        }
        const title = document.createElement("div");
        title.className = "trash-title";
        title.textContent = name;
        const meta = document.createElement("div");
        meta.className = "trash-meta";
        const days = Math.max(0, Math.ceil((entry.purgeAt - now) / DAY_MS));
        meta.textContent = isSpace ? `\u7A7A\u95F4 \xB7 ${count} \u6761\u60F3\u6CD5 \xB7 ${days} \u5929\u540E\u6E05\u9664` : `\u60F3\u6CD5 \xB7 ${days} \u5929\u540E\u6E05\u9664`;
        const restoreBtn = document.createElement("button");
        restoreBtn.type = "button";
        restoreBtn.className = "btn btn--small";
        restoreBtn.textContent = "\u6062\u590D";
        restoreBtn.addEventListener("click", () => this.opts.onRestore(entry.id));
        const text = document.createElement("div");
        text.className = "trash-text";
        text.append(title, meta);
        li.append(text, restoreBtn);
        this.listEl.appendChild(li);
      }
    }
  };

  // src/main.ts
  var HEART_ID = "__heart__";
  var DOUBLE_CLICK_GUARD_MS = 220;
  var DATA_REPO_NAME = "nebula-data";
  var DEFAULT_BRANCH = "main";
  function must(selector) {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`\u9875\u9762\u7F3A\u5C11\u5FC5\u9700\u7684\u5143\u7D20\uFF1A${selector}`);
    return el;
  }
  function makeNotice(el) {
    return (message, kind = "info") => {
      el.textContent = message;
      el.dataset.kind = kind;
      if (message === "") delete el.dataset.kind;
    };
  }
  function spawnPointFor(ideaId) {
    const rng = makeRng(`spawn:${ideaId}`);
    const angle = rng.range(0, Math.PI * 2);
    const min2 = SPAWN_MIN_RADIUS * SPAWN_MIN_RADIUS;
    const max2 = SPAWN_MAX_RADIUS * SPAWN_MAX_RADIUS;
    const radius = Math.sqrt(min2 + rng.next() * (max2 - min2));
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
  }
  var App = class {
    store = new NebulaStore();
    field = new ForceField();
    stage;
    world;
    spaceNameEl;
    spaceCountEl;
    inputEl;
    notice;
    spaceLayer;
    trashLayer;
    spaces = [];
    current = null;
    /** ideaId → 泡泡 DOM */
    views = /* @__PURE__ */ new Map();
    /** Full records and bodies survive DOM culling; searching never reads only the views. */
    currentIdeas = /* @__PURE__ */ new Map();
    pinch = null;
    cancelPan = () => {
    };
    heartView = null;
    heartBody = null;
    viewport = identityViewport();
    rafId = 0;
    frameIndex = 0;
    viewportSaveTimer = 0;
    drag = null;
    /** 当前打开的放大态。同一时刻只允许一个。 */
    zoom = null;
    /** 搜索控制器。在构造函数里挂上，openSpace 之前就存在。 */
    search = null;
    searchInput;
    searchHint;
    /** 每个泡泡上一次渲染高亮用的查询词 —— 没变就完全不碰 DOM（避免闪烁）。 */
    markQuery = /* @__PURE__ */ new Map();
    /** 跨空间搜索用的全量想法缓存。任何数据变动都要置脏。 */
    searchCache = null;
    searchDirty = true;
    /** 视口补间的句柄（Enter 跳转时把命中的那条移到屏幕中央）。 */
    viewportAnim = 0;
    /** 最近一次被"居中"的泡泡 id（自动化测试用）。 */
    lastCenteredId = null;
    /**
     * 造远端客户端的工厂。
     *
     * 🔴 抽成一层是为了让自动化测试能换成内存实现 ——
     *    "粘贴 token 之后全自动"这条路径涉及真实 GitHub 调用（/user、/user/repos），
     *    不抽这一层就完全测不到，而它恰恰是多用户的第一步体验。
     */
    remoteFactory = (opts) => new GitHubClient(opts);
    /** 同步引擎。没有配置远端时是"纯本地"模式。 */
    sync = null;
    syncBar;
    syncLayer;
    /**
     * 拖拽过、但还没把最终坐标写回数据库的 idea。
     * 值是该位置的"被放下时刻"（写进 movedAt，不是写入时刻 —— 两者差几百毫秒，
     * 但 movedAt 是给同步合并做 LWW 比较用的，越接近真实变化时刻越准）。
     */
    pendingPosition = /* @__PURE__ */ new Map();
    positionSaveTimer = 0;
    /** 待处理的单击（等双击判别窗口过去才真正放大）。 */
    tapTimer = 0;
    /** 上一次单击的泡泡与时刻 —— 用来识别"同一位置的第二次按下"。 */
    lastTapView = null;
    lastTapAt = 0;
    constructor() {
      this.stage = must("#stage");
      this.world = must("#world");
      this.spaceNameEl = must("#space-name");
      this.spaceCountEl = must("#space-count");
      this.inputEl = must("#input");
      const noticeEl = must("#notice");
      this.notice = makeNotice(noticeEl);
      this.spaceLayer = new SpaceLayer(must("#space-layer"), {
        onSwitch: (id) => void this.switchSpace(id),
        onRename: (id, name) => void this.renameSpace(id, name),
        onCreate: () => void this.createSpace(),
        onOpenTrash: () => void this.openTrash(),
        onDelete: (id) => void this.deleteSpace(id)
      });
      this.trashLayer = new TrashLayer(must("#trash-layer"), {
        onRestore: (id) => void this.restoreTrash(id),
        onEmpty: () => void this.emptyTrash()
      });
      this.bindViewportGestures();
      this.mountDragController();
      mountKeyboard(must(".dock"));
      this.pinch = mountPinch(this.stage, {
        viewport: () => this.viewport,
        cancelSingle: () => {
          this.drag?.cancel();
          this.cancelPan();
          window.clearTimeout(this.tapTimer);
          cancelAnimationFrame(this.viewportAnim);
          this.lastTapView = null;
        },
        apply: (viewport) => {
          this.viewport = viewport;
          this.applyViewport();
        },
        save: () => this.scheduleViewportSave()
      });
      const motion = matchMedia("(prefers-reduced-motion: reduce)");
      const updateMotion = () => this.field.setReducedMotion(motion.matches);
      motion.addEventListener("change", updateMotion);
      updateMotion();
      mountPerformancePanel(() => this.performanceSnapshot());
      this.bindLifecycleFlush();
      this.searchInput = must("#search");
      this.searchHint = must("#search-hint");
      this.bindSearch();
      this.syncBar = must("#sync-bar");
      this.syncLayer = must("#sync-layer");
      this.initSync();
    }
    // ── 同步：本地是权威，GitHub 是镜像 ────────────────────
    initSync() {
      this.sync = new SyncEngine({
        remote: null,
        readLocal: () => this.readLocalDoc(),
        writeLocal: (doc) => this.writeLocalDoc(doc),
        readOwnerHandle: () => this.store.getOwnerHandle(),
        writeOwnerHandle: (handle) => this.store.setOwnerHandle(handle),
        onMerged: (report) => void this.applyMergeFeedback(report),
        onState: (snap) => this.renderSyncBar(snap),
        // 别的标签页更新了本地数据：只刷新界面，**不要再同步**（否则两个标签页会来回打）
        onExternalUpdate: () => void this.refreshCurrentSpace()
      });
      this.syncBar.addEventListener("click", () => this.openSyncPanel());
      const layer = this.syncLayer;
      layer.querySelector(".layer-backdrop").addEventListener(
        "click",
        () => this.closeSyncPanel()
      );
      layer.querySelector("#sync-close").addEventListener(
        "click",
        () => this.closeSyncPanel()
      );
      layer.querySelector("#sync-save").addEventListener(
        "click",
        () => void this.applySyncPanel()
      );
      layer.querySelector("#sync-now").addEventListener(
        "click",
        () => void this.sync?.sync({ force: true })
      );
      layer.querySelector("#sync-switch").addEventListener(
        "click",
        () => void this.switchAccount()
      );
      layer.querySelector("#sync-forget").addEventListener(
        "click",
        () => void this.logout()
      );
    }
    /**
     * 启动时自动登录。
     *
     * 🔴 调用时机很关键：**上面已经把本地数据渲染完了**，这里只是后台接上远端。
     *    绝不能出现"等同步完再显示" —— 那样每次打开都要盯着一片空星云。
     */
    async autoLogin() {
      const cred = await loadCredential();
      if (!cred) {
        if (await credentialRecordExists()) {
          this.renderSyncBar(this.syncBarText("\u767B\u5F55\u5DF2\u5931\u6548 \xB7 \u70B9\u8FD9\u91CC\u91CD\u65B0\u767B\u5F55"));
        }
        return;
      }
      this.sync?.setAccount(cred.target.owner);
      this.sync?.setRemote(
        this.remoteFactory({ token: cred.token, ...cred.target })
      );
      this.renderSyncBar(this.syncBarText(`@${cred.target.owner} \xB7 \u6B63\u5728\u540C\u6B65\u2026`));
      await this.sync?.sync();
    }
    /**
     * 退出登录。
     *
     * 🔴 这是唯一"会清空本机数据"的用户操作，所以确认框要按实际情况给不同的话：
     *    备份过 ⇒ 告诉他数据在 GitHub 上，重新登录能取回；
     *    从没备份过 ⇒ 明确警告"数据会真的消失"。
     */
    async logout() {
      const owner = await this.store.getOwnerHandle() ?? "\u8FD9\u4E2A\u8D26\u53F7";
      const backedUp = this.sync?.snapshot.everPushed === true;
      const ok = window.confirm(
        backedUp ? `\u9000\u51FA\u767B\u5F55\u4F1A\u6E05\u7A7A\u8FD9\u53F0\u8BBE\u5907\u4E0A\u7684\u6570\u636E\u3002

@${owner} \u7684\u60F3\u6CD5\u5728\u4ED6\u7684 GitHub \u5907\u4EFD\u91CC\uFF0C\u91CD\u65B0\u767B\u5F55\u5C31\u80FD\u53D6\u56DE\u3002

\u786E\u5B9A\u9000\u51FA\uFF1F` : `\u26A0\uFE0F \u8FD9\u53F0\u8BBE\u5907\u4ECE\u6765\u6CA1\u6709\u6210\u529F\u5907\u4EFD\u8FC7\u3002

\u9000\u51FA\u767B\u5F55\u4F1A\u6E05\u7A7A\u672C\u673A\u6570\u636E\uFF0C\u800C\u4E14\u6CA1\u6709\u5907\u4EFD\u53EF\u4EE5\u6062\u590D \u2014\u2014 \u6570\u636E\u4F1A\u771F\u7684\u6D88\u5931\u3002

\u4ECD\u7136\u8981\u9000\u51FA\u5417\uFF1F`
      );
      if (!ok) return;
      await clearCredential();
      await this.store.wipeAllData();
      location.reload();
    }
    /** 把本地权威数据读成一份同步文档。 */
    async readLocalDoc() {
      const [spaces, ideas, purged] = await Promise.all([
        this.store.getAllSpaces(true),
        // 含回收站里的墓碑
        this.store.getAllIdeas(),
        this.store.getPurgedIds()
      ]);
      return { version: DOC_VERSION, savedAt: Date.now(), spaces, ideas, purged };
    }
    /**
     * 把合并结果落回本地。
     *
     * 🔴 纯 upsert，不做删除：合并是**并集**语义，结果只会比本地多或更新，
     *    永远不会少。真正"要消失"的东西靠 purged 列表在合并那一步就滤掉了。
     */
    async writeLocalDoc(doc) {
      await this.store.putIdeas(doc.ideas);
      for (const space of doc.spaces) await this.store.putSpace(space);
      await this.store.setMeta("purgedIds", doc.purged ?? []);
      this.markSearchDirty();
    }
    /**
     * 把合并的差异反馈到界面上。
     *
     * 同步必须**可见** —— 用户看不到任何变化时不会相信备份在工作。
     * 所以：远端带来新东西 → 重建视图 + toast；远端改写了本地 → 那条闪一下。
     */
    async applyMergeFeedback(report) {
      const touched = report.addedFromRemote.length + report.remoteWon.length + report.addedSpaces.length;
      if (touched === 0) return;
      await this.refreshCurrentSpace({ quiet: true });
      for (const id of report.remoteWon) this.flashBubble(id);
      if (report.addedFromRemote.length > 0) {
        this.notice(`\u4ECE\u5907\u4EFD\u6062\u590D\u4E86 ${report.addedFromRemote.length} \u6761`, "info");
      } else if (report.remoteWon.length > 0) {
        this.notice(`\u5907\u4EFD\u66F4\u65B0\u4E86 ${report.remoteWon.length} \u6761`, "info");
      }
    }
    /** 远端赢了本地的泡泡：原地闪一下（scale 1 → 1.08 → 1）。 */
    flashBubble(id) {
      const view = this.views.get(id);
      if (!view) return;
      view.scale.animate(
        [
          { transform: "scale(1)", offset: 0 },
          { transform: "scale(1.08)", offset: 0.45 },
          { transform: "scale(1)", offset: 1 }
        ],
        { duration: 240, easing: "ease-out" }
      );
    }
    /** 重新按数据库里的内容渲染当前空间（同步落地后用）。 */
    async refreshCurrentSpace(opts = {}) {
      const space = this.current;
      if (!space) return;
      const fresh = (await this.store.getAllSpaces()).find((sp) => sp.id === space.id);
      if (!fresh) return;
      await this.openSpace(fresh, { keepViewport: true, quiet: opts.quiet === true });
    }
    renderSyncBar(snap) {
      this.syncBar.dataset.status = snap.status;
      this.syncBar.textContent = snap.detail || "\u53EA\u5B58\u5728\u8FD9\u53F0\u8BBE\u5907";
    }
    openSyncPanel() {
      const accountEl = this.syncLayer.querySelector("#sync-account");
      const switchBtn = this.syncLayer.querySelector("#sync-switch");
      void Promise.all([loadCredential(), this.store.getOwnerHandle()]).then(
        ([cred, localOwner]) => {
          if (cred) {
            accountEl.textContent = `\u5DF2\u767B\u5F55\uFF1A@${cred.target.owner}/${cred.target.repo}\uFF08${cred.target.branch}\uFF09` + (isCredentialEncrypted() ? "" : " \xB7 \u26A0\uFE0F \u5F53\u524D\u4E0D\u662F HTTPS\uFF0Ctoken \u53EA\u80FD\u660E\u6587\u4FDD\u5B58");
          } else {
            accountEl.textContent = "";
          }
          switchBtn.hidden = !(localOwner && cred && localOwner !== cred.target.owner);
        }
      );
      this.syncLayer.hidden = false;
      this.syncLayer.classList.add("layer--visible");
    }
    closeSyncPanel() {
      this.syncLayer.classList.remove("layer--visible");
      this.syncLayer.hidden = true;
    }
    /**
     * 从面板连接账号。
     *
     * 用户只需要粘贴一个 token —— 其余全自动：
     *  ① `GET /user` 问出"你是谁"（不用填 owner）
     *  ② `POST /user/repos` 自动建私有数据仓库（不用先手动建仓）
     * 这就是"零服务端的 GitHub 登录"能到达的最好体验。
     */
    async applySyncPanel() {
      const token = this.syncLayer.querySelector("#sync-token").value.trim();
      if (token === "") {
        if (this.sync?.accountHandle) {
          this.closeSyncPanel();
          await this.sync.sync({ force: true });
        } else {
          this.notice("\u8BF7\u7C98\u8D34 GitHub token \u540E\u70B9\u300C\u767B\u5F55\u300D", "warn");
        }
        return;
      }
      try {
        await this.connectWithToken(token);
      } catch (err) {
        this.notice(err instanceof Error ? err.message : String(err), "error");
      }
    }
    /** 用 token 连接（面板与自动化测试共用这一条路径）。 */
    async connectWithToken(token) {
      this.notice("\u6B63\u5728\u786E\u8BA4\u8D26\u53F7\u2026", "info");
      const probe = this.remoteFactory({ token, owner: "", repo: "", branch: DEFAULT_BRANCH });
      const { login } = await probe.identify();
      const client = this.remoteFactory({
        token,
        owner: login,
        repo: DATA_REPO_NAME,
        branch: DEFAULT_BRANCH
      });
      const status = await client.ensureRepo(DATA_REPO_NAME);
      if (!status.private) {
        throw new Error(
          `@${login}/${DATA_REPO_NAME} \u5DF2\u7ECF\u5B58\u5728\uFF0C\u4F46\u662F\u4E2A**\u516C\u5F00**\u4ED3\u5E93\u3002\u4E3A\u4E86\u4E0D\u628A\u4F60\u7684\u60F3\u6CD5\u516C\u5F00\u51FA\u53BB\uFF0C\u5DF2\u505C\u6B62\u3002\u8BF7\u5148\u5220\u6389\u5B83\u6216\u6539\u540D\u3002`
        );
      }
      const target = {
        owner: login,
        repo: DATA_REPO_NAME,
        branch: status.defaultBranch || DEFAULT_BRANCH
      };
      await saveCredential(target, token);
      this.notice(
        status.created ? `\u5DF2\u4E3A @${login} \u521B\u5EFA\u79C1\u6709\u4ED3\u5E93 ${DATA_REPO_NAME}` : `\u5DF2\u8FDE\u63A5 @${login} \u7684\u73B0\u6709\u4ED3\u5E93`,
        "info"
      );
      await this.connectAccount(target, token);
    }
    /** 接上远端并同步。 */
    async connectAccount(target, token) {
      this.sync?.setAccount(target.owner);
      this.sync?.setRemote(
        this.remoteFactory({
          token,
          owner: target.owner,
          repo: target.repo,
          branch: target.branch
        })
      );
      this.closeSyncPanel();
      await this.sync?.sync({ force: true });
      this.renderSyncBar(this.sync?.snapshot ?? this.syncBarText("\u7B49\u5F85\u540C\u6B65"));
      const owner = await this.store.getOwnerHandle();
      const mismatch = this.sync?.snapshot.status === "error" && owner && owner !== target.owner;
      this.syncLayer.querySelector("#sync-switch").hidden = !mismatch;
    }
    syncBarText(detail) {
      return {
        status: "idle",
        detail,
        lastSyncAt: null,
        lastError: null,
        dirty: false,
        lastAdded: 0,
        lastRemoteWon: 0,
        everPushed: false
      };
    }
    /**
     * 切换账号。
     *
     * 🔴 这是多用户唯一会毁数据的操作，所以：
     *    · 必须用户明确确认（默认对话框说明"原账号的数据在他的备份里不会丢"）
     *    · 清空本机之后重新加载，保证没有任何残留状态
     */
    async switchAccount() {
      const account = this.sync?.accountHandle ?? "\uFF08\u672A\u77E5\uFF09";
      const localOwner = await this.store.getOwnerHandle() ?? "\uFF08\u672A\u77E5\uFF09";
      const ok = window.confirm(
        `\u8FD9\u53F0\u8BBE\u5907\u4E0A\u5B58\u7684\u662F @${localOwner} \u7684\u6570\u636E\u3002

\u5207\u6362\u5230 @${account} \u4F1A\u6E05\u7A7A\u672C\u673A\u6570\u636E\u3002
@${localOwner} \u7684\u60F3\u6CD5\u5728\u4ED6\u7684 GitHub \u5907\u4EFD\u91CC\u4E0D\u4F1A\u4E22 \u2014\u2014 \u7528\u4ED6\u7684\u8D26\u53F7\u767B\u5F55\u5C31\u80FD\u53D6\u56DE\u3002

\u786E\u5B9A\u5207\u6362\uFF1F`
      );
      if (!ok) return;
      await this.store.wipeAllData();
      location.reload();
    }
    // ── 搜索：聚光，不是清场 ──────────────────────────────
    bindSearch() {
      this.search = mountSearch(
        this.searchInput,
        must("#search-count"),
        this.searchHint,
        {
          targets: () => [...this.currentIdeas.values()].map((i) => ({ id: i.id, text: i.text })),
          apply: (states, query) => {
            this.reconcileViews(new Set(states.filter((s) => s.hit).map((s) => s.id)));
            if (this.heartView) setSearchState(this.heartView, false);
            for (const state of states) {
              const view = this.views.get(state.id);
              if (!view) continue;
              setSearchState(view, state.hit);
              this.syncLabel(view, query, state.hit);
            }
          },
          clear: () => {
            this.reconcileViews(/* @__PURE__ */ new Set());
            if (this.heartView) clearSearchState(this.heartView);
            for (const view of this.views.values()) {
              clearSearchState(view);
              this.syncLabel(view, "", false);
            }
          },
          centerOn: (id) => this.centerOn(id),
          pulse: (id) => this.pulse(id),
          otherSpaceMatches: (query) => this.otherSpaceMatches(query),
          goToSpace: (spaceId) => {
            void this.switchSpace(spaceId).then(() => this.searchInput.focus());
          }
        }
      );
    }
    /**
     * 把高亮同步到 label 上。
     *
     * 🔴 查询词没变就**完全不碰 DOM**（`markQuery` 缓存）—— 搜索是边打边看的过程，
     *    每敲一个字都重建整段文字会让它闪一下，非常干扰。
     *    真正变化的往往只是多标一个字，renderSegments 内部还会复用形状相同的节点。
     */
    syncLabel(view, query, hit) {
      const id = view.body.id;
      if (this.markQuery.get(id) === query) return;
      this.markQuery.set(id, query);
      const segments = hit ? splitByQuery(view.text, query) : [{ text: view.text, hit: false }];
      renderSegments(view.label, segments);
    }
    /** 把某个泡泡移到屏幕中央。**移动视口，不动泡泡。** */
    centerOn(id) {
      const view = this.views.get(id);
      if (!view) return;
      const rect = this.stage.getBoundingClientRect();
      const scale = this.viewport.scale;
      this.lastCenteredId = id;
      this.tweenViewport(
        {
          scale,
          tx: rect.width / 2 - view.body.x * scale,
          ty: rect.height / 2 - view.body.y * scale
        },
        260
      );
    }
    tweenViewport(target, ms) {
      cancelAnimationFrame(this.viewportAnim);
      const from = { ...this.viewport };
      const t0 = performance.now();
      const step = () => {
        const k = Math.min(1, (performance.now() - t0) / ms);
        const eased = 1 - (1 - k) ** 3;
        this.viewport = {
          scale: target.scale,
          tx: from.tx + (target.tx - from.tx) * eased,
          ty: from.ty + (target.ty - from.ty) * eased
        };
        this.applyViewport();
        if (k < 1) {
          this.viewportAnim = requestAnimationFrame(step);
        } else {
          void this.saveViewportNow();
        }
      };
      this.viewportAnim = requestAnimationFrame(step);
    }
    pulse(id) {
      const view = this.views.get(id);
      if (!view) return;
      view.scale.animate(pulseKeyframes(), { duration: 340, easing: "ease-out" });
    }
    /** 全量想法（跨空间搜索用）。带缓存，任何数据变动都会置脏。 */
    async allIdeas() {
      if (this.searchCache && !this.searchDirty) return this.searchCache;
      this.searchCache = await this.store.getAllIdeas();
      this.searchDirty = false;
      return this.searchCache;
    }
    markSearchDirty() {
      this.searchDirty = true;
    }
    async otherSpaceMatches(query) {
      if (query === "") return [];
      const currentId = this.current?.id;
      const all = await this.allIdeas();
      const counts = /* @__PURE__ */ new Map();
      for (const idea of all) {
        if (idea.spaceId === currentId) continue;
        if (idea.archived === 1) continue;
        if (scoreMatch(idea.text, query) > 0) {
          counts.set(idea.spaceId, (counts.get(idea.spaceId) ?? 0) + 1);
        }
      }
      return [...counts.entries()].map(([spaceId, count]) => ({
        spaceId,
        count,
        name: this.spaces.find((sp) => sp.id === spaceId)?.name ?? "\uFF08\u5DF2\u5220\u9664\u7684\u7A7A\u95F4\uFF09"
      })).sort((a, b) => b.count - a.count);
    }
    // ── 拖拽 ──────────────────────────────────────────────
    mountDragController() {
      this.drag = mountDrag(this.stage, {
        blocked: () => this.pinch?.active ?? false,
        hitTest: (target) => {
          const el = target instanceof Element ? target.closest(".bubble") : null;
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
          body.vx = 0;
          body.vy = 0;
          const view = this.views.get(body.id);
          if (view) setDragging(view, true);
          this.field.wake(0.35);
          this.startLoop();
        },
        onDragMove: () => {
          this.field.wake(0.35);
          this.startLoop();
        },
        onDrop: (body, velocity) => {
          const view = this.views.get(body.id);
          if (view) setDragging(view, false);
          body.vx = velocity.x;
          body.vy = velocity.y;
          this.field.wake(0.5);
          this.startLoop();
          this.schedulePositionSave(body.id, Date.now());
          this.search?.refresh();
        },
        onTap: (body, at) => {
          const view = this.views.get(body.id);
          if (view) this.handleTap(view, at);
        }
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
    handleTap(view, at) {
      const now = performance.now();
      if (this.tapTimer !== 0 && this.lastTapView === view && now - this.lastTapAt < DOUBLE_CLICK_GUARD_MS) {
        window.clearTimeout(this.tapTimer);
        this.tapTimer = 0;
        this.lastTapView = null;
        return;
      }
      this.lastTapAt = now;
      this.lastTapView = view;
      window.clearTimeout(this.tapTimer);
      this.tapTimer = window.setTimeout(() => {
        this.tapTimer = 0;
        this.lastTapView = null;
        this.zoomToCenter(view, at);
      }, DOUBLE_CLICK_GUARD_MS);
    }
    /** 双击泡泡 → 切换锁定。同时取消那次待处理的单击。 */
    handleDblClick(view) {
      window.clearTimeout(this.tapTimer);
      this.tapTimer = 0;
      this.lastTapView = null;
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
    zoomToCenter(view, pointer) {
      if (this.zoom) return;
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
          this.search?.refresh();
        }
      });
    }
    /** 关掉放大态（切空间、重命名等会改动布局的操作前调用）。 */
    closeZoom() {
      this.zoom?.close();
    }
    /** 记下"这个泡泡被拖过"，等星云停稳再落库。 */
    schedulePositionSave(ideaId, movedAt) {
      this.pendingPosition.set(ideaId, movedAt);
      this.armPositionFlush();
    }
    armPositionFlush() {
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
    async flushPositions(force = false) {
      if (this.pendingPosition.size === 0) return;
      window.clearTimeout(this.positionSaveTimer);
      if (!force && this.field.tier() !== "asleep") {
        this.armPositionFlush();
        return;
      }
      const pending = [...this.pendingPosition.entries()];
      this.pendingPosition.clear();
      for (const [ideaId, movedAt] of pending) {
        const body = this.field.activeBodies.find((b) => b.id === ideaId);
        if (!body) continue;
        const idea = await this.store.getIdea(ideaId);
        if (!idea) continue;
        await this.store.putIdea({
          ...idea,
          x: body.x,
          y: body.y,
          // 🔴 只动位置就只更新 movedAt。updatedAt 留给文本/归档 ——
          //    两者分离是阶段 6 同步合并的前提：否则拖一下泡泡
          //    会用本地时间戳把另一台设备上刚改的文本压掉。
          movedAt
        });
      }
    }
    async savePinned(ideaId, pinned) {
      const idea = await this.store.getIdea(ideaId);
      if (!idea) return;
      this.sync?.markDirty();
      await this.store.putIdea({
        ...idea,
        pinned: pinned ? 1 : 0,
        // 锁定是"设置"而不是"移动"，所以走 updatedAt
        updatedAt: Date.now()
      });
    }
    /** 双击泡泡：切换锁定。锁定的泡泡力场完全绕过它。 */
    togglePin(view) {
      const body = view.body;
      if (body.fixed) return;
      body.pinned = !body.pinned;
      setPinned(view, body.pinned);
      this.markSearchDirty();
      this.sync?.markDirty();
      this.field.wake(0.35);
      this.startLoop();
      void this.savePinned(body.id, body.pinned);
      this.notice(body.pinned ? "\u5DF2\u9501\u5B9A\u8FD9\u4E2A\u4F4D\u7F6E" : "\u5DF2\u89E3\u9501\uFF0C\u5B83\u4F1A\u8DDF\u7740\u661F\u4E91\u6D41\u52A8", "info");
    }
    /** 页面被藏起来 / 要关掉之前，把没落库的位置补上。 */
    bindLifecycleFlush() {
      const flush = () => {
        void this.flushPositions(true);
        void this.saveViewportNow();
      };
      window.addEventListener("pagehide", flush);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") flush();
      });
    }
    // ── 启动 ──────────────────────────────────────────────
    async start() {
      try {
        await this.store.open();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.notice(`\u6253\u4E0D\u5F00\u672C\u5730\u6570\u636E\u5E93\uFF1A${message}`, "error");
        return;
      }
      try {
        const purged = await this.store.purgeExpired();
        if (purged > 0) this.notice(`\u56DE\u6536\u7AD9\u6709 ${purged} \u9879\u5DF2\u5230\u671F\uFF0C\u5DF2\u6E05\u7406`, "info");
      } catch {
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
        onSubmit: (text) => this.addIdea(text)
      });
      void this.autoLogin();
      this.bindSyncLifecycle();
      this.expose();
      this.bindSelfTest();
      this.inputEl.focus();
    }
    /**
     * 同步时机（对应需求里的那几条）。
     *
     * 🔴 启动时**先渲染本地再由引擎去拉** —— 绝不能让界面等同步。
     *    上面已经把本地数据画完了，这里只是"顺带拉一下"。
     */
    bindSyncLifecycle() {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "hidden") return;
        if (this.sync?.snapshot.dirty) void this.sync.sync({ force: true });
      });
      window.addEventListener("pagehide", () => {
        if (this.sync?.snapshot.dirty) void this.sync.sync({ force: true });
      });
    }
    /** 自检按钮：把 store 层的真读写结果打印出来（阶段 1 起就有的验证工具）。 */
    bindSelfTest() {
      const btn = must("#selftest");
      const out = must("#selftest-out");
      btn.addEventListener("click", () => {
        out.textContent = "\u6B63\u5728\u81EA\u68C0\u2026";
        void this.selfTest().then((lines) => {
          out.textContent = lines.join("\n");
          const failed = lines.filter((l) => l.startsWith("[FAIL]")).length;
          this.notice(
            failed === 0 ? `\u81EA\u68C0\u901A\u8FC7\uFF08${lines.length} \u9879\uFF09` : `\u81EA\u68C0\u6709 ${failed} \u9879\u5931\u8D25`,
            failed === 0 ? "info" : "error"
          );
        });
      });
    }
    async resolveCurrent() {
      const lastId = await this.store.getLastSpaceId();
      const remembered = lastId ? this.spaces.find((s) => s.id === lastId) : void 0;
      return remembered ?? this.spaces[0];
    }
    // ── 打开一个空间 ──────────────────────────────────────
    async openSpace(space, opts = {}) {
      this.closeZoom();
      this.current = space;
      await this.store.setLastSpaceId(space.id);
      for (const view of this.views.values()) view.destroy();
      this.views.clear();
      this.currentIdeas.clear();
      this.markQuery.clear();
      this.heartView?.destroy();
      this.heartView = null;
      applyAccent(this.world, space.hue);
      const heartBody = {
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
        dragging: false
      };
      this.heartBody = heartBody;
      this.heartView = createHeartBubble(heartBody, space.name, {
        onClick: () => this.openSpaceLayer(),
        // 双击心泡泡 = 直接进改名，省掉"点开浮层再双击"这一步
        onDblClick: () => this.openSpaceLayer(space.id)
      });
      this.world.appendChild(this.heartView.el);
      const ideas = await this.store.getIdeasBySpace(space.id);
      const bodies = [heartBody];
      for (const idea of ideas) {
        const body = this.bodyFromIdea(idea);
        bodies.push(body);
        this.currentIdeas.set(idea.id, idea);
      }
      this.field.setActiveSpace(space.id);
      this.field.setSpaceBodies(space.id, bodies);
      this.reconcileViews(this.searchHits());
      if (!opts.quiet) {
        if (this.heartView) playPop(this.heartView.scale, true, 0);
        let order = 1;
        for (const view of this.views.values()) {
          playPop(view.scale, true, Math.min(order * 18, 380));
          order++;
        }
      }
      if (!opts.keepViewport) {
        const saved = opts.ignoreSaved ? void 0 : await this.store.getViewport(space.id);
        this.viewport = saved ?? this.centeredViewport();
        this.applyViewport();
      }
      this.field.wake(0.6);
      this.kick();
      this.writeAll();
      this.updateStatusLine();
      this.search?.refresh();
    }
    /**
     * 由想法记录造一个 body。
     *
     * 🔴 (0, 0) 是心泡泡的保留位置，所以它同时可以当作"这条想法还没被摆过"的标记。
     *    这样就不用给数据模型加 `placed` 字段 —— 文本仍然是唯一真相来源。
     */
    bodyFromIdea(idea) {
      let { x, y } = idea;
      if (x === 0 && y === 0) {
        const p = spawnPointFor(idea.id);
        x = p.x;
        y = p.y;
      }
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
        dragging: false
      };
    }
    // ── 动画循环（三档降频）────────────────────────────────
    kick() {
      this.field.wake(0.35);
      this.startLoop();
    }
    startLoop() {
      if (this.rafId !== 0) return;
      this.rafId = requestAnimationFrame(this.loop);
    }
    /**
     * 🔴 三档降频：静止时把 rAF 彻底停掉，CPU 真的是 0，而不是"一直在跑只是幅度小"。
     *    手机上这一条决定了"开着网页放一晚上会不会掉电"。
     */
    loop = () => {
      this.frameIndex++;
      const tier = this.field.tier();
      if (tier === "asleep") {
        this.rafId = 0;
        if (this.pendingPosition.size > 0) void this.flushPositions();
        return;
      }
      if (tier === "full" || this.frameIndex % 4 === 0) {
        this.field.step();
        this.writeAll();
      }
      this.rafId = requestAnimationFrame(this.loop);
    };
    /** 把所有 body 的位置写进 DOM。只改 transform，不碰宽高。 */
    writeAll() {
      for (const view of this.views.values()) writePosition(view);
      if (this.heartView) writePosition(this.heartView);
    }
    searchHits() {
      const query = this.search?.query ?? "";
      return new Set([...this.currentIdeas.values()].filter((i) => query !== "" && scoreMatch(i.text, query) > 0).map((i) => i.id));
    }
    reconcileViews(hits) {
      const bodies = this.field.activeBodies.filter((b) => b.id !== HEART_ID);
      const policy = renderPolicy(bodies.length);
      const root = document.documentElement;
      root.dataset.renderTier = policy.tier;
      root.style.setProperty("--bubble-font-reduction", `${policy.fontReduction}px`);
      const selected = renderedIds(bodies, hits);
      for (const [id, view] of this.views) {
        if (view.body.dragging || view.el.classList.contains("bubble--hidden")) selected.add(id);
      }
      for (const [id, view] of this.views) {
        if (selected.has(id)) continue;
        view.destroy();
        this.views.delete(id);
        this.markQuery.delete(id);
      }
      for (const body of bodies) {
        if (!selected.has(body.id) || this.views.has(body.id)) continue;
        const idea = this.currentIdeas.get(body.id);
        if (!idea) continue;
        const view = createIdeaBubble(body, idea.text, { onDblClick: (v) => this.handleDblClick(v) });
        setPinned(view, body.pinned);
        this.views.set(body.id, view);
        this.world.appendChild(view.el);
        writePosition(view);
      }
    }
    performanceSnapshot() {
      return {
        ideas: this.currentIdeas.size,
        rendered: this.views.size,
        renderTier: renderPolicy(this.currentIdeas.size).tier,
        forceTier: this.field.tier()
      };
    }
    // ── 视口 ──────────────────────────────────────────────
    applyViewport() {
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
    centeredViewport() {
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
    ensureVisible(body) {
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
    computeFit() {
      const rect = this.stage.getBoundingClientRect();
      const points = this.field.activeBodies.map((b) => ({ x: b.x, y: b.y }));
      const pad = this.heartBody?.rx ?? 60;
      return fitToContent(points, pad, { w: rect.width, h: rect.height });
    }
    fitAll() {
      this.viewport = this.computeFit();
      this.applyViewport();
      void this.saveViewportNow();
    }
    scheduleViewportSave() {
      window.clearTimeout(this.viewportSaveTimer);
      this.viewportSaveTimer = window.setTimeout(() => void this.saveViewportNow(), 400);
    }
    async saveViewportNow() {
      if (!this.current) return;
      await this.store.setViewport(this.current.id, this.viewport);
    }
    /** 滚轮缩放 + 拖空白平移 + 双击空白回全貌。手感的精细打磨在阶段 4。 */
    bindViewportGestures() {
      this.stage.addEventListener(
        "wheel",
        (e) => {
          e.preventDefault();
          const rect = this.stage.getBoundingClientRect();
          const anchor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
          const factor = Math.exp(-e.deltaY * 16e-4);
          this.viewport = zoomAt(this.viewport, anchor, factor);
          this.applyViewport();
          this.scheduleViewportSave();
        },
        { passive: false }
      );
      let panning = false;
      let lastX = 0;
      let lastY = 0;
      let moved = false;
      let panPointer = -1;
      this.cancelPan = () => {
        panning = false;
        try {
          this.stage.releasePointerCapture(panPointer);
        } catch {
        }
        panPointer = -1;
      };
      this.stage.addEventListener("pointerdown", (e) => {
        if (this.pinch?.active || panning || e.pointerType === "mouse" && e.button !== 0) return;
        if (e.target !== this.stage) return;
        panning = true;
        panPointer = e.pointerId;
        moved = false;
        lastX = e.clientX;
        lastY = e.clientY;
        this.stage.setPointerCapture(e.pointerId);
      });
      this.stage.addEventListener("pointermove", (e) => {
        if (!panning || this.pinch?.active || e.pointerId !== panPointer) return;
        if (e.pointerType === "touch" && e.cancelable) e.preventDefault();
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        if (dx !== 0 || dy !== 0) moved = true;
        lastX = e.clientX;
        lastY = e.clientY;
        this.viewport = { ...this.viewport, tx: this.viewport.tx + dx, ty: this.viewport.ty + dy };
        this.applyViewport();
      });
      const endPan = (e) => {
        if (!panning || e.pointerId !== panPointer) return;
        panning = false;
        try {
          this.stage.releasePointerCapture(e.pointerId);
        } catch {
        }
        if (moved) this.scheduleViewportSave();
      };
      this.stage.addEventListener("pointerup", endPan);
      this.stage.addEventListener("pointercancel", endPan);
      this.stage.addEventListener("dblclick", (e) => {
        if (this.pinch?.active) return;
        if (e.target !== this.stage) return;
        this.fitAll();
      });
    }
    // ── 空间操作 ──────────────────────────────────────────
    openSpaceLayer(focusRename) {
      this.trashLayer.close();
      this.spaceLayer.show(this.spaces, this.current?.id ?? "", focusRename);
    }
    async switchSpace(spaceId) {
      const space = this.spaces.find((s) => s.id === spaceId);
      if (!space) return;
      if (space.id === this.current?.id) {
        this.spaceLayer.close();
        return;
      }
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
    async createSpace() {
      const space = await this.store.createSpace();
      this.spaces = await this.store.getAllSpaces();
      await this.store.setLastSpaceId(space.id);
      await this.openSpace(space, { ignoreSaved: true });
      this.spaceLayer.show(this.spaces, space.id, space.id);
      this.notice("\u65B0\u5EFA\u4E86\u7A7A\u95F4\uFF0C\u7ED9\u5B83\u8D77\u4E2A\u540D\u5B57", "info");
    }
    async renameSpace(spaceId, name) {
      const updated = await this.store.renameSpace(spaceId, name);
      if (!updated) return;
      this.spaces = await this.store.getAllSpaces();
      if (this.current?.id === spaceId) {
        this.current = updated;
        if (this.heartView) updateHeartLabel(this.heartView, name);
        this.field.wake(0.3);
        this.startLoop();
        this.writeAll();
        this.updateStatusLine();
      }
      this.spaceLayer.render(this.spaces);
    }
    async deleteSpace(spaceId) {
      const space = this.spaces.find((s) => s.id === spaceId);
      if (!space) return;
      if (this.spaces.length <= 1) {
        this.notice("\u81F3\u5C11\u8981\u7559\u4E00\u4E2A\u7A7A\u95F4", "warn");
        return;
      }
      const count = await this.store.countIdeasBySpace(spaceId);
      const confirmed = window.confirm(
        count > 0 ? `\u300C${space.name}\u300D\u91CC\u6709 ${count} \u6761\u60F3\u6CD5\uFF0C\u4F1A\u4E00\u8D77\u8FDB\u56DE\u6536\u7AD9\u3002
30 \u5929\u5185\u90FD\u80FD\u6062\u590D\u3002\u786E\u5B9A\u5220\u9664\uFF1F` : `\u786E\u5B9A\u5220\u9664\u7A7A\u95F4\u300C${space.name}\u300D\uFF1F\u5B83\u4F1A\u8FDB\u56DE\u6536\u7AD9\uFF0C30 \u5929\u5185\u53EF\u6062\u590D\u3002`
      );
      if (!confirmed) return;
      await this.store.deleteSpaceToTrash(spaceId);
      this.markSearchDirty();
      this.sync?.markDirty();
      this.spaces = await this.store.getAllSpaces();
      if (this.current?.id === spaceId) {
        await this.openSpace(this.spaces[0], { ignoreSaved: true });
      }
      this.spaceLayer.render(this.spaces);
      this.notice(`\u300C${space.name}\u300D\u5DF2\u8FDB\u56DE\u6536\u7AD9\uFF0C30 \u5929\u5185\u53EF\u6062\u590D`, "info");
    }
    // ── 回收站 ────────────────────────────────────────────
    async openTrash() {
      await this.store.purgeExpired();
      const entries = await this.store.getAllTrash();
      this.spaceLayer.close();
      this.trashLayer.show(entries);
    }
    async restoreTrash(trashId) {
      const restored = await this.store.restoreFromTrash(trashId);
      if (!restored) return;
      this.markSearchDirty();
      this.spaces = await this.store.getAllSpaces();
      this.trashLayer.render(await this.store.getAllTrash());
      this.spaceLayer.render(this.spaces);
      this.notice(`\u5DF2\u6062\u590D\u300C${restored.name}\u300D`, "info");
    }
    async emptyTrash() {
      const entries = await this.store.getAllTrash();
      if (entries.length === 0) return;
      const confirmed = window.confirm(
        `\u56DE\u6536\u7AD9\u91CC\u7684 ${entries.length} \u9879\u4F1A\u88AB\u6C38\u4E45\u5220\u9664\uFF0C\u65E0\u6CD5\u6062\u590D\u3002\u786E\u5B9A\uFF1F`
      );
      if (!confirmed) return;
      await this.store.purgeAllTrash();
      this.trashLayer.render([]);
      this.notice("\u56DE\u6536\u7AD9\u5DF2\u6E05\u7A7A", "info");
    }
    // ── 录入 ──────────────────────────────────────────────
    async addIdea(text) {
      const space = this.current;
      if (!space) throw new Error("\u5F53\u524D\u6CA1\u6709\u7A7A\u95F4\uFF0C\u65E0\u6CD5\u8BB0\u5F55");
      const id = newId();
      const spawn = spawnPointFor(id);
      const now = Date.now();
      const idea = {
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
        archived: 0
      };
      await this.store.putIdea(idea);
      const body = this.bodyFromIdea(idea);
      this.markSearchDirty();
      this.sync?.markDirty();
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
    async launchFlight(idea, body, space) {
      this.ensureVisible(body);
      const from = this.inputCenter();
      const to = this.worldToStageScreen(body.x, body.y);
      const policy = renderPolicy(this.currentIdeas.size + 1);
      document.documentElement.style.setProperty("--bubble-font-reduction", `${policy.fontReduction}px`);
      const record = await flyIn({ text: idea.text, from, to, ripple: policy.ripple });
      if (this.current?.id !== space.id) return;
      const view = createIdeaBubble(body, idea.text, {
        onDblClick: (v) => this.handleDblClick(v)
      });
      this.views.set(idea.id, view);
      this.world.appendChild(view.el);
      writePosition(view);
      const landedRect = view.el.getBoundingClientRect();
      record.landedAt = {
        x: landedRect.left + landedRect.width / 2,
        y: landedRect.top + landedRect.height / 2
      };
      const bodies = this.field.bodiesOf(space.id);
      bodies.push(body);
      this.field.setSpaceBodies(space.id, bodies);
      this.currentIdeas.set(idea.id, idea);
      playPop(view.scale);
      this.field.wake(0.45);
      this.startLoop();
      this.writeAll();
      this.updateStatusLine();
      this.search?.refresh();
    }
    /** 输入框中心（视口坐标）—— 飞入的起点。 */
    inputCenter() {
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
    worldToStageScreen(x, y) {
      const rect = this.stage.getBoundingClientRect();
      const p = worldToScreen(this.viewport, { x, y });
      return { x: rect.left + p.x, y: rect.top + p.y };
    }
    updateStatusLine() {
      if (!this.current) return;
      this.spaceNameEl.textContent = this.current.name;
      const count = this.field.activeBodies.filter((b) => b.id !== HEART_ID).length;
      this.spaceCountEl.textContent = `${count} \u6761`;
    }
    // ── 调试 / 验证出口 ───────────────────────────────────
    expose() {
      const api = {
        store: this.store,
        field: this.field,
        performance: () => this.performanceSnapshot(),
        viewport: () => ({ ...this.viewport }),
        refresh: () => {
          this.markSearchDirty();
          return this.refreshCurrentSpace({ quiet: true });
        },
        spaces: () => this.spaces,
        current: () => this.current,
        switchSpace: (id) => this.switchSpace(id),
        createSpace: () => this.createSpace(),
        renameSpace: (id, name) => this.renameSpace(id, name),
        deleteSpace: (id) => this.deleteSpace(id),
        openTrash: () => this.openTrash(),
        restoreTrash: (id) => this.restoreTrash(id),
        emptyTrash: () => this.emptyTrash(),
        listIdeas: () => this.store.getAllIdeas(),
        positions: (spaceId) => this.field.bodiesOf(spaceId).map((b) => ({ id: b.id, x: b.x, y: b.y })),
        /** 某个想法泡泡的运行时状态（拖拽 / 锁定的验证用）。 */
        bodyState: (ideaId) => {
          const b = this.views.get(ideaId)?.body;
          return b ? { x: b.x, y: b.y, vx: b.vx, vy: b.vy, pinned: b.pinned, dragging: b.dragging } : null;
        },
        /** 心泡泡的状态（验证"心泡泡永远拖不动"）。 */
        heartState: () => {
          const b = this.heartBody;
          return b ? { x: b.x, y: b.y, fixed: b.fixed, dragging: b.dragging } : null;
        },
        /** 数据库里的那条记录（验证位置持久化与 pinned 落库）。 */
        storedIdea: (ideaId) => this.store.getIdea(ideaId),
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
        /** 搜索状态（查询词与命中数）。 */
        searchState: () => ({
          query: this.search?.query ?? "",
          hits: this.search?.hitCount ?? 0,
          input: this.searchInput.value
        }),
        /** 最近一次被"居中"的泡泡 id —— 验证 Enter 跳转是移视口而不是移泡泡。 */
        lastCentered: () => this.lastCenteredId,
        /** 清空搜索（恢复全貌）。 */
        clearSearch: () => this.search?.clear(),
        // ── 同步（自动化测试用）────────────────────────
        /** 当前的同步状态快照。 */
        syncState: () => this.sync?.snapshot ?? null,
        /** 手动跑一轮同步。 */
        syncNow: (force = true) => this.sync?.sync({ force }),
        /** 标脏（模拟"本地刚改过"）。 */
        syncDirty: () => this.sync?.markDirty(),
        /** 读本地权威数据（测试用来核对）。 */
        readLocalDoc: () => this.readLocalDoc(),
        /**
         * 注入一个"模拟远端"。
         * 🔴 仅供自动化测试 —— 真实的 GitHub 需要你的 token，测试用内存实现替代，
         *    这样才能把"会毁数据"的那几条路径真正跑一遍。
         */
        installRemote: (store) => this.sync?.setRemote(store),
        /** 告知引擎这份凭据属于哪个账号（测试用）。 */
        setAccount: (handle) => this.sync?.setAccount(handle),
        /** 本机数据的主人。 */
        ownerHandle: () => this.store.getOwnerHandle(),
        /** 走完整的"用 token 登录"流程（与面板同一条路径）。 */
        connectWithToken: (token) => this.connectWithToken(token),
        /** 这台设备是否已登录（能否自动连上远端）。 */
        isLoggedIn: () => this.sync?.accountHandle !== null,
        /** 退出登录：抹掉凭据 + 清空本机数据 + 重载。 */
        logout: () => this.logout(),
        /** 是否处于安全上下文（决定 token 能否被加密保存）。 */
        credentialEncrypted: () => isCredentialEncrypted(),
        /** 清空本机数据（切换账号用，测试里直接调）。 */
        wipeLocal: () => this.store.wipeAllData(),
        /** 替换远端客户端工厂（测试注入内存实现）。 */
        setRemoteFactory: (fn) => {
          this.remoteFactory = fn;
        },
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
        selfTest: () => this.selfTest()
      };
      window.__nebula = api;
    }
    /** 浏览器内自检：真写、真读、真删，跑完不留痕迹。 */
    async selfTest() {
      const out = [];
      const check = (name, ok, extra = "") => {
        out.push(`[${ok ? "OK  " : "FAIL"}] ${name}${extra ? "  " + extra : ""}`);
      };
      const stamp = Date.now();
      try {
        const s1 = await this.store.createSpace();
        check("\u65B0\u5EFA\u7A7A\u95F4", s1.deleted === 0 && s1.purgeAt === 0);
        check("\u65B0\u5EFA\u7A7A\u95F4\u8272\u677F\u5728 0..8", s1.hue >= 0 && s1.hue <= 8, `hue=${s1.hue}`);
        const renamed = await this.store.renameSpace(s1.id, `\u81EA\u68C0-${stamp}`);
        check("\u91CD\u547D\u540D\u7A7A\u95F4", renamed?.name === `\u81EA\u68C0-${stamp}`);
        const idea = {
          id: newId(),
          spaceId: s1.id,
          text: "\u81EA\u68C0\u7528\u7684\u4E00\u53E5\u8BDD",
          createdAt: stamp,
          updatedAt: stamp,
          movedAt: 0,
          x: 12,
          y: -34,
          pinned: 0,
          linksAlwaysOn: 0,
          archived: 0
        };
        await this.store.putIdea(idea);
        const entry = await this.store.deleteSpaceToTrash(s1.id);
        check("\u5220\u9664\u7A7A\u95F4 \u2192 \u8FDB\u56DE\u6536\u7AD9", entry !== null && entry.kind === "space");
        check("\u56DE\u6536\u7AD9\u5FEB\u7167\u542B\u5168\u90E8\u60F3\u6CD5", (entry?.ideas?.length ?? 0) === 1);
        check("\u56DE\u6536\u7AD9 30 \u5929\u540E\u8FC7\u671F", (entry?.purgeAt ?? 0) > stamp + 29 * 864e5);
        const gone = await this.store.getSpace(s1.id);
        check("\u7A7A\u95F4\u5DF2\u6807\u8BB0\u5220\u9664\uFF08\u5893\u7891\u4ECD\u5728\uFF09", gone?.deleted === 1);
        const clash = await this.store.createSpace();
        await this.store.renameSpace(clash.id, `\u81EA\u68C0-${stamp}`);
        const restored = await this.store.restoreFromTrash(s1.id);
        check("\u6062\u590D\u7A7A\u95F4", restored !== null && restored.deleted === 0);
        check("\u540D\u5B57\u51B2\u7A81\u81EA\u52A8\u52A0\u540E\u7F00", (restored?.name ?? "").includes("\uFF08\u6062\u590D\uFF09"), restored?.name);
        const ideasBack = await this.store.getIdeasBySpace(s1.id);
        check("\u60F3\u6CD5\u968F\u7A7A\u95F4\u4E00\u8D77\u6062\u590D", ideasBack.length === 1);
        await this.store.purgeTrashEntry(s1.id);
        await this.store.hardDeleteIdea(idea.id);
        await this.store.hardDeleteSpace(s1.id);
        await this.store.hardDeleteSpace(clash.id);
        await this.store.deleteMeta(`viewport:${s1.id}`);
        const iso = window.__nebula.debugIsolation();
        check("\u7A7A\u95F4\u9694\u79BB\uFF1A\u65E0\u8DE8\u7A7A\u95F4\u90BB\u5C45", iso.crossSpaceNeighbors === 0, JSON.stringify(iso));
      } catch (err) {
        check("\u81EA\u68C0\u8FC7\u7A0B\u672A\u629B\u5F02\u5E38", false, err instanceof Error ? err.message : String(err));
      }
      return out;
    }
  };
  installFontStackVar();
  var app = new App();
  void app.start();
})();
