// The `Git (WSL)` settings sections: a COMPLETE, separate git configuration
// surface per WSL distribution — its git binary, identity, signing, credential
// helper, and line endings, all written to that distribution's own config.
//
// It is deliberately not part of the `Git` group: a WSL repo's git
// configuration has nothing to do with the app machine's, and mixing them made
// "Identity, signing & credentials (global)" look like it applied to WSL repos
// when it never did.
//
// The sections are consumed through the settings manifest; the panel includes
// the group only when distributions exist (so non-Windows builds never show an
// empty "GIT (WSL)" heading) and mounts `WslHostProvider` OUTSIDE the shell:
// sections unmount when a search filters them away, and the "already
// connected" memory must not be lost there — otherwise every re-mount would
// restart the distro.

import { useEffect, useState } from "react";
import { formatAppError } from "../../lib/errors";
import type { WslDistro } from "../../lib/types";
import { api } from "../../lib/commands";
import { Button } from "../shared/buttons";
import { useDelayedBusy } from "../shared/useDelayedBusy";
import { Section, Row, FieldNote } from "./primitives";
import { GitStatusReadout } from "./GitStatusReadout";
import { GlobalGitConfigSection } from "./GlobalGitConfigSection";
import { LineEndingsGlobalSection } from "./LineEndingsGlobalSection";
import { useWslHost } from "./WslHostContext";

/** One cheap `wsl --list` probe; empty on machines without WSL. */
export function useWslDistros(): WslDistro[] {
  const [distros, setDistros] = useState<WslDistro[]>([]);

  useEffect(() => {
    let cancelled = false;
    api.wslListDistros()
      .then((list) => {
        if (!cancelled) setDistros(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return distros;
}

export function WslConnectionSection() {
  const { distros, distro, setDistro, everConnected, connect, busy, error } = useWslHost();

  return (
    <Section title="Distribution">
      <Row
        label="Distribution"
        value={
          <div style={{ display: "flex", alignItems: "center", gap: "0.667em", flexWrap: "wrap" }}>
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
      <FieldNote>
        Connected accounts and Git identity profiles are LeGit&apos;s own and already apply to
        repositories inside WSL — they live under <strong>Git</strong> above. SSH keys inside a
        distribution are managed there, not by LeGit.
      </FieldNote>
    </Section>
  );
}

/** Identity, signing & credentials written into the selected distribution. */
export function WslConfigSection() {
  const { distro, scope, everConnected, reloadNonce, status } = useWslHost();
  return (
    // `key={distro}` remounts the form on a distro switch, so a draft typed
    // for one distribution can never be saved into another.
    <GlobalGitConfigSection
      key={`config-${distro}`}
      scope={scope}
      enabled={everConnected}
      reloadNonce={reloadNonce}
      disabled={status === "disconnected"}
    />
  );
}

/** Line endings written into the selected distribution. */
export function WslEolSection() {
  const { distro, scope, everConnected, reloadNonce, status } = useWslHost();
  return (
    <LineEndingsGlobalSection
      key={`eol-${distro}`}
      scope={scope}
      enabled={everConnected}
      reloadNonce={reloadNonce}
      disabled={status === "disconnected"}
    />
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
export function WslGitExecutableSection() {
  const { distro, gitStatus, setGitStatus, busy: connecting } = useWslHost();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { busy: applying, run } = useDelayedBusy();

  // Prefill from the persisted override — cheap, and deliberately no connect.
  useEffect(() => {
    let cancelled = false;
    api.wslHostGitOverride(distro)
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
        const s = await api.setWslHostGitPath(distro, path);
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
      <div style={{ display: "flex", gap: "0.5em", marginTop: "0.667em" }}>
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
