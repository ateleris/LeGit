// Multi-commit selection for the Commits panel: the click-gesture state
// machine (plain / Ctrl / Shift / Ctrl+Shift) and the bulk-action plan built
// from a selection. Pure data-in/data-out, like the other Commits helpers,
// so the rules live in multiSelect.test.ts rather than in panel wiring.

import type { CommitId, RebaseStep } from "../../lib/types";

export interface SelectionState {
  /** The last-clicked row: shift-range anchor, and the commit whose details
   * are shown. Multi-select gestures move it to the clicked row; a shift
   * range keeps it so successive shift-clicks re-range from one anchor. */
  lead: CommitId | null;
  /** Every selected row (always contains the lead when one is set). */
  ids: ReadonlySet<CommitId>;
}

export interface ClickModifiers {
  ctrl: boolean;
  shift: boolean;
}

/**
 * The next selection after a row click. `rowIds` is the current display
 * order (newest first); `isMultiSelectable` excludes rows that can never be
 * part of a multi-selection (the working-dir row, stash rows) - modifier
 * clicks on those are no-ops, while a plain click selects them alone as
 * always. Returns the input state unchanged for no-op gestures.
 */
export function applyRowClickSelection(
  state: SelectionState,
  rowIds: readonly CommitId[],
  clickedId: CommitId,
  modifiers: ClickModifiers,
  isMultiSelectable: (id: CommitId) => boolean,
): SelectionState {
  if (!modifiers.ctrl && !modifiers.shift) {
    return { lead: clickedId, ids: new Set([clickedId]) };
  }
  if (!isMultiSelectable(clickedId)) return state;

  // A plain click may have left a non-selectable id (workdir/stash) in the
  // set - a growing multi-selection must not keep it.
  const base = new Set([...state.ids].filter(isMultiSelectable));

  if (modifiers.shift) {
    const anchor =
      state.lead !== null && isMultiSelectable(state.lead) && rowIds.includes(state.lead)
        ? state.lead
        : clickedId;
    const from = rowIds.indexOf(anchor);
    const to = rowIds.indexOf(clickedId);
    const [lo, hi] = from <= to ? [from, to] : [to, from];
    const range = rowIds.slice(lo, hi + 1).filter(isMultiSelectable);
    const ids = modifiers.ctrl ? new Set([...base, ...range]) : new Set(range);
    return { lead: anchor, ids };
  }

  // Ctrl: toggle the clicked row.
  if (base.has(clickedId)) {
    base.delete(clickedId);
    return { lead: base.size > 0 ? clickedId : null, ids: base };
  }
  base.add(clickedId);
  return { lead: clickedId, ids: base };
}

export interface BulkRow {
  id: CommitId;
  isMerge: boolean;
}

export interface BulkPlan {
  /** Selected commits that still exist in the rows (stale ids dropped). */
  count: number;
  /** Oldest first: each pick applies on top of the previous one. */
  cherryPickShas: CommitId[];
  /** Newest first: each revert unwinds on top of the previous one. */
  revertShas: CommitId[];
  /** Exactly two selected: the older..newer range for the Compare panel. */
  compare: { from: CommitId; to: CommitId } | null;
  /** Cherry-pick/revert of a merge needs a per-commit mainline answer, so
   * bulk actions are disabled while one is in the selection. */
  containsMerge: boolean;
}

/** Build the bulk-action plan for a selection. `rows` is the current display
 * order (newest first). */
export function bulkActionPlan(
  selected: ReadonlySet<CommitId>,
  rows: readonly BulkRow[],
): BulkPlan {
  const inRows = rows.filter((r) => selected.has(r.id));
  const newestFirst = inRows.map((r) => r.id);
  const oldestFirst = [...newestFirst].reverse();
  return {
    count: inRows.length,
    cherryPickShas: oldestFirst,
    revertShas: newestFirst,
    compare:
      inRows.length === 2 ? { from: newestFirst[1], to: newestFirst[0] } : null,
    containsMerge: inRows.some((r) => r.isMerge),
  };
}

/** A bulk drop/squash rebase plan over the FULL `base..HEAD` range
 * (`rangeNewestFirst`, as `git log` returns it - never the visible rows,
 * which can be filtered or show other branches). Todo order: oldest first.
 * Drop: selected commits drop, the rest pick. Squash: the OLDEST selected
 * commit rewords to `message` and the other selected commits follow it as
 * fixup (non-contiguous selections collapse at the oldest position; a fixup
 * melds into the preceding kept step, so the reword's message wins and no
 * editor opens). Null when a selected commit is missing from the range -
 * the caller must not run a plan that silently ignores selection. */
export function bulkRebasePlan(
  kind: "drop" | "squash",
  selected: ReadonlySet<CommitId>,
  rangeNewestFirst: readonly CommitId[],
  message: string | null,
): RebaseStep[] | null {
  const range = new Set(rangeNewestFirst);
  for (const id of selected) {
    if (!range.has(id)) return null;
  }
  const oldestFirst = [...rangeNewestFirst].reverse();
  if (kind === "drop") {
    return oldestFirst.map((sha) => ({
      action: selected.has(sha) ? "drop" : "pick",
      sha,
    }));
  }
  const steps: RebaseStep[] = [];
  let emittedGroup = false;
  for (const sha of oldestFirst) {
    if (!selected.has(sha)) {
      steps.push({ action: "pick", sha });
      continue;
    }
    if (emittedGroup) continue;
    emittedGroup = true;
    steps.push({ action: "reword", sha, message: message ?? "" });
    for (const other of oldestFirst) {
      if (other !== sha && selected.has(other)) {
        steps.push({ action: "fixup", sha: other });
      }
    }
  }
  return steps;
}

/** Whether the selected commits form an unbroken run in the display rows -
 * drives the "collapses at the oldest selected commit's position" warning
 * for non-contiguous squashes (a heads-up, not a gate). */
export function selectionContiguous(
  selected: ReadonlySet<CommitId>,
  rows: readonly BulkRow[],
): boolean {
  const indices = rows
    .map((r, i) => (selected.has(r.id) ? i : -1))
    .filter((i) => i >= 0);
  if (indices.length <= 1) return true;
  return indices[indices.length - 1] - indices[0] === indices.length - 1;
}
