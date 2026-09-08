import { WatchOffIcon } from "../../icons";

/** Compact repo-tab indicator: the repo's filesystem watcher failed to start,
 * so live updates are off (data still refreshes on window focus and manual
 * actions). The reason shows on hover. Persistent by design - a toast at
 * startup would be missed, and the failure can outlive it (e.g. the OS watch
 * limit). Inherits `currentColor` like `HostBadge`. */
export function WatchOffBadge({ reason }: { reason: string }) {
  const label = `Live updates off - the file watcher failed to start: ${reason}. Data refreshes when the window regains focus.`;
  return (
    <span
      title={label}
      aria-label={label}
      style={{ flex: "none", display: "inline-flex", alignItems: "center" }}
    >
      <WatchOffIcon />
    </span>
  );
}
