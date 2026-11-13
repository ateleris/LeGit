// Decision logic for the split commit button (Commit / Commit & Push, plus
// Commit & Force Push while amending).
// Pure so the backlog's behavior rules are pinned by unit tests: contextual
// Push/Publish label, detached HEAD degrades to plain Commit, amend pushes
// only through the explicit force-push choice, and an unset mode means plain
// commit.

import type { Branch, CommitButtonMode } from "../../lib/types";
import { resolveBranchPushPlan } from "../../lib/pushPlan";

/** The push leg the commit chains, when the plan has one. */
export interface CommitPushTarget {
  remote: string;
  branch: string;
  /** Publish: create/re-create the remote branch and set the upstream. */
  setUpstream: boolean;
  /** Push with `--force-with-lease` (an amended, already-tracked tip). */
  force: boolean;
}

export interface CommitButtonPlan {
  label:
    | "Commit"
    | "Amend"
    | "Commit & Push"
    | "Commit & Publish"
    | "Amend & Force Push"
    | "Amend & Publish";
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
  return { remote: plan.remote, branch: branch.name, setUpstream: publish, force: false };
}

/**
 * Label + push leg for the commit button given the persisted mode and the
 * current composer state. Every degradation lands on the plain-commit shape,
 * so the label never promises a push that cannot happen.
 *
 * `forcePush` is the transient amend-only choice (never persisted: a stored
 * force-push default would be a footgun). It applies only while amending; a
 * plain commit never force-pushes. An amended tip on a branch without a live
 * upstream has nothing to overwrite, so it publishes without force.
 */
export function commitButtonPlan(args: {
  mode: CommitButtonMode | null | undefined;
  amend: boolean;
  forcePush: boolean;
  detached: boolean;
  currentBranch: Branch | null;
  remotes: readonly string[];
}): CommitButtonPlan {
  if (args.amend && args.forcePush && !args.detached) {
    const target = commitPushTarget(args.currentBranch, args.remotes);
    if (!target) return { label: "Amend", push: null };
    if (target.setUpstream) return { label: "Amend & Publish", push: target };
    return { label: "Amend & Force Push", push: { ...target, force: true } };
  }
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

/**
 * The caret menu's entries. The force-push entry exists only while amending:
 * an amended tip that is already pushed can only be pushed with force.
 */
export type CommitMenuChoice = CommitButtonMode | "amend_force_push";

export function commitMenuChoices(amend: boolean): CommitMenuChoice[] {
  return amend
    ? ["commit", "commit_and_push", "amend_force_push"]
    : ["commit", "commit_and_push"];
}

export function commitPushSuccessMessage(push: CommitPushTarget): string {
  if (push.force) return `Amended and force-pushed '${push.branch}' to ${push.remote}`;
  return push.setUpstream
    ? `Committed and published '${push.branch}' to ${push.remote}`
    : `Committed and pushed '${push.branch}' to ${push.remote}`;
}

/** The push leg failing must never read as a failed commit. */
export function commitPushFailureMessage(detail: string): string {
  return `The commit succeeded, but the push failed: ${detail}`;
}
