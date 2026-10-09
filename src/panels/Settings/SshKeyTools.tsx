// SSH key tools: phase 1 of the SSH-first platform integrations
// (BACKLOG.md). Key MANAGEMENT lives here - the SSH keys settings section
// (every pair in ~/.ssh: copy, generate, test; no git config involved) and
// the pieces the profile editor reuses for keys wired into `auth_ssh_key`.
// The account-facing upload/registered state lives in Connected accounts.
//
// Key type is per-platform: Ed25519 for GitHub/GitLab, RSA for Azure DevOps
// (ADO accepts only RSA with rsa-sha2 signatures). Keys are still generated
// without a passphrase (the generation form doesn't offer one yet), but
// passphrase-protected keys now WORK: the SSH_ASKPASS shim prompts in-app.

import { Fragment, useCallback, useEffect, useState } from "react";
import { formatAppError } from "../../lib/errors";
import type { SshKeyStatus, SshTestOutcome } from "../../lib/types";
import { api } from "../../lib/commands";
import { copyText } from "../../lib/clipboard";
import { Button } from "../shared/buttons";
import { useDelayedBusy } from "../shared/useDelayedBusy";
import { FieldNote } from "./primitives";

export const SSH_PLATFORMS = [
  { id: "github", label: "GitHub", host: "github.com", keyType: "ed25519" as const },
  { id: "gitlab", label: "GitLab", host: "gitlab.com", keyType: "ed25519" as const },
  { id: "azure_devops", label: "Azure DevOps", host: "ssh.dev.azure.com", keyType: "rsa" as const },
];

/** WHOSE `~/.ssh` the key tools operate on: the app machine's (default), or
 *  a WSL distribution's through its agent. */
export interface SshKeysHostApi {
  scan: () => Promise<SshKeyStatus[]>;
  generate: (fileName: string, keyType: "ed25519" | "rsa", comment: string) => Promise<SshKeyStatus>;
  testSsh: (host: string, privateKeyPath: string | null) => Promise<SshTestOutcome>;
}

export const LOCAL_SSH_KEYS_API: SshKeysHostApi = {
  scan: () => api.scanSshKeys(),
  generate: (fileName, keyType, comment) => api.generateSshKey(fileName, keyType, comment),
  testSsh: (host, privateKeyPath) => api.testSshAuth(host, privateKeyPath),
};

export function wslSshKeysApi(distro: string): SshKeysHostApi {
  return {
    scan: () => api.wslScanSshKeys(distro),
    generate: (fileName, keyType, comment) =>
      api.wslGenerateSshKey(distro, fileName, keyType, comment),
    testSsh: (host, privateKeyPath) => api.wslTestSshAuth(distro, host, privateKeyPath),
  };
}

/**
 * Shared grid for the key-tool rows: name/label column, key-type column,
 * content column. One grid per section keeps the buttons, selects, and key
 * previews vertically aligned across rows (separate flex rows drift apart
 * because each label has a different width).
 */
const TOOL_GRID: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "max-content max-content minmax(0, 1fr)",
  columnGap: "0.667em",
  rowGap: "0.5em",
  alignItems: "center",
};

/** First-column label of a grid row. */
function RowLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)", whiteSpace: "nowrap" }}>
      {children}
    </span>
  );
}

/** Row content spanning the remaining grid columns. */
function RowContent({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        gridColumn: "2 / -1",
        display: "flex",
        alignItems: "center",
        gap: "0.5em",
        flexWrap: "wrap",
        minWidth: 0,
      }}
    >
      {children}
    </div>
  );
}

/** Upload title for a key: the file name plus where it came from - the
 *  machine (and distro) part is what keeps same-named keys uploaded from
 *  different computers apart in the platform's key list. */
export function keyTitle(privateKeyPath: string, machine: string, distro?: string | null): string {
  const base = privateKeyPath.split(/[\\/]/).pop() ?? privateKeyPath;
  const where = distro ? `${machine} wsl:${distro}` : machine;
  return `${base} (LeGit, ${where})`;
}

