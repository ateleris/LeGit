import { useConfirmDestructive } from "../../../store/settings";
import { useMenuConfirm } from "./PanelContextMenu";
import { MenuItem, Separator } from "./primitives";
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
      <MenuItem onClick={() => onReset("soft")}>
        Reset {label} to here (soft — keep changes staged)
      </MenuItem>
      <MenuItem onClick={() => onReset("mixed")}>
        Reset {label} to here (mixed — keep changes unstaged)
      </MenuItem>
      <MenuItem onClick={requestHard}>
        {confirmDestructive
          ? `Reset ${label} to here (hard — discard changes)…`
          : `Reset ${label} to here (hard — discard changes)`}
      </MenuItem>
    </>
  );
}
