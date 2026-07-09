import type { QueryClient } from "@tanstack/react-query";
import type { SubmoduleAutoUpdateResult, SubmoduleInfo } from "./types";
import { repoSubmoduleAutoUpdate } from "./commands";
import { invalidateRepoDomains } from "./repoInvalidation";
import { notify } from "../store/notifications";

/** Run the post-switch/pull submodule auto-update and surface the outcomes.
 * Fire-and-forget: failures here must never break the primary operation.
 * The command itself gates on the per-repo setting and the global switch
 * strategy; silent when nothing moved. */
export async function autoUpdateSubmodules(qc: QueryClient, repoId: string) {
  try {
    const results = await repoSubmoduleAutoUpdate(repoId);
    if (results.length > 0) {
      invalidateRepoDomains(qc, repoId, ["submodules", "status", "log"]);
    }
    notifySubmoduleUpdateResults(results);
  } catch (e) {
    console.warn("submodule auto-update failed", e);
  }
}

/** Toast the noteworthy per-submodule update outcomes (shared by the
 * auto-update hook and the manual "Pull latest" actions). Plain successes
 * stay silent - no toast spam. */
export function notifySubmoduleUpdateResults(results: SubmoduleAutoUpdateResult[]) {
  for (const r of results) {
    const s = r.status;
    if (s.kind === "rolled_back" || s.kind === "changes_in_stash") {
      notify.error(`Submodule ${r.path}: ${s.message}`);
    } else if (s.kind === "skipped") {
      notify.error(`Submodule ${r.path} not updated: ${s.message}`);
    } else if (s.kind === "changes_stashed") {
      notify.success(`Submodule ${r.path} updated - changes parked in its stash`);
    }
    // updated / changes_carried: silent success.
  }
}

/** Display badge for a submodule row, by severity precedence (spec
 * 2026-07-08: conflict > drift > orphan > pointer-moved > dirty >
 * uninitialized > detached > clean). Colors are existing theme tokens only. */
export function submoduleBadge(
  info: SubmoduleInfo,
): { label: string; color: string } | null {
  const s = info.state;
  if (s.conflicted) return { label: "conflict", color: "var(--status-conflicted)" };
  if (s.config_drift) return { label: "config drift", color: "var(--status-conflicted)" };
  if (s.orphan_gitlink) return { label: "orphan", color: "var(--status-conflicted)" };
  if (s.pointer_moved) return { label: "pointer moved", color: "var(--status-modified)" };
  if (s.dirty_tracked || s.dirty_untracked)
    return { label: "dirty", color: "var(--status-modified)" };
  if (!s.initialized || !s.populated)
    return { label: "uninitialized", color: "var(--subtle-fg)" };
  if (info.head_branch === null) return { label: "detached", color: "var(--subtle-fg)" };
  return null;
}
