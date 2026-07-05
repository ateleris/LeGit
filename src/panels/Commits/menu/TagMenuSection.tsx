import { useConfirmDestructive } from "../../../store/settings";
import { useMenuConfirm, useMenuPicker } from "./PanelContextMenu";
import { MenuItem, Separator, SectionLabel } from "./primitives";

/**
 * Shared context-menu section for a tag. Used by both the tag chip's menu and
 * the commit row's menu (Commits panel) so the two stay in parity. Delete is
 * destructive: gated by the global destructive-confirmation setting, with the
 * menu-takeover confirm step.
 *
 * `remote` is the default push target (`pickTagRemote`); when the repo has
 * more than one remote, extra "…to a chosen remote" entries open a picker
 * takeover so any remote can be targeted.
 */
export function TagMenuSection({
  name,
  pushed,
  targetOnRemote,
  remote,
  remotes,
  onPush,
  onDelete,
  onDeleteRemote,
}: {
  name: string;
  /** Tag exists on the remote with the same target (see `pushedTagNames`). */
  pushed: boolean;
  /** The tagged commit is on a remote; pushing a tag whose commit is not
   *  would upload unreferenced history, so the entry is disabled. */
  targetOnRemote: boolean;
  /** Default remote tags are pushed to, or null when no remote is configured. */
  remote: string | null;
  /** All configured remote names (picker entries appear when more than one). */
  remotes: string[];
  onPush: (remote: string) => void;
  onDelete: () => void;
  /** Delete the tag ON THE REMOTE (local tag untouched) — offered only while
   *  `pushed`, as a separate deliberate action (GitKraken-style). */
  onDeleteRemote: (remote: string) => void;
}) {
  const confirmDestructive = useConfirmDestructive();
  const menuConfirm = useMenuConfirm();
  const menuPicker = useMenuPicker();
  const multiRemote = remotes.length > 1;

  const requestDelete = () => {
    if (!confirmDestructive) {
      onDelete();
      return;
    }
    menuConfirm(`Delete tag '${name}'?`, onDelete);
  };

  const requestDeleteRemote = (target: string) => {
    if (!confirmDestructive) {
      onDeleteRemote(target);
      return;
    }
    menuConfirm(`Delete tag '${name}' from ${target}?`, () => onDeleteRemote(target));
  };

  return (
    <>
      <SectionLabel>{name}</SectionLabel>
      <MenuItem
        onClick={() => onPush(remote!)}
        disabled={pushed || remote === null || !targetOnRemote}
      >
        {pushed
          ? `Pushed to ${remote}`
          : remote === null
            ? "Push tag (no remote configured)"
            : targetOnRemote
              ? `Push tag to ${remote}`
              : "Push tag (commit not on remote)"}
      </MenuItem>
      {multiRemote && (
        <MenuItem
          onClick={() => menuPicker(`Push tag '${name}' to`, remotes, onPush)}
          disabled={!targetOnRemote}
        >
          Push tag to…
        </MenuItem>
      )}
      <Separator />
      <MenuItem onClick={requestDelete}>
        {confirmDestructive ? "Delete tag…" : "Delete tag"}
      </MenuItem>
      {pushed && remote !== null && (
        <MenuItem onClick={() => requestDeleteRemote(remote)}>
          {confirmDestructive ? `Delete tag from ${remote}…` : `Delete tag from ${remote}`}
        </MenuItem>
      )}
      {multiRemote && (
        <MenuItem
          onClick={() => menuPicker(`Delete tag '${name}' from`, remotes, requestDeleteRemote)}
        >
          Delete tag from…
        </MenuItem>
      )}
    </>
  );
}
