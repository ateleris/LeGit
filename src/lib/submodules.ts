import { joinLocator } from "./locator";
import type { QueryClient } from "@tanstack/react-query";
import type { DiffEntry, DiffSource, SubmoduleAutoUpdateResult, SubmoduleInfo } from "./types";
import { repoDiff, repoSubmoduleAutoUpdate } from "./commands";
import { invalidateRepoDomains } from "./repoInvalidation";
import { notify } from "../store/notifications";
import { useRepoStore } from "../store/repos";
import { useSummonStore } from "../store/summon";

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

/** The commit to select in a just-opened submodule: the NEW pointer of the
 * superproject's changed entry (what the entry shows as "changed to").
 * Null when there is nothing to jump to - the entry is not a pointer move,
 * or the submodule was removed. */
export function submoduleSelectTarget(diff: DiffEntry): string | null {
  if (!("Submodule" in diff)) return null;
  return diff.Submodule.new_sha;
}

/** Open a submodule's own repo as a peer tab and, when `source` names the
 * superproject entry the user came from, select that entry's new pointer in
 * the submodule's log (design/2026-08-06-submodule-open-at-commit.md).
 * The pointer is resolved BEFORE the repo switch (repoDiff needs the
 * superproject session) and is best-effort: opening never fails on it. The
 * log's pending-jump seek gives up quietly if the commit does not exist
 * locally, so an unfetched target degrades to a plain open. */
export async function openSubmoduleRepo(
  repoId: string,
  /** The parent repo's LOCATOR string (RepoSummary.locator; falls back to
   * path for pre-locator callers) so a submodule of a WSL repo opens on the
   * same host. */
  repoLocator: string,
  path: string,
  source: DiffSource | null,
) {
  let target: string | null = null;
  if (source) {
    try {
      target = submoduleSelectTarget(await repoDiff(repoId, source, path, null, 0));
    } catch {
      target = null;
    }
  }
  await useRepoStore.getState().openRepo(joinLocator(repoLocator, path));
  if (target) {
    // openRepo has already switched the active repo, so these reach the
    // submodule's panels; the log defers to its seek when the commit is
    // beyond the loaded window. Mirror the full row-click chain
    // (CommitsPanel.handleRowClick) so details + changed files follow the
    // selection. The receiving panels keep these payloads across the repo
    // switch via useRepoSwitchClear's delivered-for marker.
    const summon = useSummonStore.getState();
    summon.summon("log", target);
    summon.summon("commit-details", target);
    summon.swapSummon("changed-files", "working-changes", target);
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
