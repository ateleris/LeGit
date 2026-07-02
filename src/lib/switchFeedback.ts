// Shared user feedback for branch/commit switching — used by the Commits and
// Branches panels so the messaging (and its accuracy) stays in one place.

import type { SwitchOutcome } from "./types";
import { formatAppError, gitErrorKind } from "./types";
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
 * Message for a failed switch. The dirty-tree refusal (the most common failure
 * under the default "try directly" behavior) gets a specific, actionable
 * message; everything else shows git's own message.
 */
export function formatSwitchError(e: unknown): string {
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
