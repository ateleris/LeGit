import { useConfirmDestructive } from "../../../store/settings";
import { useMenuConfirm } from "./PanelContextMenu";
import { MenuItem, Separator, SectionLabel } from "./primitives";

/**
 * Shared context-menu section for a stash entry. Used by both the stash row's
 * menu and the stash chip's menu in the Commits panel so the two stay in
 * parity. Drop is destructive: gated by the global destructive-confirmation
 * setting, and when confirming, the confirmation takes over the whole menu
 * (no other entries to mis-click).
 *
 * `selector` is display-only (the section label); the action callbacks are
 * expected to address the stash by its commit SHA, wired by the caller.
 */
export function StashMenuSection({
  selector,
  onViewDiff,
  onApply,
  onPop,
  onRename,
  onDrop,
}: {
  selector: string;
  onViewDiff: () => void;
  onApply: () => void;
  onPop: () => void;
  onRename: () => void;
  onDrop: () => void;
}) {
  const confirmDestructive = useConfirmDestructive();
  const menuConfirm = useMenuConfirm();

  const requestDrop = () => {
    if (!confirmDestructive) {
      onDrop();
      return;
    }
    menuConfirm(`Drop ${selector}?`, onDrop);
  };

  return (
    <>
      <SectionLabel>{selector}</SectionLabel>
      <MenuItem onClick={onViewDiff}>View stash diff</MenuItem>
      <MenuItem onClick={onApply}>Apply stash</MenuItem>
      <MenuItem onClick={onPop}>Pop stash</MenuItem>
      <MenuItem onClick={onRename}>Rename stash…</MenuItem>
      <Separator />
      <MenuItem onClick={requestDrop}>
        {confirmDestructive ? "Drop stash…" : "Drop stash"}
      </MenuItem>
    </>
  );
}
