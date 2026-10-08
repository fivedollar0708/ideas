export interface PerformanceSnapshot {
  ideas: number;
  rendered: number;
  renderTier: string;
  forceTier: string;
}

/** Sampling only while open: F2 must not keep an otherwise sleeping app awake. */
export function mountPerformancePanel(snapshot: () => PerformanceSnapshot): void {
  const panel = document.createElement('output');
  panel.className = 'performance-panel';
  panel.hidden = true;
  document.body.appendChild(panel);
  let raf = 0;
  let from = 0;
  let frames = 0;
  let fps = 0;
  const draw = (now: number): void => {
    frames++;
    if (now - from >= 500) {
      fps = frames * 1000 / (now - from);
      from = now;
      frames = 0;
      const s = snapshot();
      panel.textContent = `${fps.toFixed(1)} fps (rAF)\n泡泡 ${s.ideas} · DOM ${s.rendered}\n渲染 ${s.renderTier} · 力场 ${s.forceTier}`;
    }
    raf = requestAnimationFrame(draw);
  };
  const start = (): void => { from = performance.now(); frames = 0; raf = requestAnimationFrame(draw); };
  window.addEventListener('keydown', e => {
    if (e.key !== 'F2' || e.repeat) return;
    e.preventDefault();
    panel.hidden = !panel.hidden;
    cancelAnimationFrame(raf);
    if (!panel.hidden && !document.hidden) start();
  });
  document.addEventListener('visibilitychange', () => {
    cancelAnimationFrame(raf);
    if (!panel.hidden && !document.hidden) start();
  });
}
