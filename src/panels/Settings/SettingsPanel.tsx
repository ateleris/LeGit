import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { formatAppError } from "../../lib/types";
import { useGitStatusStore } from "../../store/git-status";
import { Button } from "../shared/buttons";

/** v0.1 Settings panel: Git executable path only (DESIGN.md §8). */
export function SettingsPanel() {
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
        <strong>Settings</strong>
        <span className="legit-subtle">v0.1</span>
      </div>
      <div className="legit-panel__body">
        <Section title="Git executable">
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
                    {status.minimum_required[0]}.{status.minimum_required[1]}.{status.minimum_required[2]}
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
              <div style={{ marginTop: 12 }}>
                <label style={{ fontSize: "var(--fz-sm)", color: "var(--subtle-fg)" }}>
                  Override path (leave blank for auto-detect)
                </label>
                <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                  <input
                    style={{ flex: 1 }}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder="/usr/bin/git or C:\\Program Files\\Git\\cmd\\git.exe"
                  />
                  <button onClick={browseFor}>Browse…</button>
                  <Button
                    variant="primary"
                    disabled={pending}
                    onClick={() => apply(draft.trim() === "" ? null : draft)}
                  >
                    Apply
                  </Button>
                  <button onClick={() => apply(null)} disabled={pending}>
                    Reset
                  </button>
                  <button onClick={() => refresh()} disabled={pending}>
                    Re-check
                  </button>
                </div>
              </div>
              {error && <pre className="legit-error">{error}</pre>}
            </>
          ) : (
            <span className="legit-subtle">Probing git…</span>
          )}
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div
        style={{
          fontSize: "var(--fz-sm)",
          textTransform: "uppercase",
          letterSpacing: 0.5,
          color: "var(--subtle-fg)",
          marginBottom: 8,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "160px 1fr",
        gap: 6,
        padding: "2px 0",
      }}
    >
      <div className="legit-subtle">{label}</div>
      <div>{value}</div>
    </div>
  );
}
