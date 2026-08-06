// The ONE repo-scope section for identity/signing/credentials, with three
// mutually exclusive, DETECTION-DRIVEN modes (spec:
// docs/superpowers/specs/2026-07-21-repo-identity-modes-design.md):
//   Global (inherit) - no local managed keys; collapsed read-only summary.
//   Profile          - local config exactly matches a profile; summary.
//   Custom           - local config matches no profile; combined editor.
// There is no drift state: config that matches no profile IS custom.
// Selecting Custom is pure UI (editor opens prefilled, nothing written);
// detection flips once a save diverges from every profile.

import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { usePanelFocusEffect } from "../PanelApiContext";
import { WarningIcon } from "../../icons";
import { formatAppError } from "../../lib/types";
import type { KeyDiff, ManagedConfigView, ProfileStatus, ResolvedIdentity } from "../../lib/types";
import {
  detectActiveProfileForRepo,
  previewApplyProfile,
  applyProfileToRepo,
  clearRepoProfile,
  createProfileFromRepo,
  repoResolvedIdentity,
  repoManagedConfigView,
} from "../../lib/commands";
import { useGitProfiles, invalidateGitProfiles } from "../../lib/useGitProfiles";
import { Button } from "../shared/buttons";
import { useDelayedBusy } from "../shared/useDelayedBusy";
import { Section, FieldNote } from "./primitives";
import { EffectiveValuesSummary } from "./EffectiveValuesSummary";
import { CustomConfigEditor } from "./CustomConfigEditor";
import { INHERIT_VALUE, CUSTOM_VALUE, dropdownValueFromMatch, profileValues } from "./identityMode";

const TITLE = "Identity, signing & credentials (this repo)";

