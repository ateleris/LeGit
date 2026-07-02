import { useConfirmDestructive } from "../../../store/settings";
import { useMenuConfirm } from "./PanelContextMenu";
import { MenuItem, Separator, SectionLabel } from "./primitives";

/**
 * Shared context-menu section for a local branch. Used by both the branch
 * chip's menu and the commit row's menu (Commits panel) so the two stay in
 * parity. Delete is destructive: gated by the global destructive-confirmation
 * setting, and when confirming, the confirmation takes over the whole menu
 * (no other entries to mis-click).
 */
export function BranchMenuSection({
  name,
  isCurrent,
  onCheckout,
  onRename,
  onDelete,
}: {
  name: string;
  isCurrent: boolean;
  onCheckout: () => void;
  onRename: () => void;
  onDelete: (force: boolean) => void;
}) {
  const confirmDestructive = useConfirmDestructive();
  const menuConfirm = useMenuConfirm();

  const requestDelete = (force: boolean) => {
    if (!confirmDestructive) {
      onDelete(force);
      return;
    }
    menuConfirm(
      force ? `Force delete branch '${name}'?` : `Delete branch '${name}'?`,
      () => onDelete(force),
    );
  };

  return (
    <>
      <SectionLabel>{name}</SectionLabel>
      <MenuItem onClick={onCheckout} disabled={isCurrent}>
        {isCurrent ? "Checkout branch (current)" : "Checkout branch"}
      </MenuItem>
      <MenuItem onClick={onRename}>Rename branch…</MenuItem>
      <Separator />
      <MenuItem onClick={() => requestDelete(false)}>
        {confirmDestructive ? "Delete branch…" : "Delete branch"}
      </MenuItem>
      <MenuItem onClick={() => requestDelete(true)}>
        {confirmDestructive ? "Force delete branch…" : "Force delete branch"}
      </MenuItem>
    </>
  );
}

/** Shared context-menu section for a remote-tracking branch. */
export function RemoteBranchMenuSection({
  remoteName,
  onCheckout,
}: {
  remoteName: string;
  onCheckout: () => void;
}) {
  return (
    <>
      <SectionLabel>{remoteName}</SectionLabel>
      <MenuItem onClick={onCheckout}>Checkout branch</MenuItem>
    </>
  );
}
