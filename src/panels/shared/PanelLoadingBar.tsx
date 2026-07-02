import { useEffect, useState } from "react";

/** Only show the bar once a fetch has been running this long — fast refetches
 * (e.g. re-reading status right after staging a file) finish well within this
 * window and would otherwise flash the bar for a single frame. */
const SHOW_DELAY_MS = 150;

/**
 * Thin indeterminate progress bar pinned to the top edge of the enclosing
 * `.legit-panel`. Signals background fetches/reloads without affecting layout
 * (absolutely positioned → no shift). Render as a direct child of a
 * `.legit-panel` root, passing the query's `isFetching`.
 *
 * Appearance is debounced: the bar only shows for fetches that actually take
 * a noticeable amount of time, so quick invalidation round-trips don't
 * flicker.
 */
export function PanelLoadingBar({ active }: { active: boolean }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!active) {
      setVisible(false);
      return;
    }
    const timer = window.setTimeout(() => setVisible(true), SHOW_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [active]);

  if (!visible) return null;
  return <div className="legit-progress" aria-hidden="true" />;
}
