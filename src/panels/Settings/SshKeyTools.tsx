// SSH key tools: phase 1 of the SSH-first platform integrations
// (BACKLOG.md). Shared by the profile editor (per-profile keys wired into
// `auth_ssh_key`) and the global git-config form (ssh's DEFAULT keys in
// ~/.ssh, which every repo uses automatically: no git config involved).
//
// Key type is per-platform: Ed25519 for GitHub/GitLab, RSA for Azure DevOps
// (ADO accepts only RSA with rsa-sha2 signatures). Keys are still generated
// without a passphrase (the generation form doesn't offer one yet), but
// passphrase-protected keys now WORK: the SSH_ASKPASS shim prompts in-app.

import { Fragment, useCallback, useEffect, useState } from "react";
import { formatAppError } from "../../lib/types";
import type { ConnectedAccountStatus, SshKeyStatus, SshTestOutcome } from "../../lib/types";
import {
  defaultSshKeysStatus,
  generateSshKey,
  listConnectedAccounts,
  openPlatformKeySettings,
  sshKeyStatus,
  testSshAuth,
  uploadSshKeyToPlatform,
} from "../../lib/commands";
import { copyText } from "../../lib/clipboard";
import { Button } from "../shared/buttons";
import { useDelayedBusy } from "../shared/useDelayedBusy";
import { FieldNote } from "./primitives";

export const SSH_PLATFORMS = [
  { id: "github", label: "GitHub", host: "github.com", keyType: "ed25519" as const },
  { id: "gitlab", label: "GitLab", host: "gitlab.com", keyType: "ed25519" as const },
  { id: "azure_devops", label: "Azure DevOps", host: "ssh.dev.azure.com", keyType: "rsa" as const },
];

/**
 * Shared grid for the key-tool rows: name/label column, key-type column,
 * content column. One grid per section keeps the buttons, selects, and key
 * previews vertically aligned across rows (separate flex rows drift apart
 * because each label has a different width).
 */
const TOOL_GRID: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "max-content max-content minmax(0, 1fr)",
  columnGap: 8,
  rowGap: 6,
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
        gap: 6,
        flexWrap: "wrap",
        minWidth: 0,
      }}
    >
      {children}
    </div>
  );
}

/**
 * "Add the key: …" row (grid cells: label + content; render inside
 * TOOL_GRID). With a connected account (Global Settings, Connected
 * accounts) GitHub/GitLab become one-click uploads via the platform API;
 * otherwise (and always for Azure DevOps, which has no SSH-key API) the
 * button opens the platform's add-key settings page in the browser.
 */
function PlatformKeyTargets({
  candidates,
}: {
  /** Uploadable keys, preferred first; empty = deep links only. */
  candidates: { publicKey: string; title: string }[];
}) {
  const [accounts, setAccounts] = useState<ConnectedAccountStatus[]>([]);
  const [uploaded, setUploaded] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useDelayedBusy();

  useEffect(() => {
    listConnectedAccounts().then(setAccounts).catch(() => setAccounts([]));
  }, []);

  const candidate = candidates[0] ?? null;
  const canUpload = (id: string) =>
    id !== "azure_devops" &&
    candidate !== null &&
    accounts.some((a) => a.account.platform === id && a.token_present);

  const upload = (id: string) =>
    run(async () => {
      if (!candidate) return;
      setError(null);
      try {
        await uploadSshKeyToPlatform(id, candidate.title, candidate.publicKey);
        setUploaded((u) => ({ ...u, [id]: true }));
      } catch (e) {
        setError(formatAppError(e));
      }
    });

  const openPage = (id: string) => {
    setError(null);
    openPlatformKeySettings(id).catch((e) => setError(formatAppError(e)));
  };

  return (
    <>
      <RowLabel>Add the key:</RowLabel>
      <RowContent>
        {SSH_PLATFORMS.map((p) =>
          canUpload(p.id) ? (
            <button
              key={p.id}
              disabled={busy || uploaded[p.id]}
              title={`Upload to your connected ${p.label} account`}
              onClick={() => upload(p.id)}
            >
              {uploaded[p.id] ? `${p.label}: uploaded` : `Upload to ${p.label}`}
            </button>
          ) : (
            <button
              key={p.id}
              title={`Open the ${p.label} SSH-key settings page in the browser`}
              onClick={() => openPage(p.id)}
            >
              {p.label}…
            </button>
          ),
        )}
      </RowContent>
      {error && (
        <pre className="legit-error" style={{ margin: 0, gridColumn: "1 / -1" }}>{error}</pre>
      )}
    </>
  );
}

/** Upload title for a key: the file name plus where it came from. */
function keyTitle(privateKeyPath: string): string {
  const base = privateKeyPath.split(/[\\/]/).pop() ?? privateKeyPath;
  return `${base} (LeGit)`;
}

/** Host picker + Test button + classified result line (grid cells: label +
 *  content + optional result row; render inside TOOL_GRID). */
