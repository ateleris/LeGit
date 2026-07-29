import { useConfirmDestructive } from "../../../store/settings";
import { useMenuConfirm } from "./PanelContextMenu";
import { MenuItem, Separator, Submenu } from "./primitives";
import type { ResetMode } from "../../../lib/types";

/**
 * "Reset to this commit" entries for a commit row's context menu, one per
 * mode. Hard reset discards uncommitted changes, so it confirms via the menu
 * takeover, gated by the global destructive-confirmation setting (soft and
 * mixed lose nothing — no confirm).
 */
export function ResetMenuItems({
  branch,
  onReset,
}: {
  /** Current branch name; null when HEAD is detached (reset still moves HEAD). */
  branch: string | null;
  onReset: (mode: ResetMode) => void;
}) {
  const confirmDestructive = useConfirmDestructive();
  const menuConfirm = useMenuConfirm();
  const label = branch ? `'${branch}'` : "HEAD";

  const requestHard = () => {
    if (!confirmDestructive) {
      onReset("hard");
      return;
    }
    menuConfirm(
      `Hard reset ${label} to this commit? Uncommitted changes will be discarded.`,
      () => onReset("hard"),
    );
  };

  return (
    <>
      <Separator />
      <Submenu label={`Reset ${label} to here`}>
        <MenuItem onClick={() => onReset("soft")}>
          Soft (keep changes staged)
        </MenuItem>
        <MenuItem onClick={() => onReset("mixed")}>
          Mixed (keep changes unstaged)
        </MenuItem>
        <MenuItem onClick={requestHard}>
          {confirmDestructive ? "Hard (discard changes)…" : "Hard (discard changes)"}
        </MenuItem>
      </Submenu>
    </>
  );
}
