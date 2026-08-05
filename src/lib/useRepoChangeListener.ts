import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { onRepoChanged } from "./events";
import { invalidateRepoDomains, withDerivedDomains } from "./repoInvalidation";
import { isWindowFocused } from "./windowFocus";
import { useGitLogStore } from "../store/gitLog";

/**
 * Subscribe to filesystem-watcher events and invalidate the affected react-query
 * caches for the repo that changed. Mount once near the app root.
 *
 * This is the primary refresh path (live updates without needing focus); the
 * window-focus refetch in `main.tsx` and per-panel focus effects stay as a
 * backstop. The payload carries its own `repo_id`, so we invalidate that repo
 * even when it isn't the active one (multiple repos can be open).
 */
export function useRepoChangeListener() {
  const queryClient = useQueryClient();
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    onRepoChanged((payload) => {
      // Every emitted batch lands in the Git Log panel (before coalescing, so
      // the diagnostic view shows what the watcher saw, not what survived
      // dedup) - this is how a refetch loop's trigger becomes visible.
      useGitLogStore.getState().addWatcherBatch(payload);
      // domains ∈ ChangeDomain (see types.ts) - matches the query-key suffixes.
      // Coalescing backstop: skip any domain a manual refresh (or an earlier
      // emission of this same change) already invalidated within the window, so
      // one action triggers one refetch. See repoInvalidation.ts.
      // Focus gate: while the window is unfocused, only mark caches stale
      // ("none") - background churn (builds, editors) must not trigger git
      // refetches nobody sees. The refetchOnWindowFocus catch-up (main.tsx,
      // driven by windowFocus.ts) refetches the stale queries on focus.
      invalidateRepoDomains(queryClient, payload.repo_id, withDerivedDomains(payload.domains), {
        coalesce: true,
        refetchType: isWindowFocused() ? "active" : "none",
      });
    }).then((fn) => {
      // The async listen() may resolve after unmount (StrictMode double-run).
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [queryClient]);
}
