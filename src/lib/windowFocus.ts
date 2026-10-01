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
 * That made the Tauri event stream a single point of failure: one lost
 * `focused: true` event wedged the app "unfocused" until restart - watcher
 * invalidations stopped refetching AND the focus catch-up never ran, while
 * in-app actions kept working (live updates looked selectively dead). The
 * DOM recovery signals below fix that: each one is proof the window has
 * focus again, so they only ever correct TOWARD focused - Tauri stays the
 * sole source of "unfocused".
 *
 * Call once at startup (main.tsx).
 */
export function initWindowFocusTracking(): void {
  focusManager.setEventListener((setFocused) => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    try {
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
    } catch (e) {
      console.warn("window focus tracking unavailable", e);
    }

    const recover = () => {
      if (!focusManager.isFocused()) setFocused(true);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible" && document.hasFocus()) recover();
    };
    // Interacting with the app, the window gaining DOM focus, or becoming
    // visible while holding focus (restore from minimize) all prove focus.
    window.addEventListener("focus", recover);
    window.addEventListener("pointerdown", recover, true);
    window.addEventListener("keydown", recover, true);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      disposed = true;
      unlisten?.();
      window.removeEventListener("focus", recover);
      window.removeEventListener("pointerdown", recover, true);
      window.removeEventListener("keydown", recover, true);
      document.removeEventListener("visibilitychange", onVisible);
    };
  });
}

/** Whether the app window currently has OS focus. Defaults to true until the
 *  first focus event arrives. */
export function isWindowFocused(): boolean {
  return focusManager.isFocused();
}
