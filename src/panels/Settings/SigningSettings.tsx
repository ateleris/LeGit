import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useState } from "react";
import { usePanelFocusEffect, usePanelDirty } from "../PanelApiContext";
import { WarningIcon } from "../../icons";
import { formatAppError } from "../../lib/types";
import type { ConfigScope, ScopedConfig, SigningView } from "../../lib/types";
import {
  repoSigningConfig,
  globalSigningConfig,
  repoWriteSigning,
  globalWriteSigning,
} from "../../lib/commands";
import { Button } from "../shared/buttons";

type Scope = "repo" | "global";

/**
 * Commit-signing settings — a direct mirror of `commit.gpgsign`, `gpg.format`,
 * `user.signingkey`, and `gpg.ssh.allowedSignersFile` at the given scope. Used
 * by both the Global and Repo settings panels. SSH is the priority path, so the
 * allowed-signers file is surfaced whenever the format is `ssh`.
 */
export function SigningSettings({ scope, repoId }: { scope: Scope; repoId?: string }) {
  const isRepo = scope === "repo";
  const editScopeLabel = isRepo ? "local" : "global";

  const [view, setView] = useState<SigningView | null>(null);
  const [loading, setLoading] = useState(true);
  const [gpgsign, setGpgsign] = useState<string | null>(null);
  const [format, setFormat] = useState<string | null>(null);
  const [signingKey, setSigningKey] = useState("");
  const [allowedSigners, setAllowedSigners] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmPending, setConfirmPending] = useState(false);

  // Value at the scope we edit (local for repo, global otherwise).
  const editVal = useCallback(
    (c: ScopedConfig): string | null => (isRepo ? c.local.value : c.global.value) ?? null,
    [isRepo]
  );

  const resetDrafts = useCallback(
    (v: SigningView) => {
      setGpgsign(editVal(v.gpgsign));
      setFormat(editVal(v.format));
      setSigningKey(editVal(v.signing_key) ?? "");
      setAllowedSigners(editVal(v.allowed_signers) ?? "");
    },
    [editVal]
  );

  const load = useCallback(() => {
    setLoading(true);
    setConfirmPending(false);
    const p = isRepo ? repoSigningConfig(repoId!) : globalSigningConfig();
    p.then((v) => {
      setView(v);
      resetDrafts(v);
    })
      .catch((e) => setError(formatAppError(e)))
      .finally(() => setLoading(false));
  }, [isRepo, repoId, resetDrafts]);

  useEffect(() => { load(); }, [load]);
  usePanelFocusEffect(load);

  const trimmedKey = signingKey.trim() === "" ? null : signingKey.trim();
  const trimmedSigners = allowedSigners.trim() === "" ? null : allowedSigners.trim();

  const dirty =
    view !== null &&
    (gpgsign !== editVal(view.gpgsign) ||
      format !== editVal(view.format) ||
      trimmedKey !== editVal(view.signing_key) ||
      trimmedSigners !== editVal(view.allowed_signers));

  usePanelDirty(dirty);

  const title = isRepo ? "Commit signing (this repo)" : "Commit signing (global)";

  if (loading) {
    return <Section title={title}><span className="legit-subtle">Loading…</span></Section>;
  }
  if (!view) return null;

  const isSsh = (format ?? view.format.resolved.value) === "ssh";

  const changes = getChanges(view, editVal, { gpgsign, format, signingKey: trimmedKey, allowedSigners: trimmedSigners });

  const handleSave = () => setConfirmPending(true);

  const handleConfirm = async () => {
    setConfirmPending(false);
    setSaving(true);
    setError(null);
    try {
      const updated = isRepo
        ? await repoWriteSigning(repoId!, gpgsign, format, trimmedKey, trimmedSigners)
        : await globalWriteSigning(gpgsign, format, trimmedKey, trimmedSigners);
      setView(updated);
      resetDrafts(updated);
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => resetDrafts(view);

  const browseInto = async (set: (v: string) => void) => {
    const selected = await openDialog({ multiple: false });
    if (typeof selected === "string") set(selected);
  };

  return (
    <Section title={title}>
      <FieldNote>
        {isRepo
          ? "writes to: .git/config (this repo only)"
          : "writes to: ~/.gitconfig — affects all repos that don't override these values"}
      </FieldNote>

      <div style={{ marginTop: 10 }}>
        <ConfigRow label="commit.gpgsign">
          <RadioGroup
            name={`${scope}-gpgsign`}
            value={gpgsign}
            options={GPGSIGN_OPTIONS}
            onChange={setGpgsign}
          />
          <ScopeBadges view={view} pick={(c) => c.gpgsign} editScope={editScopeLabel} />
        </ConfigRow>

        <ConfigRow label="gpg.format">
          <RadioGroup
            name={`${scope}-format`}
            value={format}
            options={FORMAT_OPTIONS}
            onChange={setFormat}
          />
          <ScopeBadges view={view} pick={(c) => c.format} editScope={editScopeLabel} />
        </ConfigRow>

        <ConfigRow label="user.signingkey">
          <div style={{ display: "flex", gap: 6 }}>
            <input
              style={{ flex: 1 }}
              value={signingKey}
              placeholder={isSsh ? "Path to SSH key (or literal public key)" : "GPG key id (e.g. ABC123…)"}
              onChange={(e) => setSigningKey(e.target.value)}
            />
            <button onClick={() => browseInto(setSigningKey)}>Browse…</button>
          </div>
          <ScopeBadges view={view} pick={(c) => c.signing_key} editScope={editScopeLabel} />
        </ConfigRow>

        {isSsh && (
          <ConfigRow label="gpg.ssh.allowedSignersFile">
            <div style={{ display: "flex", gap: 6 }}>
              <input
                style={{ flex: 1 }}
                value={allowedSigners}
                placeholder="Path to allowed signers file"
                onChange={(e) => setAllowedSigners(e.target.value)}
              />
              <button onClick={() => browseInto(setAllowedSigners)}>Browse…</button>
            </div>
            <FieldNote>
              Required to verify SSH signatures. Without it, git cannot check them, so even
              your own SSH-signed commits show as <em>unsigned</em> in the log.
            </FieldNote>
            <ScopeBadges view={view} pick={(c) => c.allowed_signers} editScope={editScopeLabel} />
          </ConfigRow>
        )}
      </div>

      {confirmPending && (
        <div style={{ marginTop: 10, padding: "10px 12px", background: "var(--button-hover-bg)", border: "1px solid var(--panel-border)", borderRadius: 4 }}>
          <div style={{ fontWeight: 600, marginBottom: 6, color: isRepo ? undefined : "var(--error-fg)", display: "flex", alignItems: "center", gap: 6 }}>
            {!isRepo && <WarningIcon />}
            {isRepo
              ? "Save signing changes to this repo's .git/config?"
              : "Save signing changes to your global Git config (~/.gitconfig)?"}
          </div>
          <div style={{ marginBottom: 8, fontSize: "var(--fz-md)" }}>
            {changes.map((c) => (
              <div key={c.key} style={{ fontFamily: "monospace" }}>
                <code>{c.key}</code>: <code>{c.before ?? "unset"}</code> → <code>{c.after ?? "unset"}</code>
              </div>
            ))}
          </div>
          <div style={{ fontSize: "var(--fz-md)", color: "var(--subtle-fg)", marginBottom: 10 }}>
            {isRepo
              ? "These writes affect only this repo. Your global Git config and other repos are not affected."
              : "These changes affect every repository on this machine that doesn't override them locally, and every tool that reads your global Git config."}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <Button variant="primary" onClick={handleConfirm} disabled={saving}>
              {isRepo ? "Save" : "Save globally"}
            </Button>
            <button onClick={() => setConfirmPending(false)}>Cancel</button>
          </div>
        </div>
      )}

      {!confirmPending && (
        <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
          <Button variant="primary" disabled={!dirty || saving} onClick={handleSave}>Save</Button>
          <button disabled={!dirty || saving} onClick={handleCancel}>Cancel</button>
        </div>
      )}

      {error && <pre className="legit-error" style={{ marginTop: 6 }}>{error}</pre>}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Options + change diff
// ---------------------------------------------------------------------------

const GPGSIGN_OPTIONS: { label: string; value: string | null }[] = [
  { label: "On", value: "true" },
  { label: "Off", value: "false" },
  { label: "Inherit", value: null },
];

const FORMAT_OPTIONS: { label: string; value: string | null }[] = [
  { label: "ssh", value: "ssh" },
  { label: "openpgp (GPG)", value: "openpgp" },
  { label: "x509", value: "x509" },
  { label: "Inherit", value: null },
];

interface ChangeItem { key: string; before: string | null; after: string | null }

function getChanges(
  view: SigningView,
  editVal: (c: ScopedConfig) => string | null,
  draft: { gpgsign: string | null; format: string | null; signingKey: string | null; allowedSigners: string | null }
): ChangeItem[] {
  const out: ChangeItem[] = [];
  const push = (key: string, before: string | null, after: string | null) => {
    if (before !== after) out.push({ key, before, after });
  };
  push("commit.gpgsign", editVal(view.gpgsign), draft.gpgsign);
  push("gpg.format", editVal(view.format), draft.format);
  push("user.signingkey", editVal(view.signing_key), draft.signingKey);
  push("gpg.ssh.allowedSignersFile", editVal(view.allowed_signers), draft.allowedSigners);
  return out;
}

// ---------------------------------------------------------------------------
// Presentational helpers (mirror the line-endings settings sections)
// ---------------------------------------------------------------------------

function scopeLabel(scope: ConfigScope): string {
  switch (scope) {
    case "local": return "local";
    case "global": return "global";
    case "system": return "system";
    default: return "";
  }
}

/** Shows the resolved value (and any scopes other than the one being edited). */
function ScopeBadges({
  view,
  pick,
  editScope,
}: {
  view: SigningView;
  pick: (c: SigningView) => ScopedConfig;
  editScope: "local" | "global";
}) {
  const c = pick(view);
  return (
    <>
      {editScope === "local" && (
        <ResolvedBadge label="global" value={c.global.value} source={c.global.source} />
      )}
      <ResolvedBadge label="system" value={c.system.value} source={c.system.source} />
      <ResolvedBadge label="resolved" value={c.resolved.value} source={c.resolved.source} isResolved />
    </>
  );
}

function RadioGroup({
  name,
  value,
  options,
  onChange,
  disabled,
}: {
  name: string;
  value: string | null;
  options: { label: string; value: string | null }[];
  onChange: (v: string | null) => void;
  disabled?: boolean;
}) {
  return (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
      {options.map((opt) => (
        <label key={opt.label} style={{ display: "flex", alignItems: "center", gap: 4, cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.5 : 1 }}>
          <input
            type="radio"
            name={name}
            checked={value === opt.value}
            onChange={() => onChange(opt.value)}
            disabled={disabled}
          />
          <code style={{ fontSize: "var(--fz-md)" }}>{opt.label}</code>
        </label>
      ))}
    </div>
  );
}

function ConfigRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: "var(--fz-md)", fontFamily: "monospace", color: "var(--subtle-fg)", marginBottom: 4 }}>{label}</div>
      <div style={{ paddingLeft: 8 }}>{children}</div>
    </div>
  );
}

function ResolvedBadge({
  label,
  value,
  source,
  isResolved,
}: {
  label: string;
  value: string | null;
  source: ConfigScope;
  isResolved?: boolean;
}) {
  if (!value) return null;
  const sl = scopeLabel(source);
  const fromLabel = sl ? ` (from ${sl})` : "";
  return (
    <div style={{ marginTop: 4, fontSize: "var(--fz-sm)", color: isResolved ? "var(--success-fg)" : "var(--subtle-fg)" }}>
      {label}: <code>{value}</code>{isResolved ? fromLabel : ""}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: "var(--fz-sm)", textTransform: "uppercase", letterSpacing: 0.5, color: "var(--subtle-fg)", marginBottom: 8 }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function FieldNote({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: "var(--fz-sm)", color: "var(--subtle-fg)", marginTop: 4 }}>
      {children}
    </div>
  );
}
