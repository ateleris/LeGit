import { useState } from "react";
import { MenuItem, Separator, SectionLabel } from "./primitives";

/**
 * Shared context-menu section for a stash entry. Used by both the stash row's
 * menu and the stash chip's menu in the Commits panel so the two stay in
 * parity — in particular, Drop (destructive, hard to undo) is gated behind an
 * inline Confirm step in both places.
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
  const [confirming, setConfirming] = useState(false);

  if (confirming) {
    return (
      <>
        <SectionLabel>Drop {selector}?</SectionLabel>
        <MenuItem onClick={() => { onDrop(); setConfirming(false); }}>Confirm</MenuItem>
        <MenuItem onClick={() => setConfirming(false)}>Cancel</MenuItem>
      </>
    );
  }

  return (
    <>
      <SectionLabel>{selector}</SectionLabel>
      <MenuItem onClick={onViewDiff}>View stash diff</MenuItem>
      <MenuItem onClick={onApply}>Apply stash</MenuItem>
      <MenuItem onClick={onPop}>Pop stash</MenuItem>
      <MenuItem onClick={onRename}>Rename stash…</MenuItem>
      <Separator />
      <MenuItem onClick={() => setConfirming(true)}>Drop stash…</MenuItem>
    </>
  );
}
