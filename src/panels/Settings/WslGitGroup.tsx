// The `Git (WSL)` settings group: a COMPLETE, separate git configuration
// surface per WSL distribution — its git binary, identity, signing, credential
// helper, and line endings, all written to that distribution's own config.
//
// It is deliberately not a subsection of the `Git` group: a WSL repo's git
// configuration has nothing to do with the app machine's, and mixing them made
// "Identity, signing & credentials (global)" look like it applied to WSL repos
// when it never did.
//
// The group owns its own `SettingsGroup` so it can render NOTHING at all when
// no distributions exist (a `SettingsGroup` shows its header even when every
// child returns null, which would leave every non-Windows build with an empty
// "GIT (WSL)" heading).

import { useEffect, useRef, useState } from "react";
import { formatAppError } from "../../lib/types";
import type { WslDistro } from "../../lib/types";
import { setWslHostGitPath, wslHostGitOverride, wslListDistros } from "../../lib/commands";
import { Button } from "../shared/buttons";
import { useDelayedBusy } from "../shared/useDelayedBusy";
import { Section, Row, FieldNote, SettingsGroup } from "./primitives";
import { GitStatusReadout } from "./GitStatusReadout";
import { GlobalGitConfigSection } from "./GlobalGitConfigSection";
import { LineEndingsGlobalSection } from "./LineEndingsGlobalSection";
import { WslHostProvider, useWslHost } from "./WslHostContext";

export function WslGitGroup() {
  const [distros, setDistros] = useState<WslDistro[]>([]);

  useEffect(() => {
    let cancelled = false;
    wslListDistros()
      .then((list) => {
        if (!cancelled) setDistros(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (distros.length === 0) return null;

  return (
    // The provider sits OUTSIDE the group: `SettingsGroup` unmounts its
    // children when collapsed, and the "already connected" memory must not be
    // lost there — otherwise every expand restarts the distro.
    <WslHostProvider distros={distros}>
      <SettingsGroup id="git-wsl" title="Git (WSL)" caption="Integration & configuration">
        <WslGitGroupBody />
      </SettingsGroup>
    </WslHostProvider>
  );
}

function WslGitGroupBody() {
  const {
    distros,
    distro,
    setDistro,
    running,
    everConnected,
    status,
    reloadNonce,
    connect,
    busy,
    error,
    scope,
  } = useWslHost();

  // An already-running distro loads without a click (connecting to it costs
  // nothing extra); a stopped one waits, because connecting STARTS it.
  const autoConnected = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!running || everConnected || busy || autoConnected.current.has(distro)) return;
    autoConnected.current.add(distro);
    connect();
  }, [distro, running, everConnected, busy, connect]);

  const lost = status === "disconnected";

  return (
    <>
      <Row
        label="Distribution"
        value={
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <select value={distro} onChange={(e) => setDistro(e.target.value)}>
              {distros.map((d) => (
                <option key={d.name} value={d.name}>
                  {d.name}
                  {d.is_default ? " (default)" : ""}
                </option>
              ))}
            </select>
            <ConnectionState />
            <Button onClick={connect} disabled={busy}>
              {busy ? "Connecting…" : everConnected ? "Reconnect" : "Connect"}
            </Button>
          </div>
        }
      />
      <FieldNote>
        Connecting starts the distribution if it is stopped. Nothing here is read or written until
        you connect.
      </FieldNote>
      {error && <pre className="legit-error">{error}</pre>}

      <div style={{ marginTop: 14 }}>
        <WslGitExecutableSection />
        {/* `key={distro}` remounts the forms on a distro switch, so a draft
            typed for one distribution can never be saved into another. */}
        <GlobalGitConfigSection
          key={`config-${distro}`}
          scope={scope}
          enabled={everConnected}
          reloadNonce={reloadNonce}
          disabled={lost}
        />
        <LineEndingsGlobalSection
          key={`eol-${distro}`}
          scope={scope}
          enabled={everConnected}
          reloadNonce={reloadNonce}
          disabled={lost}
        />
      </div>

      <FieldNote>
        Connected accounts and Git identity profiles are LeGit&apos;s own and already apply to
        repositories inside WSL — they live under <strong>Git</strong> above. SSH keys inside a
        distribution are managed there, not by LeGit.
      </FieldNote>
    </>
  );
}

/** Connectivity of the selected distribution, in words (never colour alone). */
function ConnectionState() {
  const { status, running, busy } = useWslHost();
  const [text, token] = ((): [string, string] => {
    if (busy) return ["connecting…", "var(--subtle-fg)"];
    switch (status) {
      case "connected":
        return ["connected", "var(--success-fg)"];
      case "connecting":
        return ["connecting…", "var(--subtle-fg)"];
      case "disconnected":
        return ["connection lost", "var(--error-fg)"];
      default:
        return [running ? "not connected" : "stopped", "var(--subtle-fg)"];
    }
  })();
  return <span style={{ fontSize: "var(--fz-sm)", color: token }}>{text}</span>;
}

/**
 * The distribution's git binary. Mirrors the app machine's section, except the
 * path names a binary INSIDE the distro — so there is no `Browse…`: the file
 * dialog would browse Windows.
 */
function WslGitExecutableSection() {
  const { distro, gitStatus, setGitStatus, busy: connecting } = useWslHost();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { busy: applying, run } = useDelayedBusy();

  // Prefill from the persisted override — cheap, and deliberately no connect.
  useEffect(() => {
    let cancelled = false;
    wslHostGitOverride(distro)
      .then((ov) => {
        if (!cancelled) setDraft(ov ?? "");
      })
      .catch(() => {
        if (!cancelled) setDraft("");
      });
    return () => {
      cancelled = true;
    };
  }, [distro]);

  const apply = (path: string | null) =>
    void run(async () => {
      setError(null);
      try {
        const s = await setWslHostGitPath(distro, path);
        setGitStatus(s);
        setDraft(s.user_override ?? "");
      } catch (e) {
        setError(formatAppError(e));
      }
    });

  const busy = applying || connecting;

  return (
    <Section title={`Git executable in ${distro}`}>
      {gitStatus ? (
        <GitStatusReadout status={gitStatus} />
      ) : (
        <Row
          label="Version"
          value={
            <span className="legit-subtle">
              {connecting ? "Probing git…" : "not checked yet — press Connect"}
            </span>
          }
        />
      )}
      <FieldNote>writes to: hosts settings (all repositories in {distro})</FieldNote>
      <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
        <input
          style={{ flex: 1, fontFamily: "monospace" }}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="git from the distro's PATH — or e.g. /usr/local/bin/git"
        />
        <Button
          variant="primary"
          disabled={busy}
          onClick={() => apply(draft.trim() === "" ? null : draft.trim())}
        >
          Apply
        </Button>
        <button onClick={() => apply(null)} disabled={busy}>
          Reset
        </button>
      </div>
      {error && <pre className="legit-error">{error}</pre>}
    </Section>
  );
}
