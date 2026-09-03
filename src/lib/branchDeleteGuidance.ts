import type { BranchMergeAnalysis } from "./types";

export interface BranchDeleteGuidance {
  /** Explanatory sentence(s) for the confirm dialog. */
  message: string;
  /** Emphasised data-loss warning line, only when loss is possible. */
  warning?: string;
}

/** Dialog content for a `BranchNotFullyMerged` refusal, from the (possibly
 * failed -> null) merge analysis. Containment beats patch-id equivalence:
 * a ref that literally contains the tip is the stronger signal. */
export function branchDeleteGuidance(
  analysis: BranchMergeAnalysis | null,
  branch: string,
): BranchDeleteGuidance {
  if (analysis && analysis.merged_into.length > 0) {
    const target = analysis.merged_into[0];
    return {
      message:
        `'${branch}' is already merged: '${target}' contains it, only the ` +
        "checked-out branch does not yet (git's safe delete checks against " +
        "that). Force delete is safe - or update the checked-out branch " +
        "first and delete normally.",
    };
  }
  if (analysis?.equivalent_in) {
    return {
      message:
        `The changes of '${branch}' appear merged into '${analysis.equivalent_in}' ` +
        "via a squash or rebase merge, so the commit IDs differ and git " +
        "cannot see the branch as merged. Force delete is safe.",
    };
  }
  if (analysis) {
    return {
      message:
        `Git refused the safe delete because '${branch}' has commits that ` +
        "no other branch contains.",
      warning: "Force deleting destroys those commits permanently.",
    };
  }
  return {
    message: `Git refused the safe delete: '${branch}' is not fully merged.`,
    warning:
      "Could not verify whether its changes are merged anywhere - force " +
      "deleting may destroy them permanently.",
  };
}
