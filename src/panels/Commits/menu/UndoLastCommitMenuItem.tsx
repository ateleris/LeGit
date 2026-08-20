import { useMenuConfirm } from "./PanelContextMenu";
import { MenuItem } from "./primitives";

/**
 * "Undo last commit" entry for the HEAD row's context menu: soft-resets to
 * the parent, so the commit's changes come back staged. Loses nothing
 * locally - the only warning case is a pushed tip (`pushed`), where undoing
 * makes the branch diverge from its remote. That warning is a history/
 * data-loss warning like the amend-pushed one, deliberately NOT gated by the
 * destructive-confirmation setting (see `undoLastCommitPlan`).
 */
export function UndoLastCommitMenuItem({
  pushed,
  onUndo,
}: {
  pushed: boolean;
  onUndo: () => void;
}) {
  const menuConfirm = useMenuConfirm();
  const request = () => {
    if (!pushed) {
      onUndo();
      return;
    }
    menuConfirm(
      "Undo a commit that is already on the remote? Your branch will " +
        "diverge from its upstream - pushing will then require a force-push.",
      onUndo,
    );
  };
  return (
    <MenuItem onClick={request}>
      {pushed ? "Undo last commit (keep changes staged)…" : "Undo last commit (keep changes staged)"}
    </MenuItem>
  );
}
