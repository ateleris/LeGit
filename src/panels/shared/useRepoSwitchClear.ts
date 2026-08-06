import { useCallback, useEffect, useRef } from "react";
import { useRepoStore } from "../../store/repos";

/**
 * Clear panel-local selection state when the active repo changes - EXCEPT
 * when the current selection was summoned FOR the repo being switched to.
 *
 * A summon payload sent right after `openRepo` (e.g. "open submodule and
 * select the pointer commit", design/2026-08-06-submodule-open-at-commit.md)
 * is delivered synchronously, often before the receiving panel re-renders
 * for the new repo; a blind clear-on-repo-change would then clobber the
 * just-delivered selection back to null. Also deliberately NOT run on first
 * mount: under StrictMode the second effect pass would likewise clobber an
 * already-delivered payload (original rationale in ChangedFilesPanel).
 *
 * Returns `markDelivered`: call it whenever a summon payload is adopted. It
 * records the repo the payload targets (the active repo at delivery time -
 * `openRepo` sets it before resolving, so it is already the destination).
 * The marker is one-shot: it survives exactly one repo switch, the one it
 * was delivered for.
 */
export function useRepoSwitchClear(
  repoId: string | undefined,
  clear: () => void,
): () => void {
  const prev = useRef(repoId);
  const deliveredFor = useRef<string | null>(null);
  // Keep the latest clear callback without re-running the effect for it.
  const clearRef = useRef(clear);
  clearRef.current = clear;

  useEffect(() => {
    if (prev.current === repoId) return;
    prev.current = repoId;
    const keep = deliveredFor.current !== null && deliveredFor.current === repoId;
    deliveredFor.current = null;
    if (!keep) clearRef.current();
  }, [repoId]);

  return useCallback(() => {
    deliveredFor.current = useRepoStore.getState().activeRepoId;
  }, []);
}
