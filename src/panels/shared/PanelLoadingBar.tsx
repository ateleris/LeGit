/**
 * Thin indeterminate progress bar pinned to the top edge of the enclosing
 * `.legit-panel`. Signals background fetches/reloads without affecting layout
 * (absolutely positioned → no shift). Render as a direct child of a
 * `.legit-panel` root, passing the query's `isFetching`.
 */
export function PanelLoadingBar({ active }: { active: boolean }) {
  if (!active) return null;
  return <div className="legit-progress" aria-hidden="true" />;
}
