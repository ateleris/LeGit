// The app machine's git binary: which one LeGit resolved, its version, and the
// override. The WSL twin lives in `WslGitExecutableSection` (a distro's binary
// is named by a path INSIDE the distro, and no Windows file dialog can pick it).

import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { formatAppError } from "../../lib/types";
import { useGitStatusStore } from "../../store/git-status";
import { Button } from "../shared/buttons";
import { Section, Row, FieldNote } from "./primitives";

export function GitExecutableSection() {
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
          {error && <pre className="legit-error">{error}</pre>}
        </>
      ) : (
        <span className="legit-subtle">Probing git…</span>
      )}
    </Section>
  );
}
