import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { formatAppError } from "../../lib/errors";
import { syncStatusText } from "../../lib/syncStatus";
import { confirmDialog } from "../../store/confirm";
import { notify } from "../../store/notifications";
import { useRepoStore } from "../../store/repos";
import { useSettingsStore } from "../../store/settings";
import { Button } from "../shared/buttons";
import { useDelayedBusy } from "../shared/useDelayedBusy";
import { FieldNote, Section, SettingCheckbox, WritesTo } from "./primitives";

export function SettingsSyncSection() {
  const syncPath = useSettingsStore((s) => s.settings?.settings_sync_path ?? null);
  const syncStatus = useSettingsStore((s) => s.syncStatus);
  const syncProfiles = useSettingsStore((s) => s.settings?.sync_git_profiles ?? false);
  const patchSettings = useSettingsStore((s) => s.patchSettings);
  const probeSyncPath = useSettingsStore((s) => s.probeSyncPath);
  const setSyncPath = useSettingsStore((s) => s.setSyncPath);
  const syncNow = useSettingsStore((s) => s.syncNow);
  const openRepo = useRepoStore((s) => s.openRepo);
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useDelayedBusy();

  const choose = async () => {
    setError(null);
    const selected = await openDialog({ directory: true, multiple: false });
    if (typeof selected !== "string") return;
    try {
      const probe = await probeSyncPath(selected);
      if (!probe.valid) {
        setError(probe.reason ?? "This folder cannot be used as a sync repository");
        return;
      }
      // Workflow prompt (direction of the first sync): always shown, not
      // gated by the destructive-confirmation setting.
      const confirmed = await confirmDialog({
        title: "Use this repository for settings sync?",
        message: probe.hasSyncDoc
          ? "This repository already contains synced settings. They will replace this machine's shareable preferences and themes."
          : "This machine's settings and themes will seed the repository.",
        detail: selected,
        confirmLabel: "Use this repository",
        danger: false,
      });
      if (!confirmed) return;
      await run(() => setSyncPath(selected));
    } catch (e) {
      setError(formatAppError(e));
    }
  };

  const act = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await run(action);
    } catch (e) {
      setError(formatAppError(e));
    }
  };

  return (
    <Section title="Settings sync">
      <WritesTo note="mirrors shareable settings and themes into a git repository" />
      {syncPath ? (
        <>
          <div style={{ marginTop: "0.667em", display: "flex", gap: "0.5em", alignItems: "baseline" }}>
            <span className="legit-subtle">Repository</span>
            <span style={{ fontFamily: "monospace" }}>{syncPath}</span>
          </div>
          <FieldNote>{syncStatusText(syncStatus)}</FieldNote>
          <div style={{ display: "flex", gap: "0.5em", marginTop: "0.667em" }}>
            <Button
              variant="primary"
              disabled={busy}
              title="Commits local changes, pulls the repository's settings, then pushes"
              onClick={() => act(syncNow)}
            >
              Sync now
            </Button>
            <button
              disabled={busy}
              onClick={() => openRepo(syncPath).catch((e) => notify.error(formatAppError(e)))}
            >
              Open sync repo in LeGit
            </button>
            <button disabled={busy} onClick={() => act(() => setSyncPath(null))}>
              Stop syncing
            </button>
          </div>
          <FieldNote>
            Sync runs both ways: local changes are committed and pushed, and
            changes from your other machines are pulled in at startup and on
            "Sync now".
          </FieldNote>
          <SettingCheckbox
            id="sync-git-profiles"
            label="Sync git profiles"
            checked={syncProfiles}
            disabled={busy}
            onChange={() =>
              act(() => patchSettings({ sync_git_profiles: !syncProfiles }))
            }
          />
          <FieldNote>
            Profiles sync by key file name; the SSH keys themselves never
            leave a machine. On a computer where a profile's key is missing,
            use "Create &amp; upload key" in Connected accounts to give it one
            there. Which repository uses which profile also syncs (by remote
            URL), so other computers suggest the right profile for the same
            clone. Enable this on every computer that should share profiles.
          </FieldNote>
        </>
      ) : (
        <>
          <FieldNote>
            Designate a local checkout of a git repository and LeGit keeps your
            shareable settings and themes in it: changes commit and push
            automatically, and other machines pointing at the same remote pick
            them up at startup.
          </FieldNote>
          <div style={{ marginTop: "0.667em" }}>
            <button disabled={busy} onClick={() => void choose()}>
              Choose repository…
            </button>
          </div>
        </>
      )}
      {error && <pre className="legit-error">{error}</pre>}
    </Section>
  );
}
