// Shared user feedback for merge/rebase - used by the Commits, Branches and
// Working Changes panels so the messaging stays in one place (mirrors
// switchFeedback.ts).

import type { MergeOutcome, RebaseOutcome } from "./types";
import { formatAppError, gitErrorKind } from "./types";
import { notify } from "../store/notifications";

export function notifyMergeOutcome(outcome: MergeOutcome, target: string) {
  switch (outcome.kind) {
    case "fast_forwarded":
      notify.info(`Fast-forwarded to '${target}'.`);
      break;
    case "merged":
      notify.info(`Merged '${target}'.`);
      break;
    case "squashed":
      notify.info(
        `Squash of '${target}' staged - review the changes and commit when ready.`,
      );
      break;
    case "already_up_to_date":
      notify.info(`Already up to date with '${target}'.`);
      break;
    case "conflicts":
      notify.info(
        `Merging '${target}' hit conflicts. Resolve them in Working Changes, ` +
          `then Continue - or Abort to restore the previous state.`,
      );
      break;
  }
}

export function notifyRebaseOutcome(outcome: RebaseOutcome, onto: string) {
  switch (outcome.kind) {
    case "completed":
      notify.info(`Rebased onto '${onto}'.`);
      break;
    case "already_up_to_date":
      notify.info(`Already up to date with '${onto}'.`);
      break;
    case "conflicts":
      notify.info(
        `Rebasing onto '${onto}' hit conflicts. Resolve them in Working ` +
          `Changes, then Continue - or Skip the commit, or Abort the rebase.`,
      );
      break;
    case "completed_with_stash_conflicts":
      notify.info(
        `Rebased onto '${onto}', but restoring your auto-stashed changes ` +
          `produced conflicts - resolve them in the working tree. The stash ` +
          `entry was kept; drop it once resolved.`,
      );
      break;
  }
}

/** Error toast for a failed merge/rebase action (not a conflict - those are
 *  outcomes, handled above). */
export function notifyOpError(e: unknown) {
  if (gitErrorKind(e) === "WouldOverwriteLocalChanges") {
    notify.error(
      "This would overwrite uncommitted changes. Commit or stash them first.",
    );
    return;
  }
  notify.error(formatAppError(e));
}
