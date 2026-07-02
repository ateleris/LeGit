// Pure helper for the Commits panel: which commit does the synthetic
// "uncommitted changes" row hang off?

import type { Commit, CommitId } from "../../lib/types";

/**
 * The HEAD commit id, from log decorations (`HEAD` when detached,
 * `HEAD -> branch` otherwise). Falls back to the newest loaded *real* commit
 * when no HEAD decoration is in the window (possible when HEAD sits beyond
 * the loaded page). Injected stash nodes are skipped in the fallback — the
 * working-dir row must never hang off a stash.
 */
export function pickHeadCommitId(commits: Commit[]): CommitId | null {
  for (const c of commits) {
    for (const dec of c.decorations ?? []) {
      if (dec.type === "head" || dec.type === "headOf") return c.id;
    }
  }
  const firstReal = commits.find(
    (c) => !(c.decorations ?? []).some((d) => d.type === "stash"),
  );
  return firstReal?.id ?? null;
}
