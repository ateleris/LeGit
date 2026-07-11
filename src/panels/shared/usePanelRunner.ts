// The canonical panel action runner (see CLAUDE.md "Busy/loading feedback is
// delayed, never instant"): a re-entry guard blocks double-clicks IMMEDIATELY,
// while the visual busy state appears only after `delayMs` (default 150ms) so
// fast operations never flicker the UI. Extracted from WorkingChangesPanel's
// run() so the guarantee cannot drift between panels - every mutating panel
// action goes through this hook.

import { useCallback, useRef, useState } from "react";

export interface PanelRunnerOptions {
  /** Receives the raw error - `notify.error(formatAppError(e))`, `setError`, ... */
  onError: (e: unknown) => void;
  /** Runs after a successful action (refresh / invalidate domains). */
  onSuccess?: () => void;
  /** Runs after EVERY attempt, success or failure (invalidate-always). */
  onSettled?: () => void;
  /** Runs before each attempt (clear a previous error banner). */
  onStart?: () => void;
  /** Gate: when false, `run` is a no-op returning false (no repo open). */
  enabled?: boolean;
  /** Delay before the busy state shows. Default 150ms; pass 0 ONLY for
   * genuinely slow network ops (fetch/pull/push/clone), which may show busy
   * immediately per convention. */
  delayMs?: number;
  /** Keep busy=true and the guard HELD after a successful run: for actions
   * whose success is about to unmount/replace the surface (OpStateStrip's
   * continue/abort) - re-enabling before the refreshed state arrives reads
   * as "the action didn't work". Call the returned `release()` when the
   * surface stays mounted with new state. */
  holdBusyOnSuccess?: boolean;
}

export function usePanelRunner(opts: PanelRunnerOptions) {
  const [busy, setBusy] = useState(false);
  const runningRef = useRef(false);
  // Latest-ref pattern: `run` stays referentially stable across renders while
  // always seeing the current callbacks/options.
  const optsRef = useRef(opts);
  optsRef.current = opts;

  /** Run one mutating action. Resolves true on success, false on failure or
   * when skipped (disabled / already running). */
  const run = useCallback(async (fn: () => Promise<unknown>): Promise<boolean> => {
    if (!(optsRef.current.enabled ?? true) || runningRef.current) return false;
    runningRef.current = true;
    optsRef.current.onStart?.();
    const delay = optsRef.current.delayMs ?? 150;
    const busyTimer = window.setTimeout(() => setBusy(true), delay);
    let ok = false;
    try {
      await fn();
      ok = true;
      optsRef.current.onSuccess?.();
    } catch (e) {
      optsRef.current.onError(e);
    } finally {
      window.clearTimeout(busyTimer);
      optsRef.current.onSettled?.();
      if (ok && optsRef.current.holdBusyOnSuccess) {
        // Deliberately keep runningRef held too - release() re-enables.
        setBusy(true);
      } else {
        runningRef.current = false;
        setBusy(false);
      }
    }
    return ok;
  }, []);

  /** Re-enable after a `holdBusyOnSuccess` run (new state arrived, surface
   * stays mounted). */
  const release = useCallback(() => {
    runningRef.current = false;
    setBusy(false);
  }, []);

  return { busy, run, release };
}
