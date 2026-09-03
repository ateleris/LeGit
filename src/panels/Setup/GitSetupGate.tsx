import { type ReactNode, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import type { GitStatus } from "../../lib/types";
import { useGitStatusStore } from "../../store/git-status";
import { copyText } from "../../lib/clipboard";
import { Button } from "../shared/buttons";
import { formatVersionTriple } from "../Settings/GitStatusReadout";

interface Props {
  status: GitStatus;
  children: ReactNode;
}

/**
 * DESIGN.md §7.6: block app use until git is resolved. Below-minimum
 * versions get a soft warning with "continue anyway".
 *
 * This is the app's first-run screen on machines without git (the bundled-git
 * trade study decided against shipping our own — see
 * design/2026-07-07-bundled-git-trade-study.md), so the no-git state doubles
 * as install onboarding: per-platform install actions, a copyable package
 * manager command, and an explicit re-check.
 */
export function GitSetupGate({ status, children }: Props) {
  const setPath = useGitStatusStore((s) => s.setPath);
  const refresh = useGitStatusStore((s) => s.refresh);
  const pending = useGitStatusStore((s) => s.pending);
  const [continueAnyway, setContinueAnyway] = useState(false);
  // Set once the user has re-checked at least once and git is still missing,
  // to surface the "PATH changes need an app restart" hint.
  const [recheckedAndStillMissing, setRecheckedAndStillMissing] = useState(false);

  const browse = async () => {
    const p = await openDialog({ multiple: false });
    if (typeof p === "string") await setPath(p);
  };

  const recheck = async () => {
    await refresh();
    setRecheckedAndStillMissing(true);
  };

  if (!status.version || status.error) {
    return (
      <Setup title="Git is not installed (or was not found)">
        <p>
          LeGit drives the real <code>git</code> command line and needs it
          installed — it could not run <code>git --version</code> via{" "}
          <code>{status.resolved_path}</code>.
          {status.error ? (
            <>
              {" "}
              Detail: <span className="legit-subtle">{status.error}</span>
            </>
          ) : null}
        </p>

        <InstallInstructions />

        <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap", alignItems: "center" }}>
          <Button onClick={recheck} variant="primary" disabled={pending}>
            {pending ? "Checking…" : "Re-check"}
          </Button>
          <button onClick={browse} disabled={pending}>Browse for git executable…</button>
        </div>
        {recheckedAndStillMissing && !pending && (
          <p className="legit-subtle" style={{ marginTop: 10, fontSize: "var(--fz-md)" }}>
            Still not found. If you installed git just now, the PATH change may
            not reach this running app — restart LeGit (on Windows, log out and
            back in if it persists), or point at the executable directly with
            "Browse".
          </p>
        )}
      </Setup>
    );
  }

  if (!status.meets_minimum && !continueAnyway) {
    return (
      <Setup title="Git is older than recommended">
        <p>
          LeGit detected <code>git {status.version.raw}</code> at{" "}
          <code>{status.resolved_path}</code>. The recommended minimum is{" "}
          <strong>{formatVersionTriple(status.minimum_required)}</strong>{" "}
          (needed for SSH commit signing among other things). You can continue,
          but some features may not work.
        </p>

        <InstallInstructions upgrade />

        <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap", alignItems: "center" }}>
          <Button onClick={recheck} disabled={pending}>
            {pending ? "Checking…" : "Re-check"}
          </Button>
          <button onClick={browse} disabled={pending}>Browse for git executable…</button>
          <Button onClick={() => setContinueAnyway(true)} variant="primary">
            Continue anyway
          </Button>
        </div>
      </Setup>
    );
  }

  return <>{children}</>;
}

type Platform = "windows" | "macos" | "linux";

function detectPlatform(): Platform {
  const ua = navigator.userAgent;
  if (ua.includes("Windows")) return "windows";
  if (ua.includes("Mac")) return "macos";
  return "linux";
}

/** Per-platform install (or upgrade) guidance: a download button plus a
 * copyable package-manager command. */
function InstallInstructions({ upgrade }: { upgrade?: boolean }) {
  const platform = detectPlatform();
  const verb = upgrade ? "Upgrade" : "Install";

  return (
    <div style={{ marginTop: 14 }}>
      {platform === "windows" && (
        <>
          <p style={{ marginBottom: 8 }}>
            {verb} <strong>Git for Windows</strong> — its installer sets up the
            credential manager and PATH for you:
          </p>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <Button onClick={() => void openExternal("https://git-scm.com/download/win")}>
              Download Git for Windows
            </Button>
            <span className="legit-subtle">or via winget:</span>
          </div>
          <CopyableCommand command="winget install --id Git.Git -e --source winget" />
        </>
      )}
      {platform === "macos" && (
        <>
          <p style={{ marginBottom: 8 }}>
            {verb} git via the Xcode Command Line Tools (Apple's git) or
            Homebrew:
          </p>
          <CopyableCommand command="xcode-select --install" />
          <CopyableCommand command="brew install git" />
          <div style={{ marginTop: 8 }}>
            <Button onClick={() => void openExternal("https://git-scm.com/download/mac")}>
              Other install options
            </Button>
          </div>
        </>
      )}
      {platform === "linux" && (
        <>
          <p style={{ marginBottom: 8 }}>{verb} git with your distribution's package manager:</p>
          <CopyableCommand command="sudo apt install git" note="Debian / Ubuntu" />
          <CopyableCommand command="sudo dnf install git" note="Fedora" />
          <CopyableCommand command="sudo pacman -S git" note="Arch" />
        </>
      )}
    </div>
  );
}

/** A one-line command with a copy button ("Copied" feedback, ~1.5s). */
function CopyableCommand({ command, note }: { command: string; note?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      // copyText, not navigator.clipboard directly: it falls back to the
      // hidden-textarea path in webviews where the async API is blocked.
      await copyText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable — the command is still selectable by hand.
    }
  };

  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
      <code
        style={{
          padding: "3px 8px",
          border: "1px solid var(--panel-border)",
          borderRadius: 3,
          background: "var(--button-hover-bg)",
          fontSize: "var(--fz-md)",
          userSelect: "all",
        }}
      >
        {command}
      </code>
      <button onClick={copy}>{copied ? "Copied" : "Copy"}</button>
      {note && <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)" }}>{note}</span>}
    </div>
  );
}

function Setup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="legit-splash">
      <div
        className="legit-splash__inner"
        style={{ maxWidth: 620, padding: 24, textAlign: "left" }}
      >
        <div className="legit-splash__title">{title}</div>
        <div style={{ marginTop: 8, fontSize: "var(--fz-lg)", lineHeight: 1.5 }}>{children}</div>
      </div>
    </div>
  );
}
