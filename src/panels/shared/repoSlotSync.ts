// The Working Changes / Changed Files pair shares one dock slot, and which of
// the two is open is GLOBAL dock state - while each panel's shown commit and
// the log's selected commit are per-repo view state. Switching repo tabs
// restores the per-repo selections but not the slot occupant, so the slot must
// be re-derived from the activated repo's log selection or it keeps showing
// whatever the previous repo's last click left there.

import { useEffect, useRef } from "react";
import { useRepoStore } from "../../store/repos";
import { readPanelViewState } from "../../store/panelViewState";
import { useSummonStore } from "../../store/summon";
import { useDockviewStore } from "../../store/dockview";
import { WORKING_DIR_ID } from "../Commits/commitRows";

/** The panels' view-state keys this contract reads (single source: the
 *  panels import these for their own `usePanelViewState` calls). */
export const COMMITS_SELECTED_ID_KEY = "commits.selectedId";
export const CHANGED_FILES_SELECTED_ID_KEY = "changed-files.selectedId";

export type SlotAction =
  | { kind: "none" }
  /** Swap the slot to Working Changes (mirrors clicking the working-dir row). */
  | { kind: "show-working-changes" }
  /** Swap the slot to Changed Files showing `commitId` (mirrors a commit click). */
  | { kind: "show-changed-files"; commitId: string }
  /** Changed Files already holds the slot but shows another commit: re-deliver. */
  | { kind: "update-changed-files"; commitId: string };

/**
 * Decide how to reconcile the shared slot with the activated repo's log
 * selection. Deliberately conservative: a consistent state gets no delivery
 * (so the repo's per-file Diff view survives the switch), and a repo whose
 * layout has neither panel open is left alone.
 */
export function reconcileSlotAction(args: {
  /** The activated repo's log selection (WORKING_DIR_ID for the working-dir row). */
  selectedCommitId: string | null;
  /** The commit the activated repo's Changed Files last showed. */
  shownCommitId: string | null;
  changedFilesOpen: boolean;
  workingChangesOpen: boolean;
}): SlotAction {
  const { selectedCommitId, shownCommitId, changedFilesOpen, workingChangesOpen } = args;
  if (selectedCommitId !== null && selectedCommitId !== WORKING_DIR_ID) {
    if (changedFilesOpen) {
      return shownCommitId === selectedCommitId
        ? { kind: "none" }
        : { kind: "update-changed-files", commitId: selectedCommitId };
    }
    if (workingChangesOpen) {
      return { kind: "show-changed-files", commitId: selectedCommitId };
    }
    return { kind: "none" };
  }
  // Working-dir row or nothing selected: commit files must not hold the slot.
  if (changedFilesOpen && (selectedCommitId === WORKING_DIR_ID || shownCommitId !== null)) {
    return { kind: "show-working-changes" };
  }
  return { kind: "none" };
}

/**
 * Runs the reconcile whenever the active repo CHANGES (never on mount: the
 * restored startup layout must not be rewritten before any selection exists).
 * The swaps reuse the exact summon calls a row click makes, so suppression
 * ("Auto-open panels" opt-out) and payload semantics stay identical.
 */
export function useRepoSlotSync() {
  const activeRepoId = useRepoStore((s) => s.activeRepoId);
  const prev = useRef(activeRepoId);
  useEffect(() => {
    if (prev.current === activeRepoId) return;
    prev.current = activeRepoId;
    if (!activeRepoId) return;
    const api = useDockviewStore.getState().repoApi;
    if (!api) return;
    const action = reconcileSlotAction({
      selectedCommitId:
        readPanelViewState<string | null>(activeRepoId, COMMITS_SELECTED_ID_KEY) ?? null,
      shownCommitId:
        readPanelViewState<string | null>(activeRepoId, CHANGED_FILES_SELECTED_ID_KEY) ?? null,
      changedFilesOpen: !!api.getPanel("changed-files"),
      workingChangesOpen: !!api.getPanel("working-changes"),
    });
    const summon = useSummonStore.getState();
    if (action.kind === "show-changed-files") {
      summon.swapSummon("changed-files", "working-changes", action.commitId);
    } else if (action.kind === "show-working-changes") {
      summon.swapSummon("working-changes", "changed-files", null);
    } else if (action.kind === "update-changed-files") {
      summon.notifyIfOpen("changed-files", action.commitId);
    }
  }, [activeRepoId]);
}
