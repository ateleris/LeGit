import { type ReactNode, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { GitStatus } from "../../lib/types";
import { useGitStatusStore } from "../../store/git-status";

interface Props {
  status: GitStatus;
  children: ReactNode;
}

/**
 * DESIGN.md §7.6: block app use until git is resolved. Below-minimum
 * versions get a soft warning with "continue anyway".
 */
export function GitSetupGate({ status, children }: Props) {
  const setPath = useGitStatusStore((s) => s.setPath);
  const refresh = useGitStatusStore((s) => s.refresh);
  const [continueAnyway, setContinueAnyway] = useState(false);

  if (!status.version || status.error) {
    return (
      <Setup
        title="Git executable not found"
        body={
          <p>
            LeGit could not run <code>git --version</code> at{" "}
            <code>{status.resolved_path}</code>.
            {status.error ? <> Detail: {status.error}</> : null}
          </p>
        }
        showBrowse
        onBrowse={async () => {
          const p = await openDialog({ multiple: false });
          if (typeof p === "string") await setPath(p);
        }}
        onRetry={refresh}
      />
    );
  }

  if (!status.meets_minimum && !continueAnyway) {
    return (
      <Setup
        title="Git is older than recommended"
        body={
          <p>
            LeGit detected <code>git {status.version.raw}</code> at{" "}
            <code>{status.resolved_path}</code>. The recommended minimum is{" "}
            <strong>
              {status.minimum_required[0]}.{status.minimum_required[1]}.{status.minimum_required[2]}
            </strong>{" "}
            (needed for SSH commit signing among other things). You can
            continue, but some features may not work.
          </p>
        }
        showBrowse
        onBrowse={async () => {
          const p = await openDialog({ multiple: false });
          if (typeof p === "string") await setPath(p);
        }}
        onContinueAnyway={() => setContinueAnyway(true)}
      />
    );
  }

  return <>{children}</>;
}

interface SetupProps {
  title: string;
  body: ReactNode;
  showBrowse?: boolean;
  onBrowse?: () => void;
  onContinueAnyway?: () => void;
  onRetry?: () => void;
}

function Setup({ title, body, showBrowse, onBrowse, onContinueAnyway, onRetry }: SetupProps) {
  return (
    <div className="legit-splash">
      <div
        className="legit-splash__inner"
        style={{ maxWidth: 560, padding: 24, textAlign: "left" }}
      >
        <div className="legit-splash__title">{title}</div>
        <div className="legit-splash__subtitle">{body}</div>
        <p>
          Download git from{" "}
          <a
            href="https://git-scm.com/downloads"
            target="_blank"
            rel="noreferrer"
            style={{ color: "var(--accent-fg, white)" }}
          >
            git-scm.com/downloads
          </a>
          .
        </p>
        <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
          {showBrowse && (
            <button onClick={onBrowse}>Browse for git executable…</button>
          )}
          {onRetry && (
            <button onClick={onRetry} className="primary">
              Try again
            </button>
          )}
          {onContinueAnyway && (
            <button onClick={onContinueAnyway} className="primary">
              Continue anyway
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
