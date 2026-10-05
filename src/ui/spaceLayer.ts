/**
 * 空间切换浮层。
 *
 * 交互（用户亲自定的）：
 *  - 点击心泡泡 → 浮出本层，底层星云变暗，**所有空间的心泡泡**浮现
 *  - 单击某个空间泡泡 → 切换到该空间
 *  - 双击某个空间泡泡 → 原地重命名
 *  - 每个泡泡右侧有个「×」→ 删除该空间（走回收站）
 *  - 底部：「新建空间」「打开回收站」
 *  - 点空白 / Esc → 收回
 *
 * 为什么删除是独立的小按钮，而不是"删掉心泡泡"：
 *    删掉心泡泡等于删掉整个空间。把它做成一个独立的、明确的动作，
 *    可以避免"我只是想移动它，结果整个空间没了"这种事。
 *
 * ⚠️ 单击与双击在同一元素上天然冲突（双击会先触发一次 click）。
 *    这里的选择是：**单击立即切换，双击进入改名**，不做 200ms 点击延迟判别。
 *    延迟判别会让每次切空间都明显变钝，而"双击别的空间时顺手切过去并进入改名"
 *    本身无害。若你更在意语义精确，在 handleClick 里加个 setTimeout 即可。
 *
 * 🔴 元素**原地更新、不重建**：切换当前空间时只改 class。
 *    如果每次刷新都重建元素，双击的第二下会落在新元素上，dblclick 根本不会触发。
 */

import { hueAccent, hueSoft } from '../render/bubble';
import type { Space } from '../types';

export interface SpaceLayerOptions {
  onSwitch(spaceId: string): void;
  onRename(spaceId: string, name: string): void;
  onCreate(): void;
  onOpenTrash(): void;
  onDelete(spaceId: string): void;
}

interface Row {
  space: Space;
  root: HTMLElement;
  main: HTMLButtonElement;
  label: HTMLElement;
  del: HTMLButtonElement;
  renameInput: HTMLInputElement | null;
}

export class SpaceLayer {
  private readonly root: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly backdrop: HTMLElement;
  private readonly opts: SpaceLayerOptions;

  private readonly rows = new Map<string, Row>();
  private currentId: string | null = null;
  private opened = false;
  private pendingRenameId: string | null = null;
  private renaming: string | null = null;

