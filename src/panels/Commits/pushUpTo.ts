import type { CommitId } from "../../lib/types";
import { resolveBranchPushPlan } from "../../lib/pushPlan";

/** Where a "Push up to this commit" would send the remote branch. */
export interface PushUpToTarget {
  remote: string;
  branch: string;
}

/**
 * Decide whether a commit row offers "Push up to this commit", and where the
 * push would go; null hides the entry. Eligibility comes from the backend's
 * `pushable_commits` set (first-parent chain of `@{upstream}..HEAD`), so the
 * remote branch move is always a fast-forward. The target must be a real
 * upstream on a configured remote: a publish (`--set-upstream`) of a partial
 * chain is not offered.
 */
export function pushUpToTarget(args: {
  commitId: CommitId;
  pushable: ReadonlySet<CommitId>;
  /** Current local branch name; null when HEAD is detached. */
  branchName: string | null;
  /** The current branch's upstream ref (full or short), null when untracked. */
  upstream: string | null;
  remotes: readonly string[];
}): PushUpToTarget | null {
  if (!args.branchName || !args.pushable.has(args.commitId)) return null;
  const plan = resolveBranchPushPlan(args.upstream, args.remotes);
  if (plan.kind !== "push" || plan.setUpstream) return null;
  return { remote: plan.remote, branch: args.branchName };
}
