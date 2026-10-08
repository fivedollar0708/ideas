/** The quiet page keeps its utilities behind one discoverable, keyboard accessible button. */
export class ToolsPanel {
  constructor(private readonly panel: HTMLElement, private readonly toggle: HTMLButtonElement) {
    toggle.addEventListener('click', () => this.panel.hidden ? this.open() : this.close());
    document.addEventListener('pointerdown', event => {
      const target = event.target as Node;
      if (!panel.contains(target) && !toggle.contains(target)) this.close(false);
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !panel.hidden) {
        event.preventDefault();
        this.close();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        if (document.querySelector('.layer:not([hidden]), .zoom-layer:not([hidden])')) return;
        event.preventDefault();
        this.open(true);
      }
    });
  }

  get isOpen(): boolean { return !this.panel.hidden; }

  open(search = false): void {
    this.panel.hidden = false;
    this.toggle.setAttribute('aria-expanded', 'true');
    if (search) this.panel.querySelector<HTMLInputElement>('#search')?.focus();
  }

  close(returnFocus = true): void {
    if (this.panel.hidden) return;
    const hadFocus = this.panel.contains(document.activeElement);
    this.panel.hidden = true;
    this.toggle.setAttribute('aria-expanded', 'false');
    if (returnFocus && hadFocus) this.toggle.focus();
  }
}
