import { useCallback, useEffect, useState } from "react";
import { usePanelFocusEffect } from "../PanelApiContext";
import { WarningIcon } from "../../icons";
import { formatAppError } from "../../lib/types";
import type { GitProfile, KeyDiff, ProfileStatus } from "../../lib/types";
import {
  listGitProfiles,
  detectActiveProfileForRepo,
  previewApplyProfile,
  applyProfileToRepo,
  clearRepoProfile,
  createProfileFromRepo,
} from "../../lib/commands";
import { Button } from "../shared/buttons";
import { Section, FieldNote } from "./primitives";

const INHERIT = "__inherit__";

/**
 * Repo Settings section: select which global profile this repo uses. The active
 * profile is detected from the repo's live local config (not just the stored
 * selection), so it reports Active / Drift / Unmanaged / Inherit honestly.
 */
export function RepoProfileSection({ repoId }: { repoId: string }) {
  const [status, setStatus] = useState<ProfileStatus | null>(null);
  const [profiles, setProfiles] = useState<GitProfile[]>([]);
  const [pending, setPending] = useState<{ profileId: string; diffs: KeyDiff[] } | null>(null);
  const [clearPending, setClearPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [savingNew, setSavingNew] = useState(false);

  const load = useCallback(() => {
    setPending(null);
    setClearPending(false);
    Promise.all([detectActiveProfileForRepo(repoId), listGitProfiles()])
      .then(([s, p]) => { setStatus(s); setProfiles(p); })
      .catch((e) => setError(formatAppError(e)));
  }, [repoId]);

  useEffect(() => { load(); }, [load]);
  usePanelFocusEffect(load);

  if (!status) {
    return <Section title="Identity profile" scope="git"><span className="legit-subtle">Loading…</span></Section>;
  }

  const m = status.match;
  const activeId = m.kind === "active" || m.kind === "drift" ? m.profile_id : null;
  const profileName = (id: string) => profiles.find((p) => p.id === id)?.name ?? "(deleted profile)";

  const handleSelect = async (value: string) => {
    setError(null);
    if (value === INHERIT) {
      setPending(null);
      setClearPending(true);
      return;
    }
    // Preview the diff this profile would apply, then confirm.
    try {
      setBusy(true);
      const diffs = await previewApplyProfile(repoId, value);
      setClearPending(false);
      setPending({ profileId: value, diffs });
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setBusy(false);
    }
  };

  const confirmApply = async () => {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      const s = await applyProfileToRepo(repoId, pending.profileId);
      setStatus(s);
      setPending(null);
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setBusy(false);
    }
  };

  const confirmClear = async () => {
    setBusy(true);
    setError(null);
    try {
      const s = await clearRepoProfile(repoId);
      setStatus(s);
      setClearPending(false);
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setBusy(false);
    }
  };

  const saveAsProfile = async () => {
    if (newName.trim() === "") return;
    setSavingNew(true);
    setError(null);
    try {
      await createProfileFromRepo(repoId, newName.trim());
      setNewName("");
      load();
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setSavingNew(false);
    }
  };

  // Dropdown reflects the active profile when matched, else "none".
  const dropdownValue = pending ? pending.profileId : clearPending ? INHERIT : (activeId ?? INHERIT);

  return (
    <Section title="Identity profile" scope="git">
      <FieldNote>writes to: .git/config (this repo only)</FieldNote>

      <div style={{ marginTop: 8 }}>
        <StatusBadge status={status} profileName={profileName} />
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
        <span className="legit-subtle" style={{ fontSize: "var(--fz-md)" }}>Use profile:</span>
        <select value={dropdownValue} disabled={busy} onChange={(e) => handleSelect(e.target.value)}>
          <option value={INHERIT}>Use global config</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>{p.name || "(unnamed)"}</option>
          ))}
        </select>
      </div>

      {pending && (
        <ConfirmPanel
          title={`Apply profile "${profileName(pending.profileId)}" to this repo's .git/config?`}
          diffs={pending.diffs}
          note={
            m.kind === "unmanaged"
              ? "This repo has its own local identity that doesn't match any profile; applying will overwrite it."
              : "These writes affect only this repo's local config."
          }
          confirmLabel="Apply"
          busy={busy}
          onConfirm={confirmApply}
          onCancel={() => setPending(null)}
        />
      )}

      {clearPending && (
        <ConfirmPanel
          title="Clear this repo's profile?"
          diffs={[]}
          note="Unsets the profile's identity/signing/auth keys at local scope; the repo falls back to your global git identity."
          confirmLabel="Clear"
          busy={busy}
          onConfirm={confirmClear}
          onCancel={() => setClearPending(false)}
        />
      )}

      {m.kind === "unmanaged" && !pending && !clearPending && (
        <div style={{ marginTop: 12, padding: "10px 12px", background: "var(--button-hover-bg)", borderRadius: 4 }}>
          <div style={{ fontSize: "var(--fz-md)", marginBottom: 6 }}>
            This repo has a local identity that matches no profile. Save it as a profile?
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              style={{ flex: 1 }}
              value={newName}
              placeholder="New profile name"
              onChange={(e) => setNewName(e.target.value)}
            />
            <Button variant="primary" disabled={savingNew || newName.trim() === ""} onClick={saveAsProfile}>
              Save as profile
            </Button>
          </div>
        </div>
      )}

      {error && <pre className="legit-error" style={{ marginTop: 6 }}>{error}</pre>}
    </Section>
  );
}

