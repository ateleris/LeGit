import type { QueryClient } from "@tanstack/react-query";

/** Window in which a repeat invalidation for the same repo+domain is treated as
 *  the same logical action and (for coalescing callers) suppressed. */
const SUPPRESS_MS = 400;
const lastFired = new Map<string, number>(); // `${repoId} ${domain}` -> ms
const key = (repoId: string, domain: string) => `${repoId} ${domain}`;

/**
 * Invalidate `[repoId, domain]` query caches with leading-edge coalescing.
 *
 * - Action/manual callers (default): always fire, recording the time. This keeps
 *   user-initiated refreshes instant and never drops rapid distinct actions.
 * - The watcher (`coalesce: true`): a backstop — skipped for any domain already
 *   invalidated within SUPPRESS_MS, so the manual refresh + the watcher reading
 *   the same end-state collapse to a single refetch. With no preceding manual
 *   invalidation it fires normally; its own repeated emissions dedupe too.
 */
export function invalidateRepoDomains(
  qc: QueryClient,
  repoId: string,
  domains: Iterable<string>,
  opts?: { coalesce?: boolean; now?: number },
) {
  const coalesce = opts?.coalesce ?? false;
  const now = opts?.now ?? Date.now();
  for (const domain of domains) {
    const k = key(repoId, domain);
    if (coalesce) {
      const prev = lastFired.get(k);
      if (prev !== undefined && now - prev < SUPPRESS_MS) continue; // redundant repeat
    }
    lastFired.set(k, now);
    qc.invalidateQueries({ queryKey: [repoId, domain] });
  }
}

/** The watcher payloads do not carry a `submodules` domain yet (that lands
 * with the tier-2 watcher work): submodule-relevant changes classify as
 * `status` (index, worktree) or `branches`/`log` (HEAD moves). Derive the
 * domain so the Submodules section refreshes with them. */
export function withDerivedDomains(domains: string[]): string[] {
  if (!domains.includes("status") && !domains.includes("branches")) return domains;
  if (domains.includes("submodules")) return domains;
  return [...domains, "submodules"];
}
