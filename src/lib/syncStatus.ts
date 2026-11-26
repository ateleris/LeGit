import type { SyncStatusKind, SyncStatusPayload } from "./types";

/** One user-facing line per sync state (the section's status readout). */
export function syncStatusText(status: SyncStatusPayload | null): string {
  if (!status || status.kind === "disabled") return "Not configured";
  switch (status.kind) {
    case "inSync":
      return status.lastSync
        ? `In sync (last sync ${new Date(status.lastSync).toLocaleString()})`
        : "In sync";
    case "receiveOnly":
      return "Receiving only: another computer syncs with a newer LeGit";
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

/** The note for a sync repository holding a newer LeGit's settings, or null. */
export function newerVersionHint(status: SyncStatusPayload | null): string | null {
  const version = status?.newerAppVersion;
  if (!version) return null;
  return (
    `Another computer syncs with a newer LeGit (${version}). Until LeGit is updated here, this ` +
    "computer receives the synced settings it understands and sends none. Settings changed " +
    "here stay as they are on this computer and are shared once it is updated."
  );
}

/** The note for settings changed both here and on another computer while
 * this one could not send, or null. */
export function supersededNote(status: SyncStatusPayload | null): string | null {
  const names = status?.superseded ?? [];
  if (names.length === 0) return null;
  return (
    "Settings sync: these settings were changed here and on another computer; the other " +
    `computer's values were kept: ${names.join(", ")}`
  );
}
