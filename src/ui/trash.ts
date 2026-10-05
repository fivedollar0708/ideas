/**
 * 回收站浮层。
 *
 * 全局一个，同时装两种东西：
 *  - 被删的空间（连同它全部想法的快照）
 *  - 被删的想法（第一版没有这个入口，但数据结构与恢复逻辑已经支持，阶段 6 之后接）
 *
 * 显示剩余天数，因为"30 天后真删"这件事必须让用户看得见 ——
 * 看不见的倒计时等于没有倒计时。
 */

import { hueAccent } from '../render/bubble';
import type { TrashEntry } from '../types';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface TrashLayerOptions {
  onRestore(trashId: string): void;
  onEmpty(): void;
}

export class TrashLayer {
  private readonly root: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly backdrop: HTMLElement;
  private readonly emptyEl: HTMLElement;
  private readonly opts: TrashLayerOptions;
  private open = false;

  constructor(root: HTMLElement, opts: TrashLayerOptions) {
    this.root = root;
    this.opts = opts;
    this.backdrop = root.querySelector('.layer-backdrop') as HTMLElement;
    this.listEl = root.querySelector('.trash-list') as HTMLElement;
    this.emptyEl = root.querySelector('.trash-empty') as HTMLElement;

    this.backdrop.addEventListener('click', () => this.close());

    (root.querySelector('#trash-close') as HTMLButtonElement).addEventListener('click', () =>
      this.close(),
    );
    (root.querySelector('#trash-empty-btn') as HTMLButtonElement).addEventListener('click', () =>
      this.opts.onEmpty(),
    );

    this.root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close();
    });
  }

  get isOpen(): boolean {
    return this.open;
  }

  show(entries: TrashEntry[], now: number = Date.now()): void {
    this.render(entries, now);
    this.root.hidden = false;
    this.root.classList.add('layer--visible');
    this.open = true;
  }

  close(): void {
    this.root.classList.remove('layer--visible');
    this.root.hidden = true;
    this.open = false;
  }

  render(entries: TrashEntry[], now: number = Date.now()): void {
    this.listEl.replaceChildren();

    if (entries.length === 0) {
      this.emptyEl.hidden = false;
      return;
    }
    this.emptyEl.hidden = true;

    // 快到期的排前面 —— 最需要你赶紧决定的那条最该被看见
    const sorted = [...entries].sort((a, b) => a.purgeAt - b.purgeAt);

    for (const entry of sorted) {
      const li = document.createElement('li');
      li.className = 'trash-item';
      li.dataset.trashId = entry.id;

      const isSpace = entry.kind === 'space';
      const name = isSpace ? (entry.space?.name ?? '（无名空间）') : (entry.idea?.text ?? '（空想法）');
      const count = isSpace ? (entry.ideas?.length ?? 0) : 1;

      if (isSpace && entry.space) {
        li.style.setProperty('--accent', hueAccent(entry.space.hue));
      }

      const title = document.createElement('div');
      title.className = 'trash-title';
      title.textContent = name;

      const meta = document.createElement('div');
      meta.className = 'trash-meta';
      const days = Math.max(0, Math.ceil((entry.purgeAt - now) / DAY_MS));
      meta.textContent = isSpace
        ? `空间 · ${count} 条想法 · ${days} 天后清除`
        : `想法 · ${days} 天后清除`;

      const restoreBtn = document.createElement('button');
      restoreBtn.type = 'button';
      restoreBtn.className = 'btn btn--small';
      restoreBtn.textContent = '恢复';
      restoreBtn.addEventListener('click', () => this.opts.onRestore(entry.id));

      const text = document.createElement('div');
      text.className = 'trash-text';
      text.append(title, meta);

      li.append(text, restoreBtn);
      this.listEl.appendChild(li);
    }
  }
}
