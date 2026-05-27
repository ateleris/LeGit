import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { formatAppError } from "../../lib/types";
import type { ConfigScope, LineEndingsView, RegionPlacement } from "../../lib/types";
import { globalLineEndingsView, globalWriteLineEndings } from "../../lib/commands";
import { useGitStatusStore } from "../../store/git-status";
import { useSettingsStore } from "../../store/settings";

/** Global Settings panel — edits global-scope settings (DESIGN-v0.2.md §F.6). */
export function GlobalSettingsPanel() {
  const status = useGitStatusStore((s) => s.status);
  const pending = useGitStatusStore((s) => s.pending);
  const setPath = useGitStatusStore((s) => s.setPath);
  const refresh = useGitStatusStore((s) => s.refresh);
  const [draft, setDraft] = useState(status?.user_override ?? "");
  const [error, setError] = useState<string | null>(null);

  const browseFor = async () => {
    const selected = await openDialog({ multiple: false });
    if (typeof selected === "string") setDraft(selected);
  };

  const apply = async (path: string | null) => {
    setError(null);
    try {
      await setPath(path);
    } catch (e) {
      setError(formatAppError(e));
    }
  };

  return (
    <div className="legit-panel">
      <div className="legit-panel__toolbar">
        <strong>Global Settings (this LeGit install)</strong>
      </div>
      <div className="legit-panel__body">
        <Section title="Git executable (default for all repos)">
          {status ? (
            <>
              <Row label="Resolved path" value={<code>{status.resolved_path}</code>} />
              <Row
                label="Version"
                value={
                  status.version ? (
                    <code>{status.version.raw}</code>
                  ) : (
                    <span className="legit-error">{status.error ?? "(unknown)"}</span>
                  )
                }
              />
              <Row
                label="Minimum required"
                value={
                  <code>
                    {status.minimum_required[0]}.{status.minimum_required[1]}.
                    {status.minimum_required[2]}
                  </code>
                }
              />
              <Row
                label="Meets minimum"
                value={
                  status.meets_minimum ? (
                    <span className="legit-success">yes</span>
                  ) : (
                    <span className="legit-error">no</span>
                  )
                }
              />
              <FieldNote>writes to: global settings</FieldNote>
              <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                <input
                  style={{ flex: 1 }}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="/usr/bin/git or leave blank for auto-detect"
                />
                <button onClick={browseFor}>Browse…</button>
                <button
                  className="primary"
                  disabled={pending}
                  onClick={() => apply(draft.trim() === "" ? null : draft)}
                >
                  Apply
                </button>
                <button onClick={() => apply(null)} disabled={pending}>
                  Reset
                </button>
                <button onClick={() => refresh()} disabled={pending}>
                  Re-check
                </button>
              </div>
              {error && <pre className="legit-error">{error}</pre>}
            </>
          ) : (
            <span className="legit-subtle">Probing git…</span>
          )}
        </Section>

        <LayoutOrientationSection />
        <LineEndingsGlobalSection />
      </div>
    </div>
  );
}