/** Host picker + Test button + classified result line (grid cells: label +
 *  content + optional result row; render inside TOOL_GRID). With `keys`, a
 *  key picker ("Automatic" = ssh's own selection) replaces the fixed
 *  `privateKeyPath`. */
function SshTestRow({
  privateKeyPath,
  keys,
  runTest = LOCAL_SSH_KEYS_API.testSsh,
}: {
  privateKeyPath: string | null;
  keys?: SshKeyStatus[];
  /** The host's probe; defaults to the app machine's. */
  runTest?: SshKeysHostApi["testSsh"];
}) {
  const [host, setHost] = useState(SSH_PLATFORMS[0].host);
  const [keyPath, setKeyPath] = useState("");
  const [result, setResult] = useState<SshTestOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useDelayedBusy();

  const effectiveKey = keys ? keyPath || null : privateKeyPath;

  const test = () =>
    run(async () => {
      setError(null);
      setResult(null);
      try {
        setResult(await runTest(host, effectiveKey));
      } catch (e) {
        setError(formatAppError(e));
      }
    });

  const outcomeLine = (r: SshTestOutcome) => {
    const [color, text] =
      r.kind === "authenticated"
        ? ["var(--success-fg)", "Authenticated"]
        : r.kind === "rejected"
          ? ["var(--error-fg)", "Key rejected (add the public key to your account)"]
          : r.kind === "cannot_connect"
            ? ["var(--warning-fg)", "Cannot reach the host"]
            : ["var(--warning-fg)", "Unclear result"];
    const firstLine = r.detail.split("\n").find((l) => l.trim() !== "") ?? "";
    return (
      <div style={{ fontSize: "var(--fz-sm)", gridColumn: "2 / -1", minWidth: 0 }}>
        <span style={{ color, fontWeight: 600 }}>{text}</span>
        {firstLine && (
          <span className="legit-subtle" style={{ marginLeft: "0.5em" }}>{firstLine}</span>
        )}
      </div>
    );
  };

  return (
    <>
      <RowLabel>Test connection:</RowLabel>
      <RowContent>
        {keys && (
          <select value={keyPath} onChange={(e) => setKeyPath(e.target.value)} disabled={busy}>
            <option value="">Automatic</option>
            {keys.filter((k) => k.exists).map((k) => (
              <option key={k.private_key_path} value={k.private_key_path}>
                {k.private_key_path.split(/[\\/]/).pop()}
              </option>
            ))}
          </select>
        )}
        <select value={host} onChange={(e) => setHost(e.target.value)} disabled={busy}>
          {SSH_PLATFORMS.map((p) => (
            <option key={p.host} value={p.host}>{p.label}</option>
          ))}
        </select>
        <button onClick={test} disabled={busy}>{busy ? "Testing…" : "Test"}</button>
      </RowContent>
      {result && outcomeLine(result)}
      {error && (
        <pre className="legit-error" style={{ margin: 0, gridColumn: "1 / -1" }}>{error}</pre>
      )}
    </>
  );
}

/** "Copy public key" button with a transient copied state. */
function CopyPublicKeyButton({ publicKey }: { publicKey: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await copyText(publicKey);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* both clipboard paths failed; the key is still visible to select */
    }
  };
  return <button onClick={copy}>{copied ? "Copied!" : "Copy public key"}</button>;
}

/** One-line ellipsised public-key preview (full key in the tooltip). */
function PublicKeyPreview({ publicKey }: { publicKey: string }) {
  return (
    <code
      style={{
        fontSize: "var(--fz-sm)",
        color: "var(--subtle-fg)",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        minWidth: 0,
      }}
      title={publicKey}
    >
      {publicKey}
    </code>
  );
}

/**
 * Actions for an existing key path (profile editor): public-key copy,
 * platform deep links, connection test pinned to that key.
 */
