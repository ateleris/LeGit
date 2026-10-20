// Names for git's conflict sides, shared by the Merge panel and the
// working-changes conflict menus.

import type { RepoOpState } from "./types";

export interface SideNames {
  ours: string | null;
  theirs: string | null;
}

/**
 * The branch (or commit) each conflict side comes from during the in-progress
 * operation. During a rebase the sides invert relative to intuition: git's
 * "ours" is the side being rebased ONTO, "theirs" the branch being rebased -
 * naming them is what untangles that. With no operation (stash-apply
 * conflicts), "ours" is still the current branch; "theirs" has no name.
 */
export function opSideNames(
  op: RepoOpState | null | undefined,
  currentBranch: string | null,
): SideNames {
  switch (op?.kind) {
    case "merge":
      return { ours: currentBranch, theirs: op.branch };
    case "rebase":
      return { ours: op.onto, theirs: op.head_name };
    case "cherry_pick":
    case "revert":
      return { ours: currentBranch, theirs: op.sha.slice(0, 8) };
    default:
      return { ours: currentBranch, theirs: null };
  }
}
