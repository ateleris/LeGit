import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { onRepoChanged } from "./events";

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
      for (const domain of payload.domains) {
        // domain ∈ "status" | "log" | "branches" — matches the query-key suffixes.
        queryClient.invalidateQueries({ queryKey: [payload.repo_id, domain] });
      }
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
