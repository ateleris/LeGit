// Decision logic for the "Undo last commit" convenience action: a friendly
// `reset --soft <head>~1` from the HEAD row's context menu (the undone
// commit stays reachable via the reflog, its changes come back staged).
// Pure so the visibility and warning rules are pinned by unit tests.

/**
 * - "hidden": not the HEAD row, a root commit (no parent to reset to), or a
 *   sequencer op is in progress (history rewrites are hidden then, like the
 *   cherry-pick/revert/reset entries).
 * - "warn_pushed": the tip is already on its remote (upstream exists and
 *   ahead === 0, the amend-pushed detection) - undoing makes the branch
 *   diverge, so warn first. Deliberately NOT gated by the destructive-confirm
 *   setting: a history/data-loss warning, not a destructive-action confirm.
 * - "run": local-only tip - soft reset loses nothing, run immediately.
 */
export type UndoLastCommitPlan = "hidden" | "warn_pushed" | "run";

export function undoLastCommitPlan(args: {
  isHeadRow: boolean;
  hasParent: boolean;
  opInProgress: boolean;
  hasUpstream: boolean;
  ahead: number | null;
}): UndoLastCommitPlan {
  if (!args.isHeadRow || !args.hasParent || args.opInProgress) return "hidden";
  if (args.hasUpstream && args.ahead === 0) return "warn_pushed";
  return "run";
}