export function SshKeyActions({ privateKeyPath }: { privateKeyPath: string }) {
  const [status, setStatus] = useState<SshKeyStatus | null>(null);

  useEffect(() => {
    let stale = false;
    api.sshKeyStatus(privateKeyPath)
      .then((s) => { if (!stale) setStatus(s); })
      .catch(() => { if (!stale) setStatus(null); });
    return () => { stale = true; };
  }, [privateKeyPath]);

  if (!status) return null;
  if (!status.exists && !status.public_key) {
    return (
      <FieldNote>
        No key file found at this path{status.private_key_path ? <> (<code>{status.private_key_path}</code>)</> : null}.
      </FieldNote>
    );
  }
  return (
    <div style={{ ...TOOL_GRID, marginTop: "0.333em" }}>
      {status.public_key ? (
        <>
          <RowLabel>Public key:</RowLabel>
          <RowContent>
            <CopyPublicKeyButton publicKey={status.public_key} />
            <PublicKeyPreview publicKey={status.public_key} />
          </RowContent>
        </>
      ) : (
        <div style={{ gridColumn: "1 / -1" }}>
          <FieldNote>
            The private key exists but <code>{status.private_key_path}.pub</code> is
            missing, so the public key can't be shown here.
          </FieldNote>
        </div>
      )}
      <SshTestRow privateKeyPath={status.private_key_path} />
    </div>
  );
}

/** Inline form: key type + file name + comment, generated into ~/.ssh. */
export function GenerateSshKeyForm({
  nameSlug,
  defaultComment,
  onGenerated,
  onCancel,
  generate = LOCAL_SSH_KEYS_API.generate,
}: {
  /** Slug woven into the default file name (e.g. the profile name). */
  nameSlug: string;
  defaultComment: string;
  onGenerated: (privateKeyPath: string) => void;
  onCancel: () => void;
  /** The host's keygen; defaults to the app machine's. */
  generate?: SshKeysHostApi["generate"];
}) {
  const defaultName = (type: "ed25519" | "rsa") =>
    nameSlug ? `id_${type}_${nameSlug}` : `id_${type}`;

  const [keyType, setKeyType] = useState<"ed25519" | "rsa">("ed25519");
  const [fileName, setFileName] = useState(defaultName("ed25519"));
  const [nameEdited, setNameEdited] = useState(false);
  const [comment, setComment] = useState(defaultComment);
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useDelayedBusy();

  const selectType = (t: "ed25519" | "rsa") => {
    setKeyType(t);
    // Track the type in the suggested name until the user takes over.
    if (!nameEdited) setFileName(defaultName(t));
  };

  const submit = () =>
    run(async () => {
      setError(null);
      try {
        const status = await generate(fileName.trim(), keyType, comment.trim());
        onGenerated(status.private_key_path);
      } catch (e) {
        setError(formatAppError(e));
      }
    });

  return (
    <div
      style={{
        marginTop: "0.5em",
        padding: "0.667em 0.833em",
        border: "1px solid var(--panel-border)",
        borderRadius: 4,
        display: "flex",
        flexDirection: "column",
        gap: "0.5em",
      }}
    >
      <div style={{ display: "flex", gap: "1em", flexWrap: "wrap" }}>
        {(
          [
            ["ed25519", "Ed25519 (GitHub, GitLab)"],
            ["rsa", "RSA 4096 (required by Azure DevOps)"],
          ] as const
        ).map(([t, label]) => (
          <label key={t} style={{ display: "flex", alignItems: "center", gap: "0.333em", cursor: "pointer" }}>
            <input type="radio" checked={keyType === t} onChange={() => selectType(t)} disabled={busy} />
            <code style={{ fontSize: "var(--fz-md)" }}>{label}</code>
          </label>
        ))}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5em" }}>
        <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)", whiteSpace: "nowrap" }}>~/.ssh/</span>
        <input
          style={{ flex: 1 }}
          value={fileName}
          onChange={(e) => { setFileName(e.target.value); setNameEdited(true); }}
          disabled={busy}
        />
      </div>
      <input
        value={comment}
        placeholder="Comment (usually your email)"
        onChange={(e) => setComment(e.target.value)}
        disabled={busy}
      />
      <FieldNote>
        Created without a passphrase. To add one later, run `ssh-keygen -p` -
        LeGit prompts for protected keys when they are used.
      </FieldNote>
      <div style={{ display: "flex", gap: "0.5em" }}>
        <Button variant="primary" disabled={busy || fileName.trim() === ""} onClick={submit}>
          {busy ? "Generating…" : "Generate key"}
        </Button>
        <button onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
      {error && <pre className="legit-error" style={{ margin: 0 }}>{error}</pre>}
    </div>
  );
}

