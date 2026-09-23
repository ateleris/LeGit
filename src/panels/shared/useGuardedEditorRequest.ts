import { useCallback, useEffect, useRef, useState } from "react";
import { usePanelViewState } from "../../store/panelViewState";
import { useRepoStore } from "../../store/repos";
import { useSummonTarget } from "../../store/summon";

/** A summoned switch must wait for the user when it would leave unsaved
 *  edits: any target other than the current one, including clearing (null). */
export function holdsSwitch<T>(
  dirty: boolean,
  next: T | null,
  current: T | null,
  sameTarget: (a: T | null, b: T | null) => boolean,
): boolean {
  return dirty && !sameTarget(next, current);
}

/**
 * The shown target of an editing panel (Diff, Merge) plus its unsaved-edits
 * guard: summons are held while dirty (`pending`, resolved by
 * `acceptPending` / `rejectPending`), edits and a pending switch are dropped
 * on a repo switch (they belong to the previous repo's file, untouched on
 * disk), and saves are guarded against re-entry.
 */
export function useGuardedEditorRequest<T>(opts: {
  panelId: string;
  /** `usePanelViewState` key: the target survives layout applies and slot swaps. */
  viewStateKey: string;
  sameTarget: (a: T | null, b: T | null) => boolean;
}) {
  const [request, setRequest] = usePanelViewState<T | null>(opts.viewStateKey, null);
  const [dirty, setDirty] = useState(false);
  // The inner req may itself be null ("clear the panel"), hence the wrapper.
  const [pending, setPending] = useState<{ req: T | null } | null>(null);
  // Forces an editor rebuild when refetched content is byte-identical (React
  // Query then keeps the same object, so nothing else changes).
  const [rebuildKey, setRebuildKey] = useState(0);
  // Mirrors so callbacks keep a stable identity: recreating the editor
  // mid-edit would discard the user's unsaved changes.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const requestRef = useRef(request);
  requestRef.current = request;
  const sameRef = useRef(opts.sameTarget);
  sameRef.current = opts.sameTarget;
  const savingRef = useRef(false);

  const onReceive = useCallback(
    (payload: T | null) => {
      if (holdsSwitch(dirtyRef.current, payload, requestRef.current, sameRef.current)) {
        setPending({ req: payload });
        return;
      }
      setRequest(payload);
    },
    [setRequest],
  );
  useSummonTarget<T | null>(opts.panelId, onReceive);

  const activeRepoId = useRepoStore((s) => s.activeRepoId);
  useEffect(() => {
    setDirty(false);
    setPending(null);
  }, [activeRepoId]);

  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const acceptPending = useCallback(() => {
    const p = pendingRef.current;
    if (!p) return;
    setDirty(false);
    setRequest(p.req);
    setPending(null);
  }, [setRequest]);
  const rejectPending = useCallback(() => setPending(null), []);
  const rebuild = useCallback(() => setRebuildKey((k) => k + 1), []);

  /** Run `save` unless one is already running. */
  const guardSave = useCallback(async (save: () => Promise<void>) => {
    if (savingRef.current) return;
    savingRef.current = true;
    try {
      await save();
    } finally {
      savingRef.current = false;
    }
  }, []);

  return {
    request,
    requestRef,
    dirty,
    dirtyRef,
    setDirty,
    pending,
    acceptPending,
    rejectPending,
    rebuildKey,
    rebuild,
    guardSave,
    activeRepoId,
  };
}
