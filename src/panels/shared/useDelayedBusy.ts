// The shared delayed-busy hook for form/settings actions (CLAUDE.md
// "Busy/loading feedback is delayed, never instant"): a ref guard blocks
// re-entry IMMEDIATELY, while the visual `busy` flag appears only after
// `delayMs` (default 150ms) so fast operations never flicker their
// disabled/spinner state. The timer is always cleared in `finally`.
//
// Sibling of usePanelRunner, which is the canonical runner for mutating
// PANEL actions (onError/onSuccess/onSettled callbacks, toast wiring).
// useDelayedBusy is the minimal variant for settings forms and small tools
// whose errors render inline next to the input and whose success handling
// is inline in the action itself: it wraps the existing control flow
// without restructuring it. Errors propagate to the caller, exactly like
// the hand-rolled `try { ... } finally { setSaving(false) }` blocks it
// replaces - catch inside `fn` when the error should land in local state.

import { useCallback, useRef, useState } from "react";
import { BUSY_DELAY_MS } from "./useDelayedFlag";

export function useDelayedBusy(delayMs: number = BUSY_DELAY_MS) {
  const runningRef = useRef(false);
  const [busy, setBusy] = useState(false);

  /** Run one action. A call while another is still running is a no-op
   *  (the guard engages immediately, even though `busy` is delayed). */
  const run = useCallback(
    async (fn: () => Promise<unknown> | unknown): Promise<void> => {
      if (runningRef.current) return;
      runningRef.current = true;
      const timer = window.setTimeout(() => setBusy(true), delayMs);
      try {
        await fn();
      } finally {
        window.clearTimeout(timer);
        setBusy(false);
        runningRef.current = false;
      }
    },
    [delayMs],
  );

  return { busy, run };
}