/**
 * The SSH keys settings section: every key pair found in `~/.ssh` (copy +
 * preview per key), a connection test with a key picker, and the generate
 * form for new pairs (both types). Filesystem-only - nothing here touches
 * git config. Uploading/registering keys lives in Connected accounts;
 * wiring a key into a profile lives in the profile editor.
 */
export function SshKeysSection({
  hostApi = LOCAL_SSH_KEYS_API,
}: {
  /** The machine whose `~/.ssh` this section manages; default = app machine. */
  hostApi?: SshKeysHostApi;
}) {
  const [keys, setKeys] = useState<SshKeyStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showGenerate, setShowGenerate] = useState(false);

  const load = useCallback(() => {
    hostApi
      .scan()
      .then(setKeys)
      .catch((e) => setError(formatAppError(e)));
  }, [hostApi]);

  useEffect(() => { load(); }, [load]);

  if (!keys) return <span className="legit-subtle">Scanning ~/.ssh…</span>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.667em" }}>
      {keys.length === 0 && (
        <FieldNote>No key pairs found in <code>~/.ssh</code>.</FieldNote>
      )}
      <div style={TOOL_GRID}>
        {keys.map((k) => {
          const base = k.private_key_path.split(/[\\/]/).pop() ?? k.private_key_path;
          return (
            <Fragment key={k.private_key_path}>
              <code style={{ fontSize: "var(--fz-md)", whiteSpace: "nowrap" }}>{base}</code>
              <div style={{ gridColumn: "2 / -1", display: "flex", alignItems: "center", gap: "0.5em", minWidth: 0 }}>
                {k.public_key ? (
                  <>
                    <CopyPublicKeyButton publicKey={k.public_key} />
                    <PublicKeyPreview publicKey={k.public_key} />
                  </>
                ) : (
                  <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)" }}>
                    no readable .pub
                  </span>
                )}
                {!k.exists && (
                  <span style={{ color: "var(--warning-fg)", fontSize: "var(--fz-sm)", whiteSpace: "nowrap" }}>
                    private key missing
                  </span>
                )}
              </div>
            </Fragment>
          );
        })}
        <SshTestRow privateKeyPath={null} keys={keys} runTest={hostApi.testSsh} />
      </div>
      {showGenerate ? (
        <GenerateSshKeyForm
          nameSlug=""
          defaultComment=""
          generate={hostApi.generate}
          onGenerated={() => {
            setShowGenerate(false);
            load();
          }}
          onCancel={() => setShowGenerate(false)}
        />
      ) : (
        <div>
          <button onClick={() => setShowGenerate(true)}>Generate key pair…</button>
        </div>
      )}
      <FieldNote>
        ssh uses <code>id_ed25519</code> / <code>id_rsa</code> automatically for every repo; other
        keys apply where a profile&apos;s auth key or a <code>~/.ssh/config</code> entry selects
        them. Registering a key with a platform lives in Connected accounts.
      </FieldNote>
      {error && <pre className="legit-error" style={{ margin: 0 }}>{error}</pre>}
    </div>
  );
}
