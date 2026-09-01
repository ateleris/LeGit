// Shared user feedback for branch/commit switching — used by the Commits and
// Branches panels so the messaging (and its accuracy) stays in one place.

import type { RemoteCheckoutOutcome, SwitchOutcome } from "./types";
import { formatAppError, gitErrorKind } from "./types";
import { lfsDownloadErrorMessage } from "./lfsFeedback";
import { notify } from "../store/notifications";

/**
 * Toast the non-clean outcomes of a successful switch. The two auto-stash
 * outcomes need *different* guidance: on conflicts the changes are already in
 * the working tree (with markers, stash kept) — telling the user to `git stash
 * pop` again would be wrong; on a failed pop the changes are still parked in
 * the stash.
 */
export function notifySwitchOutcome(outcome: SwitchOutcome, target: string) {
  if (outcome.kind === "changes_stashed") {
    notify.info(
      `Switched to '${target}'. Your uncommitted changes were stashed — ` +
        `apply them from the Stashes panel when you need them.`,
    );
  } else if (outcome.kind === "stash_pop_conflicts") {
    notify.info(
      `Switched to '${target}', but restoring your auto-stashed changes produced ` +
        `conflicts — resolve them in the working tree. The stash entry was kept; ` +
        `drop it once the conflicts are resolved.`,
    );
  } else if (outcome.kind === "stash_pop_failed") {
    notify.info(
      `Switched to '${target}', but your auto-stashed changes could not be ` +
        `reapplied. They are safe in the stash — apply it from the Stashes panel.`,
    );
  }
}

/**
 * Toast the outcome of a remote-branch checkout (switch + optional local
 * fast-forward). A clean switch that needed no fast-forward stays silent
 * (parity with `notifySwitchOutcome`); a fast-forward is state the click
 * moved beyond the obvious, so it is always announced. Non-clean switch
 * outcomes keep their stash guidance, with the ff result as a second toast.
 */
export function notifyRemoteCheckoutOutcome(
  outcome: RemoteCheckoutOutcome,
  remoteRef: string,
) {
  const local = outcome.local_branch;
  const ff = outcome.fast_forward;
  const clean = outcome.switch.kind === "clean";
  if (!clean) {
    notifySwitchOutcome(outcome.switch, local);
  }
  if (ff.kind === "fast_forwarded") {
    notify.info(
      clean
        ? `Switched to '${local}' and fast-forwarded to '${remoteRef}'.`
        : `'${local}' was also fast-forwarded to '${remoteRef}'.`,
    );
  } else if (ff.kind === "diverged") {
    notify.info(
      `Switched to '${local}', which has diverged from '${remoteRef}' - ` +
        `it was left as-is. Merge or rebase to reconcile.`,
    );
  } else if (ff.kind === "failed") {
    notify.error(
      `Switched to '${local}', but fast-forwarding to '${remoteRef}' failed: ${ff.message}`,
    );
  }
}

/**
 * Message for a failed switch. The dirty-tree refusal (the most common failure
 * under the default "try directly" behavior) gets a specific, actionable
 * message; everything else shows git's own message.
 */
export function formatSwitchError(e: unknown): string {
  const lfs = lfsDownloadErrorMessage(e, "switch");
  if (lfs) return lfs;
  if (gitErrorKind(e) === "WouldOverwriteLocalChanges") {
    return (
      "Switching would overwrite uncommitted changes. Commit or stash them " +
      "first — or enable auto-stash in Settings to carry them across."
    );
  }
  return formatAppError(e);
}

/** Toast variant of `formatSwitchError`. */
export function notifySwitchError(e: unknown) {
  notify.error(formatSwitchError(e));
}
