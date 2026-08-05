import { focusManager } from "@tanstack/react-query";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Drive react-query's focusManager from OS window focus (Tauri's
 * `onFocusChanged`) instead of the WebView's default visibilitychange signal:
 * a window sitting behind the user's editor is unfocused but still "visible",
 * so the default signal never fires on alt-tab and only on minimize.
 *
 * This single source powers both halves of the focus-gated refresh:
 * - `isWindowFocused()` gates watcher-driven refetches (useRepoChangeListener
 *   invalidates with `refetchType: "none"` while unfocused);
 * - the focus=true edge triggers react-query's refetchOnWindowFocus catch-up
 *   for everything that went stale in the background.
 *
 * Call once at startup (main.tsx).
 */
export function initWindowFocusTracking(): void {
  focusManager.setEventListener((setFocused) => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => setFocused(focused))
      .then((fn) => {
        // The async listen may resolve after focusManager swapped listeners.
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((e) => {
        console.warn("window focus tracking unavailable", e);
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  });
}

/** Whether the app window currently has OS focus. Defaults to true until the
 *  first focus event arrives. */
export function isWindowFocused(): boolean {
  return focusManager.isFocused();
}
