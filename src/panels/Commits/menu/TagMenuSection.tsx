import { useConfirmDestructive } from "../../../store/settings";
import { useMenuConfirm } from "./PanelContextMenu";
import { MenuItem, Separator, SectionLabel } from "./primitives";

/**
 * Shared context-menu section for a tag. Used by both the tag chip's menu and
 * the commit row's menu (Commits panel) so the two stay in parity. Delete is
 * destructive: gated by the global destructive-confirmation setting, with the
 * menu-takeover confirm step.
 */
export function TagMenuSection({
  name,
  pushed,
  remote,
  onPush,
  onDelete,
  onDeleteRemote,
}: {
  name: string;
  /** Tag exists on the remote with the same target (see `pushedTagNames`). */
  pushed: boolean;
  /** Remote tags are pushed to, or null when no remote is configured. */
  remote: string | null;
  onPush: () => void;
  onDelete: () => void;
  /** Delete the tag ON THE REMOTE (local tag untouched) — offered only while
   *  `pushed`, as a separate deliberate action (GitKraken-style). */
  onDeleteRemote: () => void;
}) {
  const confirmDestructive = useConfirmDestructive();
  const menuConfirm = useMenuConfirm();

  const requestDelete = () => {
    if (!confirmDestructive) {
      onDelete();
      return;
    }
    menuConfirm(`Delete tag '${name}'?`, onDelete);
  };

  const requestDeleteRemote = () => {
    if (!confirmDestructive) {
      onDeleteRemote();
      return;
    }
    menuConfirm(`Delete tag '${name}' from ${remote}?`, onDeleteRemote);
  };

  return (
    <>
      <SectionLabel>{name}</SectionLabel>
      <MenuItem onClick={onPush} disabled={pushed || remote === null}>
        {pushed
          ? `Pushed to ${remote}`
          : remote
            ? `Push tag to ${remote}`
            : "Push tag (no remote configured)"}
      </MenuItem>
      <Separator />
      <MenuItem onClick={requestDelete}>
        {confirmDestructive ? "Delete tag…" : "Delete tag"}
      </MenuItem>
      {pushed && remote !== null && (
        <MenuItem onClick={requestDeleteRemote}>
          {confirmDestructive ? `Delete tag from ${remote}…` : `Delete tag from ${remote}`}
        </MenuItem>
      )}
    </>
  );
}
