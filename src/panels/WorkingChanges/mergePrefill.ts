import { useCommitDraftStore } from "../../store/commitDraft";

/** What the merge-state change does to the commit draft. */
export type MergePrefillEffect =
  | { kind: "prefill"; message: string }
  | { kind: "clear" }
  | { kind: "none" };

/**
 * While a merge is in progress, the commit box is prefilled with git's
 * prepared merge message (MERGE_MSG) so concluding the merge from the
 * composer keeps the standard message. The prefill only ever lands in an
 * empty box, and an untouched prefill is cleared when the merge ends some
 * other way (Continue in the banner, abort). `lastPrefill` is what this
 * mechanism last wrote for the repo: a draft differing from it was typed by
 * the user and is never touched, and a box the user emptied mid-merge is not
 * refilled.
 */
export function mergePrefillEffect(
  mergeMessage: string | null,
  draft: string,
  lastPrefill: string | null,
): MergePrefillEffect {
  if (mergeMessage !== null) {
    if (draft.trim().length === 0 && lastPrefill !== mergeMessage) {
      return { kind: "prefill", message: mergeMessage };
    }
    return { kind: "none" };
  }
  if (lastPrefill !== null && draft === lastPrefill) return { kind: "clear" };
  return { kind: "none" };
}

// Module-level so the tracking survives the composer unmounting (the panel
// shares a dock slot); in-session only, like the draft store itself.
const lastPrefillByRepo = new Map<string, string>();

/** Applies `mergePrefillEffect` to the draft store for one repo. */
export function applyMergePrefill(repoId: string, mergeMessage: string | null): void {
  const store = useCommitDraftStore.getState();
  const draft = store.drafts[repoId] ?? "";
  const effect = mergePrefillEffect(mergeMessage, draft, lastPrefillByRepo.get(repoId) ?? null);
  if (effect.kind === "prefill") {
    store.setDraft(repoId, effect.message);
    lastPrefillByRepo.set(repoId, effect.message);
  } else if (effect.kind === "clear") {
    store.clearDraft(repoId);
    lastPrefillByRepo.delete(repoId);
  } else if (mergeMessage === null) {
    lastPrefillByRepo.delete(repoId);
  }
}
