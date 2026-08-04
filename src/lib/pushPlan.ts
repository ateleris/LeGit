import { splitRemoteRef } from "./branchGroups";

/**
 * Where a "Push branch" action should send a branch:
 * - `push`: an unambiguous target - the upstream's remote, or the only
 *   configured remote (then publishing, so `--set-upstream`).
 * - `choose`: untracked branch in a multi-remote repo - the user must pick
 *   (the choice becomes the upstream, so it must be deliberate).
 * - `none`: no remotes configured; there is nothing to push to.
 */
export type BranchPushPlan =
  | { kind: "push"; remote: string; setUpstream: boolean }
  | { kind: "choose"; remotes: string[] }
  | { kind: "none" };

/**
 * Decide the push target for a branch from its upstream (full or short ref,
 * null when untracked) and the configured remote names. An upstream whose
 * remote is no longer configured counts as untracked - pushing "there" would
 * fail, so the branch is re-published instead.
 */
export function resolveBranchPushPlan(
  upstream: string | null,
  remotes: readonly string[],
): BranchPushPlan {
  if (remotes.length === 0) return { kind: "none" };

  const short = upstream?.replace(/^refs\/remotes\//, "") ?? null;
  if (short) {
    const split = splitRemoteRef(short, remotes);
    if (split && remotes.includes(split.remote)) {
      return { kind: "push", remote: split.remote, setUpstream: false };
    }
  }

  if (remotes.length === 1) {
    return { kind: "push", remote: remotes[0], setUpstream: true };
  }
  return { kind: "choose", remotes: [...remotes] };
}
