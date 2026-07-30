// Ref-row -> commit graph navigation (Refs panel sections: Branches, Tags,
// Stashes). Clicking a ref row's background points the commit-inspection
// panels at the ref's commit.

import { useSummonStore } from "../../store/summon";

/**
 * True when a click landed on a row's background (or plain text) rather than
 * on an interactive element inside it. Ref rows carry buttons, inline-edit
 * inputs and links whose clicks bubble to the row container; those must never
 * double as a "jump to commit" gesture.
 */
export function isRowBackgroundClick(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return true;
  return target.closest("button, input, textarea, select, a") === null;
}

/**
 * Point the commit-inspection panels at `commitId`: the Commits panel scrolls
 * to and selects it (a commit beyond the loaded window is selected without
 * scrolling - it highlights once "load more" reaches it), and Commit Details /
 * Changed Files follow so the open panels agree on the selection.
 *
 * Everything goes through `notifyIfOpen`: a row click is a navigation gesture,
 * so it must update already-open panels but never open or focus one (unlike
 * File History / Search row clicks, which deliberately summon Commit Details).
 */
export function jumpPanelsToCommit(commitId: string | null | undefined): void {
  if (!commitId) return;
  const store = useSummonStore.getState();
  store.notifyIfOpen("log", commitId);
  store.notifyIfOpen("commit-details", commitId);
  store.notifyIfOpen("changed-files", commitId);
}
