import type { RepoFileKind } from "../../lib/types";

/**
 * Whether a folder row may offer "Stop tracking & ignore": it needs at least
 * one tracked file (`git rm --cached -r` errors on a pathspec matching
 * nothing in the index), and no submodule may live under it - `-r` would rip
 * the gitlink out of the index, which is not untracking (proper removal
 * lives in the Submodules section), mirroring the file-row rule.
 */
export function canUntrackFolder(
  filePaths: string[],
  kindByPath: Map<string, RepoFileKind>,
  submodulePaths: ReadonlySet<string>,
): boolean {
  return (
    filePaths.some((p) => kindByPath.get(p) === "tracked") &&
    !filePaths.some((p) => submodulePaths.has(p))
  );
}
