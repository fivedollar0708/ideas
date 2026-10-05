"use strict";
(() => {
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
  var DEFAULT_PARAMS = {
    repulsion: 52e4,
    centering: 0.9,
    damping: 0.885,
    interactionRadius: 260,
    maxVelocity: 900,
    dt: 1 / 60,
    alphaDecay: 0.0225,
    alphaMin: 2e-3,
    collisionRelax: 0.62
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
        if (body.fixed || body.pinned) {
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
        if (body.fixed || body.pinned) continue;
        body.x += body.vx * p.dt;
        body.y += body.vy * p.dt;
      }
      this.resolveCollisions(bodies);
      this.grids.delete(spaceId);
      this.rebuildGrid(spaceId);
      this.decayAlpha();
    }
    /** 椭圆碰撞。fixed/pinned 的泡泡不动，只推开对方。 */
    resolveCollisions(bodies) {
      const relax = this.params.collisionRelax;
      for (const body of bodies) {
        for (const other of this.neighborsOf(body)) {
          if (body.id >= other.id) continue;
          const dx = other.x - body.x;
          const dy = other.y - body.y;
          const sumRx = body.rx + other.rx;
          const sumRy = body.ry + other.ry;
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
          const bodyMovable = !body.fixed && !body.pinned;
          const otherMovable = !other.fixed && !other.pinned;
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
  var SPAWN_MIN_RADIUS = 130;
  var SPAWN_MAX_RADIUS = 320;

  // src/text.ts
  var FONT_STACK = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Source Han Sans SC", "Noto Sans CJK SC", system-ui, -apple-system, "Segoe UI", sans-serif';
  var FONT_SIZE = 13;
  var LINE_HEIGHT_RATIO = 1.45;
  var MIN_RADIUS = 26;
  var MAX_RADIUS = 78;
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
    if (m.lines.length <= 1 && textLength <= 4) {
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
    worldEl.style.setProperty("--accent", accent);
    worldEl.style.setProperty("--accent-soft", hueSoft(hue));
    worldEl.style.setProperty("--accent-line", `${accent}55`);
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
  function markEntering(inner) {
    inner.classList.add("is-entering");
    inner.addEventListener(
      "animationend",
      () => {
        inner.classList.remove("is-entering");
      },
      { once: true }
    );
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
    label.style.fontSize = `${FONT_SIZE}px`;
    inner.style.setProperty("--lines", String(fitLines(ry)));
    inner.appendChild(label);
    markEntering(inner);
    const view = { el, scale, inner, body, destroy: () => {
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
    markEntering(inner);
    const view = { el, scale, inner, body, destroy: () => {
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

  // src/store.ts
  var DB_NAME = "nebula";
  var DB_VERSION = 1;
  var STORE_SPACES = "spaces";
  var STORE_IDEAS = "ideas";
  var STORE_META = "meta";
  var STORE_TRASH = "trash";
  var META_LAST_SPACE_ID = "lastSpaceId";
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
        const tx = db.transaction(store, "readonly");
        const req = tx.objectStore(store).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error(`\u8BFB\u53D6 ${store} \u5931\u8D25`));
      });
    }
    readAll(store) {
      const db = this.requireDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(store, "readonly");
        const req = tx.objectStore(store).getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error(`\u8BFB\u53D6 ${store} \u5168\u90E8\u5931\u8D25`));
      });
    }
    readByIndex(store, index, key) {
      const db = this.requireDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(store, "readonly");
        const req = tx.objectStore(store).index(index).getAll(key);
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
        const tx = db.transaction(stores, "readwrite");
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("IndexedDB \u5199\u4E8B\u52A1\u5931\u8D25"));
        tx.onabort = () => reject(tx.error ?? new Error("IndexedDB \u5199\u4E8B\u52A1\u88AB\u4E2D\u6B62"));
        try {
          mutate(tx);
        } catch (err) {
          try {
            tx.abort();
          } catch {
          }
          reject(err);
        }
      });
    }
    // ── spaces ─────────────────────────────────────────────────
    putSpace(space) {
      return this.write([STORE_SPACES], (tx) => {
        tx.objectStore(STORE_SPACES).put(space);
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
      return this.write([STORE_SPACES], (tx) => {
        tx.objectStore(STORE_SPACES).delete(id);
      });
    }
    // ── ideas ──────────────────────────────────────────────────
    putIdea(idea) {
      return this.write([STORE_IDEAS], (tx) => {
        tx.objectStore(STORE_IDEAS).put(idea);
      });
    }
    /** 批量写入，单事务 —— 多设备合并拉回大量记录时用。 */
    putIdeas(ideas) {
      if (ideas.length === 0) return Promise.resolve();
      return this.write([STORE_IDEAS], (tx) => {
        const s = tx.objectStore(STORE_IDEAS);
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
        const tx = db.transaction(STORE_IDEAS, "readonly");
        const req = tx.objectStore(STORE_IDEAS).index("spaceId").count(spaceId);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error("\u7EDF\u8BA1\u60F3\u6CD5\u6570\u91CF\u5931\u8D25"));
      });
    }
    hardDeleteIdea(id) {
      return this.write([STORE_IDEAS], (tx) => {
        tx.objectStore(STORE_IDEAS).delete(id);
      });
    }
    // ── meta ───────────────────────────────────────────────────
    async getMeta(key) {
      const rec = await this.readOne(STORE_META, key);
      return rec?.value;
    }
    setMeta(key, value) {
      return this.write([STORE_META], (tx) => {
        tx.objectStore(STORE_META).put({ key, value });
      });
    }
    deleteMeta(key) {
      return this.write([STORE_META], (tx) => {
        tx.objectStore(STORE_META).delete(key);
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
    async getLastSpaceId() {
      return this.getMeta(META_LAST_SPACE_ID);
    }
    setLastSpaceId(id) {
      return this.setMeta(META_LAST_SPACE_ID, id);
    }
    // ── trash ──────────────────────────────────────────────────
    putTrash(entry) {
      return this.write([STORE_TRASH], (tx) => {
        tx.objectStore(STORE_TRASH).put(entry);
      });
    }
    getAllTrash() {
      return this.readAll(STORE_TRASH);
    }
    deleteTrash(id) {
      return this.write([STORE_TRASH], (tx) => {
        tx.objectStore(STORE_TRASH).delete(id);
      });
    }
    clearTrash() {
      return this.write([STORE_TRASH], (tx) => {
        tx.objectStore(STORE_TRASH).clear();
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
      await this.write([STORE_SPACES, STORE_TRASH], (tx) => {
        tx.objectStore(STORE_SPACES).put(tombstone);
        tx.objectStore(STORE_TRASH).put(entry);
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
      await this.write([STORE_SPACES, STORE_IDEAS, STORE_TRASH], (tx) => {
        tx.objectStore(STORE_SPACES).put(restored);
        const ideas = tx.objectStore(STORE_IDEAS);
        for (const idea of missing) ideas.put({ ...idea, spaceId: restored.id });
        tx.objectStore(STORE_TRASH).delete(entry.id);
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
    purgeEntries(entries) {
      return this.write([STORE_TRASH, STORE_SPACES, STORE_IDEAS], (tx) => {
        const trash = tx.objectStore(STORE_TRASH);
        const spaces = tx.objectStore(STORE_SPACES);
        const ideas = tx.objectStore(STORE_IDEAS);
        for (const entry of entries) {
          trash.delete(entry.id);
          if (entry.kind === "space" && entry.space) {
            spaces.delete(entry.space.id);
            for (const idea of entry.ideas ?? []) ideas.delete(idea.id);
          } else if (entry.kind === "idea" && entry.idea) {
            ideas.delete(entry.idea.id);
          }
        }
      });
    }
  };

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

  // src/view.ts
  function identityViewport() {
    return { scale: 1, tx: 0, ty: 0 };
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

  // src/main.ts
  var HEART_ID = "__heart__";
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
    heartView = null;
    heartBody = null;
    viewport = identityViewport();
    rafId = 0;
    frameIndex = 0;
    viewportSaveTimer = 0;
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
      this.expose();
      this.bindSelfTest();
      this.inputEl.focus();
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
      this.current = space;
      await this.store.setLastSpaceId(space.id);
      for (const view of this.views.values()) view.destroy();
      this.views.clear();
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
        pinned: true
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
        const view = createIdeaBubble(body, idea.text);
        this.views.set(idea.id, view);
        this.world.appendChild(view.el);
      }
      this.field.setActiveSpace(space.id);
      this.field.setSpaceBodies(space.id, bodies);
      const saved = opts.ignoreSaved ? void 0 : await this.store.getViewport(space.id);
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
    bodyFromIdea(idea) {
      let { x, y } = idea;
      if (x === 0 && y === 0) {
        const p = spawnPointFor(idea.id);
        x = p.x;
        y = p.y;
      }
      return {
        id: idea.id,
        spaceId: idea.spaceId,
        x,
        y,
        vx: 0,
        vy: 0,
        rx: 0,
        ry: 0,
        fixed: false,
        pinned: idea.pinned === 1
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
      this.stage.addEventListener("pointerdown", (e) => {
        if (e.target !== this.stage) return;
        panning = true;
        moved = false;
        lastX = e.clientX;
        lastY = e.clientY;
        this.stage.setPointerCapture(e.pointerId);
      });
      this.stage.addEventListener("pointermove", (e) => {
        if (!panning) return;
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        if (dx !== 0 || dy !== 0) moved = true;
        lastX = e.clientX;
        lastY = e.clientY;
        this.viewport = { ...this.viewport, tx: this.viewport.tx + dx, ty: this.viewport.ty + dy };
        this.applyViewport();
      });
      const endPan = (e) => {
        if (!panning) return;
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
        if (e.target !== this.stage) return;
        this.fitAll();
      });
    }
    // ── 空间操作 ──────────────────────────────────────────
    openSpaceLayer(focusRename) {
      this.spaceLayer.show(this.spaces, this.current?.id ?? "", focusRename);
    }
    async switchSpace(spaceId) {
      const space = this.spaces.find((s) => s.id === spaceId);
      if (!space) return;
      if (space.id === this.current?.id) {
        this.spaceLayer.close();
        return;
      }
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
      const bodies = this.field.bodiesOf(space.id);
      await this.store.putIdea(idea);
      const body = this.bodyFromIdea(idea);
      const view = createIdeaBubble(body, idea.text);
      this.views.set(idea.id, view);
      this.world.appendChild(view.el);
      bodies.push(body);
      this.field.setSpaceBodies(space.id, bodies);
      this.field.wake(0.45);
      this.startLoop();
      this.writeAll();
      this.ensureVisible(body);
      this.updateStatusLine();
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
