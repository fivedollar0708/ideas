"use strict";
(() => {
  // src/rng.ts
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

  // src/store.ts
  var DB_NAME = "nebula";
  var DB_VERSION = 1;
  var STORE_SPACES = "spaces";
  var STORE_IDEAS = "ideas";
  var STORE_META = "meta";
  var STORE_TRASH = "trash";
  var META_LAST_SPACE_ID = "lastSpaceId";
  var viewportKey = (spaceId) => `viewport:${spaceId}`;
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
     * 清理过期回收站条目。**启动时与打开回收站时都要调**，因为启动时用户
     * 可能在别的空间，可能永远不打开回收站。
     *
     * 返回清理掉的条目数。
     */
    async purgeExpired(now = Date.now()) {
      const all = await this.getAllTrash();
      const expired = all.filter((e) => e.purgeAt > 0 && e.purgeAt <= now);
      if (expired.length === 0) return 0;
      await this.write([STORE_TRASH, STORE_SPACES, STORE_IDEAS], (tx) => {
        const trash = tx.objectStore(STORE_TRASH);
        const spaces = tx.objectStore(STORE_SPACES);
        const ideas = tx.objectStore(STORE_IDEAS);
        for (const entry of expired) {
          trash.delete(entry.id);
          if (entry.kind === "space" && entry.space) {
            spaces.delete(entry.space.id);
            for (const idea of entry.ideas ?? []) ideas.delete(idea.id);
          } else if (entry.kind === "idea" && entry.idea) {
            ideas.delete(entry.idea.id);
          }
        }
      });
      return expired.length;
    }
  };

  // src/types.ts
  var MAX_TEXT = 280;
  var SPACE_NAME_DEFAULT = "\u672A\u547D\u540D";
  var TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1e3;

  // src/text.ts
  var FONT_STACK = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Source Han Sans SC", "Noto Sans CJK SC", system-ui, -apple-system, "Segoe UI", sans-serif';
  var FONT_SIZE = 13;
  var MAX_RADIUS = 78;
  var PAD_X = 22;
  var CAP_MAX = 2 * (MAX_RADIUS - PAD_X);
  function norm(raw) {
    return raw.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
  }
  function clampText(s, max = MAX_TEXT) {
    if (s.length <= max) return { text: s, clipped: false };
    let cut = s.slice(0, Math.max(0, max - 1));
    if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
    return { text: cut.trimEnd() + "\u2026", clipped: true };
  }
  var measureCtx = null;
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

  // src/main.ts
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
  async function resolveCurrentSpace(store) {
    const spaces = await store.getAllSpaces();
    const lastId = await store.getLastSpaceId();
    if (spaces.length > 0) {
      const remembered = lastId ? spaces.find((s) => s.id === lastId) : void 0;
      return remembered ?? spaces[0];
    }
    const now = Date.now();
    const space = {
      id: newId(),
      name: `${SPACE_NAME_DEFAULT} 1`,
      hue: 0,
      createdAt: now,
      updatedAt: now,
      deleted: 0,
      purgeAt: 0
    };
    await store.putSpace(space);
    await store.setLastSpaceId(space.id);
    return space;
  }
  function renderIdeas(listEl, ideas) {
    listEl.replaceChildren();
    for (const idea of [...ideas].reverse()) {
      const li = document.createElement("li");
      li.dataset.id = idea.id;
      const text = document.createElement("span");
      text.className = "idea-text";
      text.textContent = idea.text;
      const time = document.createElement("span");
      time.className = "idea-meta";
      time.textContent = new Date(idea.createdAt).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
      });
      li.append(text, time);
      listEl.append(li);
    }
  }
  async function runSelfTest(store) {
    const results = [];
    const check = (name, ok, extra = "") => {
      results.push(`[${ok ? "OK  " : "FAIL"}] ${name}${extra ? "  " + extra : ""}`);
    };
    const now = Date.now();
    const probeSpaceId = newId();
    const probeIdeaId = newId();
    const probeMetaKey = `__selftest:${now}`;
    try {
      const space = {
        id: probeSpaceId,
        name: "\u81EA\u68C0\u7A7A\u95F4",
        hue: 3,
        createdAt: now,
        updatedAt: now,
        deleted: 0,
        purgeAt: 0
      };
      await store.putSpace(space);
      const readSpace = await store.getSpace(probeSpaceId);
      check("\u7A7A\u95F4 \u5199\u5165\u2192\u8BFB\u56DE", readSpace?.name === "\u81EA\u68C0\u7A7A\u95F4" && readSpace.hue === 3);
      const idea = {
        id: probeIdeaId,
        spaceId: probeSpaceId,
        text: "\u81EA\u68C0\u7528\u7684\u4E00\u53E5\u8BDD",
        createdAt: now,
        updatedAt: now,
        movedAt: now,
        x: 0,
        y: 0,
        pinned: 0,
        linksAlwaysOn: 0,
        archived: 0
      };
      await store.putIdea(idea);
      const bySpace = await store.getIdeasBySpace(probeSpaceId);
      check("\u60F3\u6CD5 \u7D22\u5F15\u67E5\u8BE2\uFF08spaceId\uFF09", bySpace.length === 1 && bySpace[0].id === probeIdeaId);
      const count = await store.countIdeasBySpace(probeSpaceId);
      check("\u60F3\u6CD5 \u8BA1\u6570", count === 1, `count=${count}`);
      await store.putIdea({ ...idea, archived: 1, updatedAt: now + 1 });
      const visible = await store.getIdeasBySpace(probeSpaceId);
      const all = await store.getIdeasBySpace(probeSpaceId, true);
      check("\u5F52\u6863\u8FC7\u6EE4", visible.length === 0 && all.length === 1);
      await store.setMeta(probeMetaKey, { hello: "\u4E16\u754C", n: 42 });
      const meta = await store.getMeta(probeMetaKey);
      check("meta \u5199\u5165\u2192\u8BFB\u56DE", meta?.hello === "\u4E16\u754C" && meta.n === 42);
      const otherId = newId();
      await store.setViewport(probeSpaceId, { scale: 1.5, tx: 10, ty: 20 });
      await store.setViewport(otherId, { scale: 0.5, tx: 0, ty: 0 });
      const vpA = await store.getViewport(probeSpaceId);
      const vpB = await store.getViewport(otherId);
      check("\u89C6\u53E3\u6309\u7A7A\u95F4\u9694\u79BB", vpA?.scale === 1.5 && vpB?.scale === 0.5);
      await store.hardDeleteIdea(probeIdeaId);
      await store.hardDeleteSpace(probeSpaceId);
      await store.deleteMeta(probeMetaKey);
      await store.deleteMeta(`viewport:${otherId}`);
      await store.deleteMeta(`viewport:${probeSpaceId}`);
      const gone = await store.getIdea(probeIdeaId);
      check("\u5220\u9664\u751F\u6548", gone === void 0);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      check("\u81EA\u68C0\u8FC7\u7A0B\u672A\u629B\u5F02\u5E38", false, message);
    }
    return results;
  }
  async function main() {
    const spaceNameEl = must("#space-name");
    const spaceCountEl = must("#space-count");
    const listEl = must("#list");
    const noticeEl = must("#notice");
    const inputEl = must("#input");
    const selfTestBtn = must("#selftest");
    const selfTestOut = must("#selftest-out");
    const notice = makeNotice(noticeEl);
    const store = new NebulaStore();
    try {
      await store.open();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      notice(`\u6253\u4E0D\u5F00\u672C\u5730\u6570\u636E\u5E93\uFF1A${message}`, "error");
      listEl.replaceChildren();
      spaceNameEl.textContent = "\u65E0\u6CD5\u542F\u52A8";
      return;
    }
    try {
      const purged = await store.purgeExpired();
      if (purged > 0) notice(`\u56DE\u6536\u7AD9\u6709 ${purged} \u9879\u5DF2\u5230\u671F\uFF0C\u5DF2\u6E05\u7406`, "info");
    } catch {
    }
    const space = await resolveCurrentSpace(store);
    const refresh = async () => {
      const ideas = await store.getIdeasBySpace(space.id);
      renderIdeas(listEl, ideas);
      spaceNameEl.textContent = space.name;
      spaceCountEl.textContent = `${ideas.length} \u6761`;
    };
    await refresh();
    mountInput({
      el: inputEl,
      onNotice: notice,
      async onSubmit(text) {
        const now = Date.now();
        const idea = {
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
          archived: 0
        };
        await store.putIdea(idea);
        await refresh();
        notice("\u8BB0\u4E0B\u4E86", "info");
      }
    });
    selfTestBtn.addEventListener("click", () => {
      selfTestOut.textContent = "\u6B63\u5728\u81EA\u68C0\u2026";
      void runSelfTest(store).then((lines) => {
        selfTestOut.textContent = lines.join("\n");
        const failed = lines.filter((l) => l.startsWith("[FAIL]")).length;
        notice(failed === 0 ? `\u81EA\u68C0\u901A\u8FC7\uFF08${lines.length} \u9879\uFF09` : `\u81EA\u68C0\u6709 ${failed} \u9879\u5931\u8D25`, failed === 0 ? "info" : "error");
      });
    });
    window.__nebula = {
      store,
      selfTest: () => runSelfTest(store),
      listIdeas: () => store.getAllIdeas(),
      currentSpace: space
    };
    inputEl.focus();
  }
  installFontStackVar();
  void main();
})();
