import { useState } from "react";
import { MenuItem, Separator, SectionLabel } from "./primitives";

/**
 * Shared context-menu section for a local branch. Used by both the branch
 * chip's menu and the commit row's menu (Commits panel) so the two stay in
 * parity — in particular, Delete (destructive) is gated behind an inline
 * Confirm step in both places.
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
  const [confirming, setConfirming] = useState<"safe" | "force" | null>(null);

  if (confirming) {
    return (
      <>
        <SectionLabel>Delete branch '{name}'?</SectionLabel>
        <MenuItem
          onClick={() => {
            onDelete(confirming === "force");
            setConfirming(null);
          }}
        >
          Confirm
        </MenuItem>
        <MenuItem onClick={() => setConfirming(null)}>Cancel</MenuItem>
      </>
    );
  }

  return (
    <>
      <SectionLabel>{name}</SectionLabel>
      <MenuItem onClick={onCheckout} disabled={isCurrent}>
        {isCurrent ? "Checkout branch (current)" : "Checkout branch"}
      </MenuItem>
      <MenuItem onClick={onRename}>Rename branch…</MenuItem>
      <Separator />
      <MenuItem onClick={() => setConfirming("safe")}>Delete branch…</MenuItem>
      <MenuItem onClick={() => setConfirming("force")}>Force delete branch…</MenuItem>
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
