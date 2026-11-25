import { useEffect, useState } from "react";
import { BUSY_DELAY_MS } from "../../lib/opActivity";

export { BUSY_DELAY_MS };

/**
 * True only once `active` has been continuously true for `delayMs`; false the
 * moment `active` drops. Backs every debounced busy indicator (PanelLoadingBar,
 * the Commits panel's "Loading more…" strip).
 */
export function useDelayedFlag(active: boolean, delayMs: number = BUSY_DELAY_MS): boolean {
  const [on, setOn] = useState(false);

  useEffect(() => {
    if (!active) {
      setOn(false);
      return;
    }
    const timer = window.setTimeout(() => setOn(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [active, delayMs]);

  return on;
}