function StatusBadge({
  status,
  profileName,
}: {
  status: ProfileStatus;
  profileName: (id: string) => string;
}) {
  const m = status.match;
  let color = "var(--subtle-fg)";
  let text = "Inherit (global identity)";
  if (m.kind === "active") {
    color = "var(--success-fg)";
    text = `Active: ${profileName(m.profile_id)}`;
  } else if (m.kind === "drift") {
    color = "var(--warning-fg)";
    text = `Drift from ${profileName(m.profile_id)} (${m.diffs.length} key${m.diffs.length === 1 ? "" : "s"} differ)`;
  } else if (m.kind === "unmanaged") {
    color = "var(--warning-fg)";
    text = "Unmanaged (local identity matches no profile)";
  }
  return (
    <div>
      <span style={{ color, fontWeight: 600 }}>{text}</span>
      {m.kind === "drift" && (
        <div style={{ marginTop: 6, fontSize: "var(--fz-sm)" }}>
          {m.diffs.map((d) => (
            <div key={d.key} style={{ fontFamily: "monospace" }}>
              <code>{d.key}</code>: <code>{d.local ?? "unset"}</code> → <code>{d.profile ?? "unset"}</code>
            </div>
          ))}
          <div className="legit-subtle" style={{ marginTop: 2 }}>
            Re-select the profile below to reset, or save current config as a new profile.
          </div>
        </div>
      )}
    </div>
  );
}

function ConfirmPanel({
  title,
  diffs,
  note,
  confirmLabel,
  busy,
  onConfirm,
  onCancel,
}: {
  title: string;
  diffs: KeyDiff[];
  note: string;
  confirmLabel: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div style={{ marginTop: 10, padding: "10px 12px", background: "var(--button-hover-bg)", border: "1px solid var(--panel-border)", borderRadius: 4 }}>
      <div style={{ fontWeight: 600, marginBottom: 6, display: "flex", alignItems: "center", gap: 6 }}>
        <WarningIcon /> {title}
      </div>
      {diffs.length > 0 && (
        <div style={{ marginBottom: 8, fontSize: "var(--fz-md)" }}>
          {diffs.map((d) => (
            <div key={d.key} style={{ fontFamily: "monospace" }}>
              <code>{d.key}</code>: <code>{d.local ?? "unset"}</code> → <code>{d.profile ?? "unset"}</code>
            </div>
          ))}
        </div>
      )}
      <div style={{ fontSize: "var(--fz-md)", color: "var(--subtle-fg)", marginBottom: 10 }}>{note}</div>
      <div style={{ display: "flex", gap: 6 }}>
        <Button variant="primary" onClick={onConfirm} disabled={busy}>{confirmLabel}</Button>
        <button onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </div>
  );
}
