import { useEffect } from "react";
import { onWatchState } from "./events";
import { useRepoStore } from "../store/repos";

/**
 * Subscribe to watch-state events and patch the repo store, so a repo whose
 * filesystem watcher failed to start shows its "live updates off" tab badge.
 * Mount once near the app root.
 *
 * A failure during startup restore can be emitted before this listener
 * mounts; the backend therefore also carries the state on `RepoSummary`
 * (`watch_error`), and the store refresh after subscribing reconciles
 * anything missed.
 */
export function useWatchStateListener() {
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    onWatchState((payload) => {
      useRepoStore.getState().setWatchError(payload.repo_id, payload.error);
    }).then((fn) => {
      // The async listen() may resolve after unmount (StrictMode double-run).
      if (disposed) {
        fn();
        return;
      }
      unlisten = fn;
      // Catch-up: list_repos carries watch_error for failures emitted before
      // the subscription existed.
      useRepoStore
        .getState()
        .refresh()
        .catch((e) => console.warn("watch-state catch-up refresh failed", e));
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
