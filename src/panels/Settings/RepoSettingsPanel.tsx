import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useState } from "react";
import { usePanelFocusEffect, usePanelDirty } from "../PanelApiContext";
import { formatAppError } from "../../lib/types";
import type { ConfigScope, LineEndingsView, GitAttrRule } from "../../lib/types";
import { setRepoGitPath, repoLineEndingsView, repoWriteLineEndings, updateRepoSettings } from "../../lib/commands";
import { useGitStatusStore } from "../../store/git-status";
import { useActiveRepo, useRepoStore } from "../../store/repos";
import { useSettingsStore } from "../../store/settings";

/**
 * Repo Settings panel — edits repo-scope settings for the active repo.
 * Scope and scope target are explicit per DESIGN-v0.2.md §F.6.
 */
export function RepoSettingsPanel() {
  const activeRepo = useActiveRepo();
  const globalStatus = useGitStatusStore((s) => s.status);
  const repoSettings = useRepoStore((s) =>
    activeRepo ? s.repoSettings[activeRepo.id] : null
  );
  const loadRepoSettings = useRepoStore((s) => s.loadRepoSettings);

  const [draft, setDraft] = useState("");
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  useEffect(() => {
    if (activeRepo && !repoSettings) {
      loadRepoSettings(activeRepo.id);
    }
  }, [activeRepo?.id, repoSettings, loadRepoSettings]);

  // Reset draft when switching repos.
  useEffect(() => {
    setDraft("");
    setError(null);
    setSuccessMsg(null);
  }, [activeRepo?.id]);

  if (!activeRepo) {
    return (
      <div className="legit-panel">
        <div className="legit-panel__toolbar">
          <strong>Repo Settings</strong>
        </div>
        <div className="legit-panel__body">
          <span className="legit-subtle">No repository open.</span>
        </div>
      </div>
    );
  }

  const browseFor = async () => {
    const selected = await openDialog({ multiple: false });
    if (typeof selected === "string") setDraft(selected);
  };

  const refresh = useRepoStore((s) => s.refresh);
  const setActive = useRepoStore((s) => s.setActive);

  const apply = async (path: string | null) => {
    setError(null);
    setSuccessMsg(null);
    setApplying(true);
    try {
      // Command tears down the old session and returns a fresh RepoSummary.
      const newSummary = await setRepoGitPath(activeRepo.id, path);
      await refresh();
      setActive(newSummary.id);
      setSuccessMsg("Git path updated. Session restarted.");
      setDraft("");
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="legit-panel">
      <div className="legit-panel__toolbar">
        <strong>Repo Settings — {activeRepo.name}</strong>
        <span
          className="legit-subtle"
          title={activeRepo.path}
          style={{ fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        >
          {activeRepo.path}
        </span>
      </div>
      <div className="legit-panel__body">
        <Section title="Git executable (override for this repo)">
          <Row
            label="Global default"
            value={<code>{globalStatus?.resolved_path ?? "…"}</code>}
          />
          {repoSettings?.git_path_override && (
            <Row
              label="Current override"
              value={<code>{repoSettings.git_path_override}</code>}
            />
          )}
          <FieldNote>writes to: repos/&lt;hash&gt;/settings.json (this repo only)</FieldNote>
          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            <input
              style={{ flex: 1 }}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Leave blank to inherit global default"
            />
            <button onClick={browseFor}>Browse…</button>
            <button
              className="primary"
              disabled={applying}
              onClick={() => apply(draft.trim() === "" ? null : draft)}
            >
              {draft.trim() === "" ? "Inherit" : "Apply override"}
            </button>
            {repoSettings?.git_path_override && (
              <button onClick={() => apply(null)} disabled={applying}>
                Clear override
              </button>
            )}
          </div>
          {error && <pre className="legit-error" style={{ marginTop: 6 }}>{error}</pre>}
          {successMsg && (
            <div className="legit-success" style={{ marginTop: 6, fontSize: 12 }}>
              {successMsg}
            </div>
          )}
        </Section>

        <MixedEndingRepoSection repoId={activeRepo.id} repoSettings={repoSettings} />
        <LineEndingsRepoSection repoId={activeRepo.id} />
      </div>
    </div>
  );
}

function MixedEndingRepoSection({
  repoId,
  repoSettings,
}: {
  repoId: string;
  repoSettings: import("../../lib/types").RepoSettings | null;
}) {
  const globalWarn = useSettingsStore((s) => s.settings?.warn_on_mixed_endings ?? true);
  const loadRepoSettings = useRepoStore((s) => s.loadRepoSettings);
  const [saving, setSaving] = useState(false);

  // null = inherit global
  const repoOverride = repoSettings?.warn_on_mixed_endings ?? null;
  const effective = repoOverride !== null ? repoOverride : globalWarn;

  const setOverride = async (value: boolean | null) => {
    if (!repoSettings) return;
    setSaving(true);
    try {
      await updateRepoSettings(repoId, { ...repoSettings, warn_on_mixed_endings: value });
      await loadRepoSettings(repoId);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section title="Mixed ending detection">
      <FieldNote>writes to: repos/&lt;hash&gt;/settings.json (this repo only)</FieldNote>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
        {(["inherit", "on", "off"] as const).map((opt) => {
          const checked =
            opt === "inherit" ? repoOverride === null :
            opt === "on" ? repoOverride === true :
            repoOverride === false;
          return (
            <label key={opt} style={{ display: "flex", alignItems: "center", gap: 6, cursor: saving ? "default" : "pointer", opacity: saving ? 0.5 : 1 }}>
              <input
                type="radio"
                name={`repo-mixed-${repoId}`}
                checked={checked}
                disabled={saving}
                onChange={() => setOverride(opt === "inherit" ? null : opt === "on")}
              />
              <span style={{ fontSize: 13 }}>
                {opt === "inherit"
                  ? `Inherit from global (currently ${globalWarn ? "on" : "off"})`
                  : opt === "on" ? "On" : "Off"}
              </span>
            </label>
          );
        })}
        <div style={{ fontSize: 11, color: "var(--subtle-fg)", marginTop: 2 }}>
          Effective: <strong>{effective ? "on" : "off"}</strong>
        </div>
      </div>
    </Section>
  );
}

function LineEndingsRepoSection({ repoId }: { repoId: string }) {
  const [view, setView] = useState<LineEndingsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [draftAutocrlf, setDraftAutocrlf] = useState<string | null>(null);
  const [draftEol, setDraftEol] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmPending, setConfirmPending] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setView(null);
    setConfirmPending(false);
    repoLineEndingsView(repoId)
      .then((v) => {
        setView(v);
        setDraftAutocrlf(v.autocrlf_local.value ?? null);
        setDraftEol(v.eol_local.value ?? null);
      })
      .catch((e) => setError(formatAppError(e)))
      .finally(() => setLoading(false));
  }, [repoId]);

  useEffect(() => { load(); }, [load]);
  usePanelFocusEffect(load);

  const dirty = view !== null && (
    draftAutocrlf !== (view.autocrlf_local.value ?? null) ||
    draftEol !== (view.eol_local.value ?? null)
  );

  usePanelDirty(dirty);

  if (loading) return <Section title="Line endings (this repo)"><span className="legit-subtle">Loading…</span></Section>;
  if (!view) return null;

  const coversAll = view.gitattributes_covers_all;
  const hasPartialRules = view.gitattributes.length > 0 && !coversAll;

  const changes = getChangedValues(
    { autocrlf: view.autocrlf_local.value, eol: view.eol_local.value },
    { autocrlf: draftAutocrlf, eol: draftEol }
  );

  const handleSave = () => setConfirmPending(true);

  const handleConfirm = async () => {
    setConfirmPending(false);
    setSaving(true);
    setError(null);
    try {
      const updated = await repoWriteLineEndings(repoId, draftAutocrlf, draftEol);
      setView(updated);
      setDraftAutocrlf(updated.autocrlf_local.value ?? null);
      setDraftEol(updated.eol_local.value ?? null);
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setDraftAutocrlf(view.autocrlf_local.value ?? null);
    setDraftEol(view.eol_local.value ?? null);
  };

  return (
    <Section title="Line endings (this repo)">
      <FieldNote>writes to: .git/config (this repo only)</FieldNote>

      {coversAll && (
        <div style={{ marginTop: 8, padding: "6px 8px", background: "var(--button-hover-bg)", borderRadius: 4, fontSize: 12 }}>
          A <code>*</code> pattern in <code>.gitattributes</code> sets text/eol for all files —{" "}
          <code>core.autocrlf</code> and <code>core.eol</code> are overridden by it.
          Current <code>git config</code> values are shown below for reference.
        </div>
      )}

      {hasPartialRules && (
        <div style={{ marginTop: 8, padding: "6px 8px", background: "var(--button-hover-bg)", borderRadius: 4, fontSize: 12 }}>
          This repo's <code>.gitattributes</code> covers some files (see below);{" "}
          <code>core.autocrlf</code> and <code>core.eol</code> apply to the rest.
        </div>
      )}

      <div style={{ marginTop: 10 }}>
        <ConfigRow label="core.autocrlf">
          <RadioGroup
            name={`repo-autocrlf-${repoId}`}
            value={draftAutocrlf}
            options={AUTOCRLF_OPTIONS}
            onChange={setDraftAutocrlf}
            disabled={coversAll}
          />
          <ResolvedBadge label="global" value={view.autocrlf_global.value} source={view.autocrlf_global.source} />
          <ResolvedBadge label="system" value={view.autocrlf_system.value} source={view.autocrlf_system.source} />
          <ResolvedBadge label="resolved" value={view.autocrlf_resolved.value} source={view.autocrlf_resolved.source} isResolved />
        </ConfigRow>

        <ConfigRow label="core.eol">
          <RadioGroup
            name={`repo-eol-${repoId}`}
            value={draftEol}
            options={EOL_OPTIONS}
            onChange={setDraftEol}
            disabled={coversAll}
          />
          <ResolvedBadge label="global" value={view.eol_global.value} source={view.eol_global.source} />
          <ResolvedBadge label="system" value={view.eol_system.value} source={view.eol_system.source} />
          <ResolvedBadge label="resolved" value={view.eol_resolved.value} source={view.eol_resolved.source} isResolved />
        </ConfigRow>
      </div>

      {confirmPending && (
        <div style={{ marginTop: 10, padding: "10px 12px", background: "var(--button-hover-bg)", border: "1px solid var(--panel-border)", borderRadius: 4 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>
            Save line-ending changes to this repo's .git/config?
          </div>
          <div style={{ marginBottom: 8, fontSize: 12 }}>
            {changes.map((c) => (
              <div key={c.key} style={{ fontFamily: "monospace" }}>
                <code>{c.key}</code>: <code>{c.before ?? "unset"}</code> → <code>{c.after ?? "unset"}</code>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 12, color: "var(--subtle-fg)", marginBottom: 10 }}>
            These writes affect only this repo. Your global Git config and other repos are not affected.
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button className="primary" onClick={handleConfirm} disabled={saving}>Save</button>
            <button onClick={() => setConfirmPending(false)}>Cancel</button>
          </div>
        </div>
      )}

      {!confirmPending && (
        <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
          <button className="primary" disabled={!dirty || saving || coversAll} onClick={handleSave}>
            Save
          </button>
          <button disabled={!dirty || saving} onClick={handleCancel}>
            Cancel
          </button>
        </div>
      )}

      {error && <pre className="legit-error" style={{ marginTop: 6 }}>{error}</pre>}

      {view.gitattributes.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--subtle-fg)", marginBottom: 6 }}>
            .gitattributes rules
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr>
                {["pattern", "text", "eol"].map((h) => (
                  <th key={h} style={{ textAlign: "left", padding: "2px 8px 2px 0", color: "var(--subtle-fg)", fontWeight: "normal" }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {view.gitattributes.map((rule, i) => (
                <GitAttrRow key={i} rule={rule} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {view.mixed_ending_files.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--error-fg)", marginBottom: 6 }}>
            Files with mixed CRLF+LF ({view.mixed_ending_files.length})
          </div>
          <div style={{ maxHeight: 120, overflowY: "auto" }}>
            {view.mixed_ending_files.map((f) => (
              <div key={f} style={{ fontFamily: "monospace", fontSize: 11, padding: "1px 0" }}>{f}</div>
            ))}
          </div>
        </div>
      )}
    </Section>
  );
}

function GitAttrRow({ rule }: { rule: GitAttrRule }) {
  return (
    <tr>
      <td style={{ padding: "1px 8px 1px 0", fontFamily: "monospace" }}>{rule.pattern}</td>
      <td style={{ padding: "1px 8px 1px 0", fontFamily: "monospace", color: rule.text ? "inherit" : "var(--subtle-fg)" }}>
        {rule.text ?? "—"}
      </td>
      <td style={{ padding: "1px 8px 1px 0", fontFamily: "monospace", color: rule.eol ? "inherit" : "var(--subtle-fg)" }}>
        {rule.eol ?? "—"}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const AUTOCRLF_OPTIONS: { label: string; value: string | null }[] = [
  { label: "true", value: "true" },
  { label: "input", value: "input" },
  { label: "false", value: "false" },
  { label: "Inherit", value: null },
];

const EOL_OPTIONS: { label: string; value: string | null }[] = [
  { label: "lf", value: "lf" },
  { label: "crlf", value: "crlf" },
  { label: "native", value: "native" },
  { label: "Inherit", value: null },
];

interface ChangeItem { key: string; before: string | null; after: string | null }

function getChangedValues(
  before: { autocrlf: string | null; eol: string | null },
  after: { autocrlf: string | null; eol: string | null }
): ChangeItem[] {
  const result: ChangeItem[] = [];
  if (before.autocrlf !== after.autocrlf) {
    result.push({ key: "core.autocrlf", before: before.autocrlf, after: after.autocrlf });
  }
  if (before.eol !== after.eol) {
    result.push({ key: "core.eol", before: before.eol, after: after.eol });
  }
  return result;
}

function scopeLabel(scope: ConfigScope): string {
  switch (scope) {
    case "local": return "local";
    case "global": return "global";
    case "system": return "system";
    default: return "";
  }
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
          <code style={{ fontSize: 12 }}>{opt.label}</code>
        </label>
      ))}
    </div>
  );
}

function ConfigRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 12, fontFamily: "monospace", color: "var(--subtle-fg)", marginBottom: 4 }}>{label}</div>
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
    <div style={{ marginTop: 4, fontSize: 11, color: isResolved ? "var(--success-fg)" : "var(--subtle-fg)" }}>
      {label}: <code>{value}</code>{isResolved ? fromLabel : ""}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--subtle-fg)", marginBottom: 8 }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "160px 1fr", gap: 6, padding: "2px 0" }}>
      <div className="legit-subtle">{label}</div>
      <div>{value}</div>
    </div>
  );
}

function FieldNote({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 11, color: "var(--subtle-fg)", marginTop: 4 }}>
      {children}
    </div>
  );
}
