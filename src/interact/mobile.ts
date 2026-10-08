import type { Vec, Viewport } from '../types';
import { screenToWorld } from '../view';

/** Measure remaining occlusion, not innerHeight-height: dvh may already have shrunk. */
export function keyboardShift(layoutBottom: number, height: number, offsetTop: number, scale: number): number {
  return Math.abs(scale - 1) > 0.01 ? 0 : Math.max(0, layoutBottom - height - offsetTop);
}

export function mountKeyboard(dock: HTMLElement): void {
  const viewport = window.visualViewport;
  if (!viewport) return;
  let shift = 0;
  const update = (): void => {
    const focused = document.activeElement?.matches('input, textarea, [contenteditable="true"]');
    const baseline = dock.getBoundingClientRect().bottom + shift;
    shift = focused ? keyboardShift(baseline, viewport.height, viewport.offsetTop, viewport.scale) : 0;
    document.documentElement.style.setProperty('--kb', `${shift}px`);
  };
  viewport.addEventListener('resize', update);
  viewport.addEventListener('scroll', update);
  window.addEventListener('resize', update);
  document.addEventListener('focusin', update);
  document.addEventListener('focusout', () => requestAnimationFrame(update));
  new ResizeObserver(update).observe(dock);
  update();
}

export function pinchViewport(start: Viewport, anchor: Vec, center: Vec, ratio: number): Viewport {
  const world = screenToWorld(start, anchor);
  const scale = Math.max(0.25, Math.min(3, start.scale * ratio));
  return { scale, tx: center.x - world.x * scale, ty: center.y - world.y * scale };
}

export interface TouchHooks {
  viewport(): Viewport;
  cancelSingle(): void;
  apply(viewport: Viewport): void;
  save(): void;
}

/** Scoped to the canvas: inputs and scrollable dialogs keep native scrolling/zoom. */
export function mountPinch(stage: HTMLElement, hooks: TouchHooks): { readonly active: boolean } {
  let blocked = false;
  let start: { viewport: Viewport; center: Vec; distance: number; ids: number[] } | null = null;
  const geometry = (touches: TouchList) => {
    const a = touches[0], b = touches[1];
    const rect = stage.getBoundingClientRect();
    return {
      center: { x: (a.clientX + b.clientX) / 2 - rect.left, y: (a.clientY + b.clientY) / 2 - rect.top },
      distance: Math.max(1, Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)),
      ids: [a.identifier, b.identifier],
    };
  };
  stage.addEventListener('touchstart', e => {
    if (e.touches.length < 2) return;
    e.preventDefault();
    blocked = true;
    hooks.cancelSingle();
    start = { ...geometry(e.touches), viewport: { ...hooks.viewport() } };
  }, { passive: false });
  stage.addEventListener('touchmove', e => {
    // Suppress page scroll only for touches owned by this canvas.
    if (e.cancelable) e.preventDefault();
    if (!start || e.touches.length < 2) return;
    const next = geometry(e.touches);
    if (next.ids.some((id, i) => id !== start!.ids[i])) {
      start = { ...next, viewport: { ...hooks.viewport() } };
      return;
    }
    hooks.apply(pinchViewport(start.viewport, start.center, next.center, next.distance / start.distance));
  }, { passive: false });
  const end = (e: TouchEvent): void => {
    if (!blocked) return;
    if (e.cancelable) e.preventDefault();
    if (e.touches.length < 2 && start) { start = null; hooks.save(); }
    // A remaining finger must not resume the cancelled single-pointer drag.
    if (e.touches.length === 0) blocked = false;
  };
  stage.addEventListener('touchend', end, { passive: false });
  stage.addEventListener('touchcancel', end, { passive: false });
  stage.addEventListener('click', e => { if (blocked) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
  return { get active() { return blocked; } };
}