export function RepoIdentitySection({ repoId, repoName }: { repoId: string; repoName: string }) {
  const queryClient = useQueryClient();
  const profilesQuery = useGitProfiles();
  const profiles = profilesQuery.data ?? [];

  const [status, setStatus] = useState<ProfileStatus | null>(null);
  const [view, setView] = useState<ManagedConfigView | null>(null);
  const [resolvedIdentity, setResolvedIdentity] = useState<ResolvedIdentity | null>(null);
  const [pending, setPending] = useState<{ profileId: string; diffs: KeyDiff[] } | null>(null);
  const [clearPending, setClearPending] = useState(false);
  const [customPicked, setCustomPicked] = useState(false);
  const { busy, run } = useDelayedBusy();
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const { busy: savingNew, run: runSaveNew } = useDelayedBusy();

  const load = useCallback(() => {
    setPending(null);
    setClearPending(false);
    Promise.all([
      detectActiveProfileForRepo(repoId),
      repoResolvedIdentity(repoId),
      repoManagedConfigView(repoId),
    ])
      .then(([s, r, v]) => { setStatus(s); setResolvedIdentity(r); setView(v); })
      .catch((e) => setError(formatAppError(e)));
  }, [repoId]);

  useEffect(() => { setCustomPicked(false); }, [repoId]);

  // Reload when the shared profile list actually changes (create/delete in
  // any panel): the detected mode depends on the profile set. Depend on
  // `profilesQuery.data` (structurally shared), never on a `?? []` fallback.
  useEffect(() => { load(); }, [load, profilesQuery.data]);

  const { refetch: refetchProfiles } = profilesQuery;
  usePanelFocusEffect(useCallback(() => {
    void refetchProfiles();
    load();
  }, [refetchProfiles, load]));

  /** Refresh status + config view after a mutation, without a full reload. */
  const applyResult = useCallback((s: ProfileStatus) => {
    setStatus(s);
    repoManagedConfigView(repoId).then(setView).catch((e) => setError(formatAppError(e)));
  }, [repoId]);

  if (!status || !view) {
    return <Section title={TITLE} scope="git"><span className="legit-subtle">Loading…</span></Section>;
  }

  const m = status.match;
  const showCustom = (m.kind === "custom" || customPicked) && !pending && !clearPending;
  const dropdown = pending
    ? pending.profileId
    : clearPending
      ? INHERIT_VALUE
      : customPicked
        ? CUSTOM_VALUE
        : dropdownValueFromMatch(m);
  const profileName = (id: string) => profiles.find((p) => p.id === id)?.name ?? "(deleted profile)";
  const activeProfile = m.kind === "active" ? (profiles.find((p) => p.id === m.profile_id) ?? null) : null;

  const handleSelect = async (value: string) => {
    setError(null);
    if (value === CUSTOM_VALUE) {
      // Pure UI: open the editor prefilled; nothing is written or stored.
      setPending(null);
      setClearPending(false);
      setCustomPicked(true);
      return;
    }
    setCustomPicked(false);
    if (value === INHERIT_VALUE) {
      setPending(null);
      setClearPending(m.kind !== "inherit"); // re-selecting the current mode is a no-op
      return;
    }
    return run(async () => {
      try {
        const diffs = await previewApplyProfile(repoId, value);
        setClearPending(false);
        setPending({ profileId: value, diffs });
      } catch (e) {
        setError(formatAppError(e));
      }
    });
  };

  const confirmApply = () => {
    if (!pending) return;
    return run(async () => {
      setError(null);
      try {
        const s = await applyProfileToRepo(repoId, pending.profileId);
        applyResult(s);
        setPending(null);
      } catch (e) {
        setError(formatAppError(e));
      }
    });
  };

  const confirmClear = () =>
    run(async () => {
      setError(null);
      try {
        const s = await clearRepoProfile(repoId);
        applyResult(s);
        setClearPending(false);
      } catch (e) {
        setError(formatAppError(e));
      }
    });

  const saveAsProfile = () => {
    if (newName.trim() === "") return;
    return runSaveNew(async () => {
      setError(null);
      try {
        await createProfileFromRepo(repoId, newName.trim());
        setNewName("");
        setCustomPicked(false);
        // List invalidation refetches the shared query; the effect above then
        // re-detects (now Active on the new profile).
        invalidateGitProfiles(queryClient);
      } catch (e) {
        setError(formatAppError(e));
      }
    });
  };

  return (
    <Section title={TITLE} scope="git">
      <FieldNote>writes to: .git/config (this repo only)</FieldNote>

      <div style={{ marginTop: 8 }}>
        <StatusBadge match={m} profileName={profileName} />
        {m.kind === "inherit" && <InheritedIdentityNote identity={resolvedIdentity} />}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
        <span className="legit-subtle" style={{ fontSize: "var(--fz-md)" }}>Source:</span>
        {/* data-testid is a contract with e2e/specs/profiles.spec.ts */}
        <select data-testid="repo-profile-select" value={dropdown} disabled={busy} onChange={(e) => handleSelect(e.target.value)}>
          <option value={INHERIT_VALUE}>Use global config</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>{p.name || "(unnamed)"}</option>
          ))}
          <option value={CUSTOM_VALUE}>Custom (this repo)</option>
        </select>
      </div>

      {pending && (
        <ConfirmPanel
          title={`Apply profile "${profileName(pending.profileId)}" to this repo's .git/config?`}
          diffs={pending.diffs}
          note={
            m.kind === "custom"
              ? "This repo has its own local config; applying will overwrite it."
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
          title="Use the global config for this repo?"
          diffs={[]}
          note="Unsets all identity/signing/auth keys at local scope; the repo falls back to your global git config."
          confirmLabel="Clear local config"
          busy={busy}
          onConfirm={confirmClear}
          onCancel={() => setClearPending(false)}
        />
      )}

      {!showCustom && !pending && !clearPending && m.kind === "active" && activeProfile && (
        <EffectiveValuesSummary values={profileValues(activeProfile)} />
      )}
      {!showCustom && !pending && !clearPending && m.kind === "inherit" && (
        <EffectiveValuesSummary values={view.inherited} />
      )}

      {showCustom && (
        <>
          <CustomConfigEditor
            key={repoId}
            repoId={repoId}
            repoName={repoName}
            local={view.local}
            inherited={view.inherited}
            onSaved={(s) => { applyResult(s); setCustomPicked(false); }}
          />
          <div style={{ marginTop: 10, padding: "10px 12px", background: "var(--button-hover-bg)", borderRadius: 4 }}>
            <div style={{ fontSize: "var(--fz-md)", marginBottom: 6 }}>
              Save this repo's config as a reusable profile?
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
        </>
      )}

      {error && <pre className="legit-error" style={{ marginTop: 6 }}>{error}</pre>}
    </Section>
  );
}

/** What "Use global config" actually resolves to, or a commit-will-fail warning. */
function InheritedIdentityNote({ identity }: { identity: ResolvedIdentity | null }) {
  if (!identity) return null;
  const resolved = [identity.user_name, identity.user_email].filter(Boolean).join(" · ");
  return (
    <div className="legit-subtle" style={{ marginTop: 4, fontSize: "var(--fz-sm)" }}>
      {resolved
        ? `Inheriting identity: ${resolved}.`
        : "No identity is set at any scope: commits will fail. Set the global identity in Global Settings, or configure this repo below."}
    </div>
  );
}

function StatusBadge({
  match,
  profileName,
}: {
  match: ProfileStatus["match"];
  profileName: (id: string) => string;
}) {
  let color = "var(--subtle-fg)";
  let text = "Inherit (global config)";
  if (match.kind === "active") {
    color = "var(--success-fg)";
    text = `Active: ${profileName(match.profile_id)}`;
  } else if (match.kind === "custom") {
    text = "Custom (this repo)";
  }
  return <span style={{ color, fontWeight: 600 }}>{text}</span>;
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
