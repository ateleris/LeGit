import { useConfirmDestructive } from "../../../store/settings";
import { useMenuConfirm } from "./PanelContextMenu";
import { MenuItem, Separator, SectionLabel, Submenu } from "./primitives";
import type { MergeOptions } from "../../../lib/types";

/** Short display/command form of an upstream ref: `refs/remotes/origin/dev`
 *  and `origin/dev` both become `origin/dev`. */
function shortUpstream(upstream: string | null): string | null {
  return upstream?.replace(/^refs\/remotes\//, "") ?? null;
}

/**
 * Merge/rebase entries for a target branch (local or remote-tracking),
 * shared by both sections so the two menus cannot drift. Hidden when the
 * target IS the current branch, when HEAD is detached (no current branch),
 * or while a merge/rebase is already in progress.
 */
function MergeRebaseItems({
  targetLabel,
  currentBranch,
  opInProgress,
  isCurrent,
  onMerge,
  onRebaseOnto,
}: {
  targetLabel: string;
  currentBranch: string | null;
  opInProgress: boolean;
  isCurrent: boolean;
  onMerge: (options: MergeOptions) => void;
  onRebaseOnto: () => void;
}) {
  if (isCurrent || !currentBranch || opInProgress) return null;
  return (
    <>
      <Separator />
      <Submenu testId="menu-merge-submenu" label={`Merge '${targetLabel}' into '${currentBranch}'`}>
        <MenuItem testId="menu-merge" onClick={() => onMerge({ ff: "auto", squash: false })}>
          Merge (fast-forward if possible)
        </MenuItem>
        <MenuItem onClick={() => onMerge({ ff: "no_ff", squash: false })}>
          Merge (no fast-forward)
        </MenuItem>
        <MenuItem onClick={() => onMerge({ ff: "ff_only", squash: false })}>
          Merge (fast-forward only)
        </MenuItem>
        <MenuItem onClick={() => onMerge({ ff: "auto", squash: true })}>
          Squash merge
        </MenuItem>
      </Submenu>
      <MenuItem onClick={onRebaseOnto}>
        Rebase '{currentBranch}' onto '{targetLabel}'
      </MenuItem>
    </>
  );
}

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
  currentBranch,
  opInProgress,
  upstream,
  upstreamCandidates,
  onCheckout,
  onRename,
  onSetUpstream,
  onDelete,
  onMerge,
  onRebaseOnto,
}: {
  name: string;
  isCurrent: boolean;
  currentBranch: string | null;
  opInProgress: boolean;
  /** The branch's current upstream (full or short ref), null when untracked. */
  upstream: string | null;
  /** Existing remote-tracking branches this branch could track (short names,
   *  e.g. "origin/feature") — same-name candidates computed by the caller. */
  upstreamCandidates: string[];
  onCheckout: () => void;
  onRename: () => void;
  /** Set (short remote ref) or clear (null) the branch's upstream. */
  onSetUpstream: (upstream: string | null) => void;
  onDelete: (force: boolean) => void;
  onMerge: (options: MergeOptions) => void;
  onRebaseOnto: () => void;
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
      {/* Upstream (tracking) management: offer the existing same-name
          remote-tracking branches as targets; git requires the remote ref to
          already exist, so free-form input would only add failure modes. */}
      {upstreamCandidates
        .filter((c) => shortUpstream(upstream) !== c)
        .map((c) => (
          <MenuItem key={c} onClick={() => onSetUpstream(c)}>
            Set upstream to '{c}'
          </MenuItem>
        ))}
      {upstream && (
        <MenuItem onClick={() => onSetUpstream(null)}>
          Unset upstream ('{shortUpstream(upstream)}')
        </MenuItem>
      )}
      <MergeRebaseItems
        targetLabel={name}
        currentBranch={currentBranch}
        opInProgress={opInProgress}
        isCurrent={isCurrent}
        onMerge={onMerge}
        onRebaseOnto={onRebaseOnto}
      />
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

/** Shared context-menu section for a remote-tracking branch. Merge/rebase
 *  target the remote ref directly (rebasing onto 'origin/main' is the most
 *  common rebase there is). */
export function RemoteBranchMenuSection({
  remoteName,
  currentBranch,
  opInProgress,
  onCheckout,
  onMerge,
  onRebaseOnto,
  onDeleteRemote,
}: {
  remoteName: string;
  currentBranch: string | null;
  opInProgress: boolean;
  onCheckout: () => void;
  onMerge: (options: MergeOptions) => void;
  onRebaseOnto: () => void;
  /** Delete the branch ON THE REMOTE (`git push --delete`); any local
   *  counterpart is untouched — like remote tag deletion, a separate,
   *  deliberate action. */
  onDeleteRemote: () => void;
}) {
  const confirmDestructive = useConfirmDestructive();
  const menuConfirm = useMenuConfirm();

  const requestDeleteRemote = () => {
    if (!confirmDestructive) {
      onDeleteRemote();
      return;
    }
    menuConfirm(`Delete remote branch '${remoteName}'?`, onDeleteRemote);
  };

  return (
    <>
      <SectionLabel>{remoteName}</SectionLabel>
      <MenuItem onClick={onCheckout}>Checkout branch</MenuItem>
      <MergeRebaseItems
        targetLabel={remoteName}
        currentBranch={currentBranch}
        opInProgress={opInProgress}
        isCurrent={false}
        onMerge={onMerge}
        onRebaseOnto={onRebaseOnto}
      />
      <MenuItem onClick={requestDeleteRemote}>
        {confirmDestructive ? "Delete on remote…" : "Delete on remote"}
      </MenuItem>
    </>
  );
}
