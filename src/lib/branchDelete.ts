import { confirmDialog } from "../store/confirm";
import { branchDeleteGuidance } from "./branchDeleteGuidance";
import { api } from "./commands";
import { gitErrorKind } from "./errors";
import type { BranchMergeAnalysis } from "./types";

/** Safe-delete `branch`; on git's "not fully merged" refusal, analyse WHY
 * and offer a force delete through the central dialog with case-specific
 * guidance (merged but the local base is stale / squash-rebase merged /
 * genuinely unmerged). The offer is a workflow prompt - a decision after an
 * async step - so it is always shown, never gated by the destructive-confirm
 * setting. Resolves true when the branch is gone; other errors rethrow for
 * the caller's normal handling. */
export async function deleteBranchGuided(repoId: string, branch: string): Promise<boolean> {
  try {
    await api.repoDeleteBranch(repoId, branch, false);
    return true;
  } catch (e) {
    if (gitErrorKind(e) !== "BranchNotFullyMerged") throw e;
    let analysis: BranchMergeAnalysis | null = null;
    try {
      analysis = await api.repoBranchMergeAnalysis(repoId, branch);
    } catch {
      // Best-effort: the guidance hedges when the analysis is missing.
    }
    const guidance = branchDeleteGuidance(analysis, branch);
    const ok = await confirmDialog({
      title: "Branch not fully merged",
      message: guidance.message,
      detail: branch,
      warning: guidance.warning,
      confirmLabel: "Force delete",
      cancelLabel: "Keep branch",
    });
    if (!ok) return false;
    await api.repoDeleteBranch(repoId, branch, true);
    return true;
  }
}
