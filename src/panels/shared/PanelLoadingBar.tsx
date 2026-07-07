import { useDelayedFlag } from "./useDelayedFlag";

/**
 * Thin indeterminate progress bar pinned to the top edge of the enclosing
 * `.legit-panel`. Signals background fetches/reloads without affecting layout
 * (absolutely positioned → no shift). Render as a direct child of a
 * `.legit-panel` root, passing the query's `isFetching`.
 *
 * Appearance is debounced (`useDelayedFlag`): the bar only shows for fetches
 * that actually take a noticeable amount of time, so quick invalidation
 * round-trips don't flicker.
 */
export function PanelLoadingBar({ active }: { active: boolean }) {
  const visible = useDelayedFlag(active);
  if (!visible) return null;
  return <div className="legit-progress" aria-hidden="true" />;
}
