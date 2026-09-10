import type { WorktreeInfo } from "../../lib/types";

/** Row label: the worktree folder's name (paths may be posix or Windows). */
export function worktreeLabel(w: WorktreeInfo): string {
  const parts = w.path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? w.path;
}

/** Badge strings for a row, in display order. `currentPath` is the open
 * session's own worktree path (its row gets "current" instead of an Open
 * action). */
export function worktreeBadges(w: WorktreeInfo, currentPath: string | null): string[] {
  const out: string[] = [];
  if (w.is_main) out.push("main");
  if (currentPath !== null && w.path === currentPath) out.push("current");
  if (w.dirty === true) out.push("dirty");
  if (w.detached) out.push("detached");
  if (w.locked !== null) out.push("locked");
  if (w.prunable !== null) out.push("prunable");
  return out;
}

/** What the graph indicators need to know about an OTHER worktree. */
export interface WorktreeMark {
  path: string;
  /** Uncommitted changes there (false also covers "unprobed" - the
   * indicator only ever asserts dirtiness, never guesses). */
  dirty: boolean;
}

/** Branch -> worktree mark for branches checked out in OTHER worktrees than
 * `currentPath` (the session's own). Feeds the commit graph's branch-chip
 * worktree indicator: such a branch cannot be switched to here. */
export function branchWorktreeMap(
  worktrees: WorktreeInfo[],
  currentPath: string | null,
): Map<string, WorktreeMark> {
  const normalize = (p: string) => p.replaceAll("\\", "/");
  const current = currentPath === null ? null : normalize(currentPath);
  const out = new Map<string, WorktreeMark>();
  for (const w of worktrees) {
    if (w.branch === null) continue;
    if (current !== null && normalize(w.path) === current) continue;
    out.set(w.branch, { path: w.path, dirty: w.dirty === true });
  }
  return out;
}

/** HEAD sha -> the OTHER worktrees sitting DETACHED on that commit (name +
 * path, insertion order). Branch checkouts are excluded: their branch chip
 * already carries the worktree indicator. Feeds the commit graph's
 * read-only worktree-head chips. */
export function detachedWorktreeHeads(
  worktrees: WorktreeInfo[],
  currentPath: string | null,
): Map<string, { name: string; path: string; dirty: boolean }[]> {
  const normalize = (p: string) => p.replaceAll("\\", "/");
  const current = currentPath === null ? null : normalize(currentPath);
  const out = new Map<string, { name: string; path: string; dirty: boolean }[]>();
  for (const w of worktrees) {
    if (!w.detached || w.head === null) continue;
    if (current !== null && normalize(w.path) === current) continue;
    const entry = { name: worktreeLabel(w), path: w.path, dirty: w.dirty === true };
    const list = out.get(w.head);
    if (list) list.push(entry);
    else out.set(w.head, [entry]);
  }
  return out;
}
