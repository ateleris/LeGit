/** Most-recent-first activation history for repo tabs. Drives "closing the
 * active tab returns to the previously used repo" (browser-style MRU), not
 * "jump to the first tab". Pure functions - the store owns the state. */

/** Record `id` as the latest activation: move-to-front, deduplicated,
 * capped so the list cannot grow unboundedly over a long session. */
export function pushActivation(history: string[], id: string, cap = 50): string[] {
  return [id, ...history.filter((h) => h !== id)].slice(0, cap);
}

/** Pick the repo to activate when the current one disappeared: the most
 * recently activated repo that is still open, else the first open repo,
 * else none. */
export function pickNextActive(history: string[], presentIds: string[]): string | null {
  const present = new Set(presentIds);
  for (const id of history) {
    if (present.has(id)) return id;
  }
  return presentIds[0] ?? null;
}
