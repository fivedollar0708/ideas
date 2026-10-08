import type { Body } from './physics/force';

/** Current-space idea counts; the heart is never counted or culled. */
export const PERFORMANCE = {
  fullLimit: 300,
  cullAfter: 800,
  largestCount: 300,
  fontReduction: 1,
} as const;

export function renderPolicy(count: number) {
  return {
    tier: count <= PERFORMANCE.fullLimit ? 'full' : count <= PERFORMANCE.cullAfter ? 'light' : 'culled',
    ripple: count <= PERFORMANCE.fullLimit,
    glow: count <= PERFORMANCE.fullLimit,
    fontReduction: count <= PERFORMANCE.fullLimit ? 0 : PERFORMANCE.fontReduction,
    culled: count > PERFORMANCE.cullAfter,
  };
}

/** The >800 exception: stable largest-300 base plus current search hits. */
export function renderedIds(bodies: readonly Body[], hits: ReadonlySet<string>): Set<string> {
  const ids = renderPolicy(bodies.length).culled
    ? [...bodies].sort((a, b) => b.rx * b.ry - a.rx * a.ry || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(0, PERFORMANCE.largestCount).map(b => b.id)
    : bodies.map(b => b.id);
  return new Set([...ids, ...hits]);
}
