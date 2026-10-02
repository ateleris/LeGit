import type { SyncStatusKind, SyncStatusPayload } from "./types";

/** One user-facing line per sync state (the section's status readout). */
export function syncStatusText(status: SyncStatusPayload | null): string {
  if (!status || status.kind === "disabled") return "Not configured";
  switch (status.kind) {
    case "inSync":
      return status.lastSync
        ? `In sync (last sync ${new Date(status.lastSync).toLocaleString()})`
        : "In sync";
    case "ahead":
      return "Local changes not pushed yet";
    case "offline":
      return "Offline: will sync when the remote is reachable";
    case "conflict":
      return (
        status.message ?? "The sync repository has a merge conflict; resolve it, then sync again"
      );
    case "error":
      return status.message ? `Sync failed: ${status.message}` : "Sync failed";
  }
}

/** Toast once per state change into a loud state; quiet states and repeats
 *  never toast. */
export function shouldToastSyncStatus(
  prev: SyncStatusKind | null,
  next: SyncStatusKind,
): boolean {
  return (next === "conflict" || next === "error") && prev !== next;
}
