import type { CaseDriftEntry } from "../../lib/types";
import type { FileTreeEntry } from "../shared/FileTree/buildTree";

/**
 * Merge detected case drift into the unstaged file list as synthetic rename
 * rows. A drift row renders under its ON-DISK path (what the user sees in
 * their file manager) with the index path as the rename source; it is
 * display-only apart from the "Stage rename" action (git has no diff for
 * it). An existing status row under the same path wins - the synthetic row
 * is skipped rather than duplicated.
 */
export function withCaseDriftRows(
  unstaged: FileTreeEntry[],
  drift: CaseDriftEntry[],
): FileTreeEntry[] {
  if (drift.length === 0) return unstaged;
  const existing = new Set(unstaged.map((f) => f.path));
  const rows = drift
    .filter((d) => !existing.has(d.disk_path))
    .map(
      (d): FileTreeEntry => ({
        path: d.disk_path,
        change: "Renamed",
        old_path: d.index_path,
      }),
    );
  return rows.length ? [...unstaged, ...rows] : unstaged;
}

/** Drift entries keyed by their on-disk path (the synthetic row's path), for
 *  row-level overrides: the badge, the Stage-rename action, no diff open. */
export function caseDriftByPath(drift: CaseDriftEntry[]): Map<string, CaseDriftEntry> {
  return new Map(drift.map((d) => [d.disk_path, d]));
}

/**
 * What the shared Diff/Merge slot should do when the selection changes.
 * Single normal row: show its diff. Single case-drift row: open a
 * rename-pair request instead - git sees a clean tree, so the pair diff is
 * empty and the Diff panel renders the "Renamed from old → new (no content
 * changes)" notice, mirroring the staged side. (Plain-opening showed a bogus
 * whole-file diff; not updating at all left the previous file's diff
 * standing.) Multi/empty selection: leave the slot alone (matches the
 * pre-drift behavior).
 */
export function selectionDiffAction(
  section: "staged" | "unstaged",
  paths: string[],
  driftPaths: ReadonlyMap<string, unknown>,
): "open" | "open_drift" | "keep" {
  if (paths.length !== 1) return "keep";
  if (section === "unstaged" && driftPaths.has(paths[0])) return "open_drift";
  return "open";
}

/**
 * Split bulk-action targets into case-drift rows and normal status rows.
 * Bulk stage/discard must route drift rows through their dedicated rename
 * commands - the plain pathspec commands act on paths git considers clean.
 */
export function splitDriftTargets(
  paths: string[],
  driftPaths: ReadonlyMap<string, CaseDriftEntry>,
): { drift: CaseDriftEntry[]; rest: string[] } {
  const drift: CaseDriftEntry[] = [];
  const rest: string[] = [];
  for (const path of paths) {
    const d = driftPaths.get(path);
    if (d) drift.push(d);
    else rest.push(path);
  }
  return { drift, rest };
}

/** Badge tooltip explaining the state and the fix. */
export function caseDriftTitle(entry: CaseDriftEntry): string {
  const kind = entry.is_dir ? "folder" : "file";
  return (
    `This ${kind} is tracked as "${entry.index_path}" - a case-only rename ` +
    `is invisible to git status. Stage rename records it (git mv); ` +
    `Discard rename restores the tracked spelling on disk.`
  );
}