  constructor(root: HTMLElement, opts: SpaceLayerOptions) {
    this.root = root;
    this.opts = opts;
    this.backdrop = root.querySelector('.layer-backdrop') as HTMLElement;
    this.listEl = root.querySelector('.space-list') as HTMLElement;

    this.backdrop.addEventListener('click', () => this.close());

    (root.querySelector('#space-create') as HTMLButtonElement).addEventListener('click', () =>
      this.opts.onCreate(),
    );
    (root.querySelector('#space-trash') as HTMLButtonElement).addEventListener('click', () =>
      this.opts.onOpenTrash(),
    );

    this.root.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (this.renaming) this.cancelRename();
      else this.close();
    });
  }

  get isOpen(): boolean {
    return this.opened;
  }

  show(spaces: Space[], currentId: string, focusRename?: string): void {
    this.currentId = currentId;
    this.pendingRenameId = focusRename ?? null;
    this.render(spaces);
    this.root.hidden = false;
    this.root.classList.add('layer--visible');
    this.opened = true;
  }

  close(): void {
    if (this.renaming) this.cancelRename();
    this.root.classList.remove('layer--visible');
    this.root.hidden = true;
    this.opened = false;
    this.pendingRenameId = null;
  }

  /** 空间列表变化（新建 / 删除 / 恢复 / 改名）后刷新。 */
  render(spaces: Space[]): void {
    const alive = spaces.filter((s) => s.deleted === 0);
    const seen = new Set<string>();

    for (const space of alive) {
      seen.add(space.id);
      let row = this.rows.get(space.id);

      if (!row) {
        row = this.buildRow(space);
        this.listEl.appendChild(row.root);
      }

      row.space = space;
      row.label.textContent = space.name;
      row.root.classList.toggle('is-current', space.id === this.currentId);
      row.root.style.setProperty('--accent', hueAccent(space.hue));
      row.root.style.setProperty('--accent-soft', hueSoft(space.hue));
      row.del.title = `删除空间「${space.name}」`;
      // 只剩一个空间时不给删 —— 星云必须至少有一片
      row.del.disabled = alive.length <= 1;
    }

    for (const [id, row] of [...this.rows]) {
      if (seen.has(id)) continue;
      row.root.remove();
      this.rows.delete(id);
    }

    // 让所有泡泡错开一点点做入场，像"浮现"而不是"啪"地出现
    let i = 0;
    for (const row of this.rows.values()) {
      row.root.style.setProperty('--delay', `${i * 26}ms`);
      row.root.classList.add('is-visible');
      i++;
    }

    if (this.pendingRenameId) {
      const target = this.pendingRenameId;
      this.pendingRenameId = null;
      // 等浮层过渡起来一点再聚焦：iOS 上立刻聚焦会让键盘把浮层顶飞
      window.setTimeout(() => this.startRename(target), 120);
    }
  }

  private buildRow(space: Space): Row {
    const root = document.createElement('div');
    root.className = 'space-chip';
    root.dataset.spaceId = space.id;
    root.style.setProperty('--accent', hueAccent(space.hue));
    root.style.setProperty('--accent-soft', hueSoft(space.hue));

    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'space-chip-main';
    main.setAttribute('aria-label', `空间 ${space.name}`);

    const label = document.createElement('span');
    label.className = 'space-chip-label';
    label.textContent = space.name;
    main.appendChild(label);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'space-chip-del';
    del.textContent = '×';
    del.title = `删除空间「${space.name}」`;
    del.setAttribute('aria-label', `删除空间 ${space.name}`);

    root.append(main, del);

    const row: Row = { space, root, main, label, del, renameInput: null };
    this.rows.set(space.id, row);

    main.addEventListener('click', () => this.handleClick(space.id));
    main.addEventListener('dblclick', (e) => {
      e.preventDefault();
      this.startRename(space.id);
    });
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      this.opts.onDelete(space.id);
    });

    return row;
  }

  private handleClick(spaceId: string): void {
    if (this.renaming) return; // 改名态下点击不切空间
    if (spaceId === this.currentId) {
      this.close();
      return;
    }
    this.opts.onSwitch(spaceId);
  }

  // ── 原地重命名 ────────────────────────────────────────

  startRename(spaceId: string): void {
    const row = this.rows.get(spaceId);
    if (!row || this.renaming) return;

    this.renaming = spaceId;
    row.root.classList.add('is-renaming');

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'space-chip-input';
    input.value = row.space.name;
    input.maxLength = 24;
    input.setAttribute('aria-label', '空间名');

    row.label.replaceWith(input);
    row.renameInput = input;

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.commitRename(input.value);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.cancelRename();
      }
      e.stopPropagation();
    });
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('dblclick', (e) => e.stopPropagation());
    // 失焦即提交：点了别处通常就是想"就这么定了"
    input.addEventListener('blur', () => {
      if (this.renaming === spaceId) this.commitRename(input.value);
    });

    input.focus();
    input.select();
  }

  private commitRename(raw: string): void {
    const spaceId = this.renaming;
    if (!spaceId) return;
    this.renaming = null;

    const row = this.rows.get(spaceId);
    if (!row) return;

    row.root.classList.remove('is-renaming');
    if (row.renameInput) {
      row.renameInput.replaceWith(row.label);
      row.renameInput = null;
    }

    const name = raw.trim().slice(0, 24);
    if (name === '' || name === row.space.name) return; // 空名字 / 没改动 ⇒ 放弃

    this.opts.onRename(spaceId, name);
  }

  private cancelRename(): void {
    const spaceId = this.renaming;
    if (!spaceId) return;
    this.renaming = null;

    const row = this.rows.get(spaceId);
    if (!row) return;

    row.root.classList.remove('is-renaming');
    if (row.renameInput) {
      row.renameInput.replaceWith(row.label);
      row.renameInput = null;
    }
  }
}
