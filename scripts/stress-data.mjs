/** Fixture only: consumed by isolated CDP runs, never a production import. */
export async function seedStress(count) {
  const api = window.__nebula;
  if (!api || api.isLoggedIn()) throw new Error('仅在未登录的隔离测试环境灌数据');
  const spaceId = api.current().id;
  const now = Date.now();
  const ideas = Array.from({ length: count }, (_, i) => ({
    id: `stress-${String(i).padStart(5, '0')}`, spaceId,
    text: i === 0 ? '觅' : `压测 ${i} · ${'凌晨三点的灵感与水面波纹'.repeat(1 + i % 8)}`,
    createdAt: now, updatedAt: now, movedAt: 0, x: 0, y: 0,
    pinned: 0, linksAlwaysOn: 0, archived: 0,
  }));
  await Promise.all(ideas.map(idea => api.store.putIdea(idea)));
  await api.refresh();
  return api.performance();
}