function SshTestRow({ privateKeyPath }: { privateKeyPath: string | null }) {
  const [host, setHost] = useState(SSH_PLATFORMS[0].host);
  const [result, setResult] = useState<SshTestOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useDelayedBusy();

  const test = () =>
    run(async () => {
      setError(null);
      setResult(null);
      try {
        setResult(await testSshAuth(host, privateKeyPath));
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
          <span className="legit-subtle" style={{ marginLeft: 6 }}>{firstLine}</span>
        )}
      </div>
    );
  };

  return (
    <>
      <RowLabel>Test connection:</RowLabel>
      <RowContent>
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
    sshKeyStatus(privateKeyPath)
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
    <div style={{ ...TOOL_GRID, marginTop: 4 }}>
      {status.public_key ? (
        <>
          <RowLabel>Public key:</RowLabel>
          <RowContent>
            <CopyPublicKeyButton publicKey={status.public_key} />
            <PublicKeyPreview publicKey={status.public_key} />
          </RowContent>
          <PlatformKeyTargets
            candidates={[{ publicKey: status.public_key, title: keyTitle(status.private_key_path) }]}
          />
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
}: {
  /** Slug woven into the default file name (e.g. the profile name). */
  nameSlug: string;
  defaultComment: string;
  onGenerated: (privateKeyPath: string) => void;
  onCancel: () => void;
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

  const generate = () =>
    run(async () => {
      setError(null);
      try {
        const status = await generateSshKey(fileName.trim(), keyType, comment.trim());
        onGenerated(status.private_key_path);
      } catch (e) {
        setError(formatAppError(e));
      }
    });

  return (
    <div
      style={{
        marginTop: 6,
        padding: "8px 10px",
        border: "1px solid var(--panel-border)",
        borderRadius: 4,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        {(
          [
            ["ed25519", "Ed25519 (GitHub, GitLab)"],
            ["rsa", "RSA 4096 (required by Azure DevOps)"],
          ] as const
        ).map(([t, label]) => (
          <label key={t} style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
            <input type="radio" checked={keyType === t} onChange={() => selectType(t)} disabled={busy} />
            <code style={{ fontSize: "var(--fz-md)" }}>{label}</code>
          </label>
        ))}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
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
      <div style={{ display: "flex", gap: 6 }}>
        <Button variant="primary" disabled={busy || fileName.trim() === ""} onClick={generate}>
          {busy ? "Generating…" : "Generate key"}
        </Button>
        <button onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
      {error && <pre className="legit-error" style={{ margin: 0 }}>{error}</pre>}
    </div>
  );
}

const DEFAULT_KEY_LABELS: Record<string, string> = {
  id_ed25519: "Ed25519 (GitHub, GitLab)",
  id_rsa: "RSA 4096 (required by Azure DevOps)",
};

/**
 * The "global" SSH identity for the global git-config form: ssh's default
 * keys in ~/.ssh, which every repo uses automatically. Filesystem-only:
 * nothing here reads or writes git config, and everything acts immediately
 * (independent of the form's Save).
 */
export function DefaultSshKeysField() {
  const [keys, setKeys] = useState<SshKeyStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useDelayedBusy();

  const load = useCallback(() => {
    defaultSshKeysStatus()
      .then(setKeys)
      .catch((e) => setError(formatAppError(e)));
  }, []);

  useEffect(() => { load(); }, [load]);

  const generateDefault = (fileName: string, keyType: "ed25519" | "rsa") =>
    run(async () => {
      setError(null);
      try {
        await generateSshKey(fileName, keyType, "");
        load();
      } catch (e) {
        setError(formatAppError(e));
      }
    });

  if (!keys) return <span className="legit-subtle">Checking ~/.ssh…</span>;

  const anyKey = keys.some((k) => k.exists);

  return (
    <div style={TOOL_GRID}>
      {keys.map((k) => {
        const base = k.private_key_path.split(/[\\/]/).pop() ?? k.private_key_path;
        const keyType = base === "id_rsa" ? "rsa" : "ed25519";
        return (
          <Fragment key={k.private_key_path}>
            <code style={{ fontSize: "var(--fz-md)", whiteSpace: "nowrap" }}>{base}</code>
            <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)", whiteSpace: "nowrap" }}>
              {DEFAULT_KEY_LABELS[base] ?? ""}
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
              {k.exists && k.public_key ? (
                <>
                  <CopyPublicKeyButton publicKey={k.public_key} />
                  <PublicKeyPreview publicKey={k.public_key} />
                </>
              ) : k.exists ? (
                <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)" }}>
                  exists (no readable .pub)
                </span>
              ) : (
                <button disabled={busy} onClick={() => generateDefault(base, keyType)}>
                  {busy ? "Generating…" : "Generate"}
                </button>
              )}
            </div>
          </Fragment>
        );
      })}
      {anyKey && (
        <>
          <PlatformKeyTargets
            candidates={keys
              .filter((k) => k.public_key)
              .map((k) => ({
                publicKey: k.public_key!,
                title: keyTitle(k.private_key_path),
              }))}
          />
          <SshTestRow privateKeyPath={null} />
        </>
      )}
      <div style={{ gridColumn: "1 / -1" }}>
        <FieldNote>
          ssh uses these keys automatically for every repo: nothing is written to
          git config, and these actions apply immediately (they are not part of
          Save). A profile's own key overrides them for its repos.
        </FieldNote>
      </div>
      {error && (
        <pre className="legit-error" style={{ margin: 0, gridColumn: "1 / -1" }}>{error}</pre>
      )}
    </div>
  );
}
