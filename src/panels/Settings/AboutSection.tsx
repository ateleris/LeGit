import { useState } from "react";
import { checkForUpdate, promptAndInstall } from "../../lib/updateFlow";
import { useAppVersion, useAppVersionDisplay } from "../../lib/appVersion";
import { formatAppError } from "../../lib/errors";
import { api } from "../../lib/commands";
import { notify } from "../../store/notifications";
import { useSettingsStore } from "../../store/settings";
import { Button } from "../shared/buttons";
import { useDelayedBusy } from "../shared/useDelayedBusy";
import { Row, Section, SettingCheckbox } from "./primitives";

export function AboutSection() {
  const version = useAppVersion();
  const displayVersion = useAppVersionDisplay();
  const { busy, run } = useDelayedBusy();
  // Inline status next to the button (settings-form errors stay adjacent to
  // their input; only genuinely async surprises go to toasts).
  const [status, setStatus] = useState<{ error: boolean; text: string } | null>(null);

  const startupCheck = useSettingsStore((s) => s.settings?.check_updates_on_startup ?? true);
  const setCheckUpdatesOnStartup = useSettingsStore((s) => s.setCheckUpdatesOnStartup);

  const checkForUpdates = () =>
    void run(async () => {
      setStatus(null);
      try {
        const update = await checkForUpdate();
        if (!update) {
          setStatus({ error: false, text: "You are on the latest version." });
          return;
        }
        // Prompt + download + install + restart offer live in the shared
        // flow (also driven by the startup update toast).
        const outcome = await promptAndInstall(update, version, (text) =>
          setStatus({ error: false, text }),
        );
        setStatus({
          error: false,
          text:
            outcome === "declined"
              ? `v${update.version} is available - not installed.`
              : `v${update.version} installed - restart to apply.`,
        });
      } catch (e) {
        // Typical here: no network, no published release yet, or a .deb
        // install (the updater covers .msi/NSIS/.AppImage/.app only).
        setStatus({ error: true, text: `Update check failed: ${formatAppError(e)}` });
      }
    });

  return (
    <Section title="About">
      <Row label="LeGit" value={displayVersion ? `v${displayVersion}` : "…"} />
      <Row
        label="Logs"
        value={
          <div style={{ display: "flex", alignItems: "center", gap: "0.667em" }}>
            <Button
              onClick={() => api.openLogDir().catch((e) => notify.error(formatAppError(e)))}
              title="Open the folder holding LeGit's log files (attach the newest one to a bug report)"
            >
              Open log folder
            </Button>
          </div>
        }
      />
      <Row
        label="Updates"
        value={
          <div style={{ display: "flex", alignItems: "center", gap: "0.667em", minWidth: 0 }}>
            <Button onClick={checkForUpdates} disabled={busy}>
              {busy ? "Checking…" : "Check for updates"}
            </Button>
            {status && (
              <span
                style={{
                  fontSize: "var(--fz-sm)",
                  color: status.error ? "var(--status-deleted)" : "var(--subtle-fg)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {status.text}
              </span>
            )}
          </div>
        }
      />
      <SettingCheckbox
        id="global-check-updates-on-startup"
        label="Check for updates when LeGit starts"
        title="Check-only: an available update shows a toast; nothing downloads without your OK"
        checked={startupCheck}
        onChange={() => void setCheckUpdatesOnStartup(!startupCheck)}
      />
    </Section>
  );
}
