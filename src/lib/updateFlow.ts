import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { confirmDialog } from "../store/confirm";
import { releaseNotesFromBody } from "./releaseNotes";

/** Progress line sink ("Downloading… 42%", "Installing…"). */
export type UpdateProgress = (text: string) => void;

/** Re-exported so callers share one entry point (and one mock seam). */
export { check as checkForUpdate };

/**
 * The shared update-prompt half of the flow, used by both the manual
 * "Check for updates" button and the startup update toast: ask (showing the
 * release notes from the updater manifest), download + install with
 * progress, then offer a restart.
 *
 * Returns "declined" when the user passes on the update, "installed" when
 * it is installed but the restart was postponed (a confirmed restart
 * relaunches the app). Download/install errors throw - surfacing them
 * belongs to the caller (inline status vs toast).
 */
export async function promptAndInstall(
  update: Update,
  currentVersion: string | null,
  onProgress: UpdateProgress,
): Promise<"declined" | "installed"> {
  // Workflow prompt (decision after an async step): always shown,
  // deliberately NOT gated by the destructive-confirmation setting.
  const install = await confirmDialog({
    title: "Update available",
    message: `LeGit v${update.version} is available (you have v${currentVersion ?? "?"}). Download and install it now?`,
    notes: releaseNotesFromBody(update.body) ?? undefined,
    confirmLabel: "Download & install",
    danger: false,
  });
  if (!install) return "declined";

  let total = 0;
  let received = 0;
  await update.downloadAndInstall((e) => {
    if (e.event === "Started") {
      total = e.data.contentLength ?? 0;
      onProgress("Downloading…");
    } else if (e.event === "Progress") {
      received += e.data.chunkLength;
      if (total > 0) {
        onProgress(`Downloading… ${Math.round((received / total) * 100)}%`);
      }
    } else if (e.event === "Finished") {
      onProgress("Installing…");
    }
  });

  const restart = await confirmDialog({
    title: "Restart LeGit",
    message: `LeGit v${update.version} is installed. Restart now to apply it?`,
    confirmLabel: "Restart now",
    cancelLabel: "Later",
    danger: false,
  });
  if (restart) await relaunch();
  return "installed";
}
