import { useEffect } from "react";
import { useSettingsStore } from "../store/settings";
import { notify, useNotificationsStore } from "../store/notifications";
import { useAppVersion } from "./appVersion";
import { checkForUpdate, promptAndInstall } from "./updateFlow";
import { formatAppError } from "./types";

/** Grace period before the check, so app startup (repo restore, first
 *  queries) never competes with an update HTTP request. */
const STARTUP_DELAY_MS = 5_000;

/** One check per app process - the hook must not re-check when its host
 *  remounts (e.g. a layout reset). */
let checkedThisSession = false;

/**
 * Quiet on-startup update check (Global Settings, default on). Check-only:
 * a found update surfaces as a sticky info toast; clicking it opens the
 * shared update prompt (release notes + install), with download progress
 * written back into one toast. Check FAILURES are silent by design - a
 * machine without network must not toast on every launch (the manual button
 * in About surfaces errors inline instead).
 */
export function useStartupUpdateCheck() {
  // `?? true` = on by default; null settings = not loaded yet (wait).
  const settingsLoaded = useSettingsStore((s) => s.settings !== null);
  const enabled = useSettingsStore((s) => s.settings?.check_updates_on_startup ?? true);
  const version = useAppVersion();

  useEffect(() => {
    if (!settingsLoaded || !enabled || checkedThisSession) return;
    const h = setTimeout(async () => {
      checkedThisSession = true;
      try {
        const update = await checkForUpdate();
        if (!update) return;
        notify.info(`LeGit v${update.version} is available - click to see what's new`, {
          sticky: true,
          action: () => {
            void (async () => {
              try {
                // Progress lives in one sticky toast, updated in place; the
                // final "installed" state stays until dismissed.
                let toastId: number | null = null;
                const progress = (text: string) => {
                  if (toastId === null) toastId = notify.info(text, { sticky: true });
                  else useNotificationsStore.getState().update(toastId, text);
                };
                const outcome = await promptAndInstall(update, version, progress);
                if (outcome === "installed") {
                  progress(`v${update.version} installed - restart to apply.`);
                }
              } catch (e) {
                notify.error(`Update failed: ${formatAppError(e)}`);
              }
            })();
          },
        });
      } catch (e) {
        // Expected offline / no published release / unsupported package
        // (.deb). Log only.
        console.warn("startup update check failed", e);
      }
    }, STARTUP_DELAY_MS);
    return () => clearTimeout(h);
  }, [settingsLoaded, enabled, version]);
}