function LayoutOrientationSection() {
  const placement = useSettingsStore((s) => s.settings?.global_region_placement ?? "top");
  const setRegionPlacement = useSettingsStore((s) => s.setRegionPlacement);
  const [saving, setSaving] = useState(false);

  const select = async (p: RegionPlacement) => {
    if (p === placement || saving) return;
    setSaving(true);
    try {
      await setRegionPlacement(p);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section title="Layout orientation">
      <FieldNote>writes to: global settings</FieldNote>
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button
          className={placement === "top" ? "primary" : ""}
          disabled={saving}
          onClick={() => select("top")}
        >
          Top / Bottom
        </button>
        <button
          className={placement === "left" ? "primary" : ""}
          disabled={saving}
          onClick={() => select("left")}
        >
          Left / Right
        </button>
      </div>
    </Section>
  );
}

function LineEndingsGlobalSection() {
  const [view, setView] = useState<LineEndingsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [draftAutocrlf, setDraftAutocrlf] = useState<string | null>(null);
  const [draftEol, setDraftEol] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmPending, setConfirmPending] = useState(false);

  useEffect(() => {
    globalLineEndingsView()
      .then((v) => {
        setView(v);
        setDraftAutocrlf(v.autocrlf_global.value ?? null);
        setDraftEol(v.eol_global.value ?? null);
      })
      .catch((e) => setError(formatAppError(e)))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Section title="Line endings (global)"><span className="legit-subtle">Loading…</span></Section>;
  if (!view) return null;

  const dirty =
    draftAutocrlf !== (view.autocrlf_global.value ?? null) ||
    draftEol !== (view.eol_global.value ?? null);

  const changes = getChangedValues(
    { autocrlf: view.autocrlf_global.value, eol: view.eol_global.value },
    { autocrlf: draftAutocrlf, eol: draftEol }
  );

  const handleSave = () => setConfirmPending(true);

  const handleConfirm = async () => {
    setConfirmPending(false);
    setSaving(true);
    setError(null);
    try {
      const updated = await globalWriteLineEndings(draftAutocrlf, draftEol);
      setView(updated);
      setDraftAutocrlf(updated.autocrlf_global.value ?? null);
      setDraftEol(updated.eol_global.value ?? null);
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setDraftAutocrlf(view.autocrlf_global.value ?? null);
    setDraftEol(view.eol_global.value ?? null);
  };

  return (
    <Section title="Line endings (global)">
      <FieldNote>writes to: ~/.gitconfig — affects all repos that don't override these values</FieldNote>

      <div style={{ marginTop: 10 }}>
        <ConfigRow label="core.autocrlf">
          <RadioGroup
            name="global-autocrlf"
            value={draftAutocrlf}
            options={AUTOCRLF_OPTIONS}
            onChange={setDraftAutocrlf}
          />
          <ResolvedBadge label="system" value={view.autocrlf_system.value} source={view.autocrlf_system.source} />
          <ResolvedBadge label="resolved" value={view.autocrlf_resolved.value} source={view.autocrlf_resolved.source} isResolved />
        </ConfigRow>

        <ConfigRow label="core.eol">
          <RadioGroup
            name="global-eol"
            value={draftEol}
            options={EOL_OPTIONS}
            onChange={setDraftEol}
          />
          <ResolvedBadge label="system" value={view.eol_system.value} source={view.eol_system.source} />
          <ResolvedBadge label="resolved" value={view.eol_resolved.value} source={view.eol_resolved.source} isResolved />
        </ConfigRow>
      </div>

      {confirmPending && (
        <div style={{ marginTop: 10, padding: "10px 12px", background: "var(--button-hover-bg)", border: "1px solid var(--panel-border)", borderRadius: 4 }}>
          <div style={{ fontWeight: 600, marginBottom: 6, color: "var(--error-fg)" }}>
            ⚠ Save line-ending changes to your global Git config (~/.gitconfig)?
          </div>
          <div style={{ marginBottom: 8, fontSize: 12 }}>
            {changes.map((c) => (
              <div key={c.key} style={{ fontFamily: "monospace" }}>
                <code>{c.key}</code>: <code>{c.before ?? "unset"}</code> → <code>{c.after ?? "unset"}</code>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 12, color: "var(--subtle-fg)", marginBottom: 10 }}>
            These changes affect every Git repository on this machine that doesn't override these values locally,
            and every tool that reads your global Git config — terminal git, other GUIs, CI scripts, IDE integrations.
            If you only want this for one repo, cancel and edit that repo's settings instead.
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button className="primary" onClick={handleConfirm} disabled={saving}>Save globally</button>
            <button onClick={() => setConfirmPending(false)}>Cancel</button>
          </div>
        </div>
      )}

      {!confirmPending && (
        <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
          <button className="primary" disabled={!dirty || saving} onClick={handleSave}>
            Save
          </button>
          <button disabled={!dirty || saving} onClick={handleCancel}>
            Cancel
          </button>
        </div>
      )}

      {error && <pre className="legit-error" style={{ marginTop: 6 }}>{error}</pre>}
    </Section>
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
  const fromLabel = source !== "unset" ? ` (from ${scopeLabel(source)})` : "";
  return (
    <div style={{ marginTop: 4, fontSize: 11, color: isResolved ? "var(--success-fg)" : "var(--subtle-fg)" }}>
      {label}: <code>{value}</code>{fromLabel}
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
