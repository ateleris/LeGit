// Decision logic for the split commit button (Commit / Commit & Push).
// Pure so the backlog's behavior rules are pinned by unit tests: contextual
// Push/Publish label, detached HEAD degrades to plain Commit, amend never
// auto-pushes, and an unset mode means plain commit.

import type { Branch, CommitButtonMode } from "../../lib/types";
import { resolveBranchPushPlan } from "../../lib/pushPlan";

/** The push leg the commit chains, when the plan has one. */
export interface CommitPushTarget {
  remote: string;
  branch: string;
  /** Publish: create/re-create the remote branch and set the upstream. */
  setUpstream: boolean;
}

export interface CommitButtonPlan {
  label: "Commit" | "Amend" | "Commit & Push" | "Commit & Publish";
  push: CommitPushTarget | null;
}

/**
 * Where a commit-and-push would send the current branch, or null when there
 * is no unambiguous target (no branch, no remotes, or an untracked branch in
 * a multi-remote repo - publishing picks the upstream, so that choice must
 * stay deliberate). A gone upstream still names its remote unambiguously and
 * re-publishes there (`setUpstream` re-establishes the tracking).
 */
export function commitPushTarget(
  branch: Branch | null,
  remotes: readonly string[],
): CommitPushTarget | null {
  if (!branch) return null;
  const plan = resolveBranchPushPlan(branch.upstream, remotes);
  if (plan.kind !== "push") return null;
  const publish = !branch.upstream || branch.upstream_gone || plan.setUpstream;
  return { remote: plan.remote, branch: branch.name, setUpstream: publish };
}

/**
 * Label + push leg for the commit button given the persisted mode and the
 * current composer state. Every degradation lands on the plain-commit shape,
 * so the label never promises a push that cannot happen.
 */
export function commitButtonPlan(args: {
  mode: CommitButtonMode | null | undefined;
  amend: boolean;
  detached: boolean;
  currentBranch: Branch | null;
  remotes: readonly string[];
}): CommitButtonPlan {
  if ((args.mode ?? "commit") !== "commit_and_push" || args.amend || args.detached) {
    return { label: args.amend ? "Amend" : "Commit", push: null };
  }
  const push = commitPushTarget(args.currentBranch, args.remotes);
  if (!push) return { label: "Commit", push: null };
  return { label: push.setUpstream ? "Commit & Publish" : "Commit & Push", push };
}

/** The caret-menu entry's contextual name for the commit-and-push mode. */
export function commitAndPushMenuLabel(
  branch: Branch | null,
  remotes: readonly string[],
): "Commit & Push" | "Commit & Publish" {
  return commitPushTarget(branch, remotes)?.setUpstream
    ? "Commit & Publish"
    : "Commit & Push";
}

export function commitPushSuccessMessage(push: CommitPushTarget): string {
  return push.setUpstream
    ? `Committed and published '${push.branch}' to ${push.remote}`
    : `Committed and pushed '${push.branch}' to ${push.remote}`;
}

/** The push leg failing must never read as a failed commit. */
export function commitPushFailureMessage(detail: string): string {
  return `The commit succeeded, but the push failed: ${detail}`;
}
