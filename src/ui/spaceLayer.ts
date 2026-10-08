/**
 * 空间切换浮层。
 *
 * 交互（用户亲自定的）：
 *  - 点击心泡泡 → 全屏星图，底层想法暂时隐藏，**所有空间的心泡泡**浮现
 *  - 单击某个空间泡泡 → 切换到该空间
 *  - 独立的改名按钮 → 原地重命名（触屏也可用）
 *  - 每个泡泡右侧有个「×」→ 删除该空间（走回收站）
 *  - 底部：「新建空间」「打开回收站」
 *  - 点空白 / Esc → 收回
 *
 * 为什么删除是独立的小按钮，而不是"删掉心泡泡"：
 *    删掉心泡泡等于删掉整个空间。把它做成一个独立的、明确的动作，
 *    可以避免"我只是想移动它，结果整个空间没了"这种事。
 *
 * 单击进入空间与改名使用独立入口：第一下点击关闭星图后无法再接收 dblclick。
 * 导航星体只代表已有 Space，不创建合成 Space，不参与想法的力场。
 *
 * 🔴 元素**原地更新、不重建**：保存改名时保留行与焦点，避免编辑中被异步刷新打断。
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
  renameForm: HTMLElement | null;
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
    root.addEventListener('click', event => {
      if (event.target === this.listEl || (event.target as HTMLElement).classList.contains('space-map')) this.close();
    });
    window.visualViewport?.addEventListener('resize', () => {
      if (!this.opened || !this.renaming) return;
      requestAnimationFrame(() => this.rows.get(this.renaming ?? '')?.renameInput?.scrollIntoView({block: 'nearest'}));
    });

    (root.querySelector('#space-create') as HTMLButtonElement).addEventListener('click', () =>
      this.opts.onCreate(),
    );
    (root.querySelector('#space-trash') as HTMLButtonElement).addEventListener('click', () =>
      this.opts.onOpenTrash(),
    );
    (root.querySelector('#space-close') as HTMLButtonElement).addEventListener('click', () => this.close());

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
    document.body.classList.add('space-overview-open');
    this.opened = true;
    if (!focusRename) this.rows.get(currentId)?.main.focus({preventScroll: true});
  }

  close(): void {
    if (this.renaming) this.cancelRename();
    this.root.classList.remove('layer--visible');
    this.root.hidden = true;
    document.body.classList.remove('space-overview-open');
    this.opened = false;
    this.pendingRenameId = null;
    if (this.root.contains(document.activeElement)) {
      document.querySelector<HTMLElement>('#world .bubble--heart')?.focus({preventScroll: true});
    }
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
      row.main.setAttribute('aria-label', `进入空间 ${space.name}`);
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
      window.setTimeout(() => { if (this.opened) this.startRename(target); }, 120);
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

    const actions = document.createElement('div');
    actions.className = 'space-chip-actions';
    const rename = document.createElement('button');
    rename.type = 'button';
    rename.className = 'space-chip-rename';
    rename.textContent = '改名';
    rename.setAttribute('aria-label', `重命名空间 ${space.name}`);
    rename.addEventListener('click', () => this.startRename(space.id));
    actions.append(rename, del);
    root.append(main, actions);

    const row: Row = { space, root, main, label, del, renameInput: null, renameForm: null };
    this.rows.set(space.id, row);

    main.addEventListener('click', () => this.handleClick(space.id));
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
    if (!row || this.renaming || !this.opened) return;

    this.renaming = spaceId;
    row.root.classList.add('is-renaming');

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'space-chip-input';
    input.value = row.space.name;
    input.maxLength = 24;
    input.setAttribute('aria-label', '空间名');

    // Editing is a sibling of the navigation button, never an input nested inside a button.
    const form = document.createElement('div');
    form.className = 'space-edit';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn btn--small';
    save.textContent = '保存';
    save.addEventListener('click', () => this.commitRename(input.value));
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn--small';
    cancel.textContent = '取消';
    cancel.addEventListener('click', () => this.cancelRename());
    form.append(input, save, cancel);
    row.root.append(form);
    row.main.disabled = true;
    row.renameForm = form;
    row.renameInput = input;

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        if (e.isComposing || e.keyCode === 229) return;
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
    // Moving focus to Save/Cancel stays inside the editor; leaving it commits.
    input.addEventListener('blur', () => {
      window.setTimeout(() => {
        if (this.renaming === spaceId && !form.contains(document.activeElement)) this.commitRename(input.value);
      }, 0);
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
    row.main.disabled = false;
    row.renameForm?.remove();
    row.renameForm = null;
    if (row.renameInput) {
      row.renameInput = null;
    }
    row.main.focus({preventScroll: true});

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
    row.main.disabled = false;
    row.renameForm?.remove();
    row.renameForm = null;
    if (row.renameInput) {
      row.renameInput = null;
    }
    row.main.focus({preventScroll: true});
  }
}
