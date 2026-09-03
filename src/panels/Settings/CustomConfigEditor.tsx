// Repo-scope twin of GlobalGitConfigSection: ONE bordered form, one Save with
// an explicit confirm listing every key change, empty field = unset (the key
// falls back to the inherited value shown per field). Covers all 8 profile
// keys, including the auth SSH key (repo scope is where SSH auth belongs).

import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { usePanelDirty } from "../PanelApiContext";
import { WarningIcon } from "../../icons";
import { formatAppError } from "../../lib/types";
import type { ManagedKeys, ProfileStatus } from "../../lib/types";
import { writeRepoManagedConfig } from "../../lib/commands";
import { Button } from "../shared/buttons";
import { useDelayedBusy } from "../shared/useDelayedBusy";
import { FieldNote } from "./primitives";
import { CredentialHelperField } from "./CredentialHelperField";
import { GenerateSshKeyForm, SshKeyActions } from "./SshKeyTools";
import { Field, WithBrowse, profileNameSlug } from "./GlobalProfilesSection";
import { RadioGroup, GPGSIGN_OPTIONS, FORMAT_OPTIONS } from "./SigningSettings";

interface ChangeItem { key: string; before: string | null; after: string | null }

export function CustomConfigEditor({
  repoId,
  repoName,
  local,
  inherited,
  onSaved,
}: {
  repoId: string;
  repoName: string;
  local: ManagedKeys;
  inherited: ManagedKeys;
  onSaved: (s: ProfileStatus) => void;
}) {
  const [name, setName] = useState(local.user_name ?? "");
  const [email, setEmail] = useState(local.user_email ?? "");
  const [gpgsign, setGpgsign] = useState<string | null>(local.commit_gpgsign);
  const [format, setFormat] = useState<string | null>(local.gpg_format);
  const [signingKey, setSigningKey] = useState(local.signing_key ?? "");
  const [allowedSigners, setAllowedSigners] = useState(local.allowed_signers_file ?? "");
  const [authKey, setAuthKey] = useState(local.auth_ssh_key ?? "");
  const [helper, setHelper] = useState(local.credential_helper ?? "");
  const [showGenerateKey, setShowGenerateKey] = useState(false);
  const { busy: saving, run } = useDelayedBusy();
  const [confirmPending, setConfirmPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const norm = (v: string) => (v.trim() === "" ? null : v.trim());

  const draft: ManagedKeys = {
    user_name: norm(name),
    user_email: norm(email),
    gpg_format: format,
    signing_key: norm(signingKey),
    commit_gpgsign: gpgsign,
    allowed_signers_file: norm(allowedSigners),
    auth_ssh_key: norm(authKey),
    credential_helper: norm(helper),
  };

  // Change list computed client-side, exactly like GlobalGitConfigSection;
  // the backend re-diffs against live local config on write.
  const changes: ChangeItem[] = [];
  const push = (key: string, before: string | null, after: string | null) => {
    if (before !== after) changes.push({ key, before, after });
  };
  push("user.name", local.user_name, draft.user_name);
  push("user.email", local.user_email, draft.user_email);
  push("commit.gpgsign", local.commit_gpgsign, draft.commit_gpgsign);
  push("gpg.format", local.gpg_format, draft.gpg_format);
  push("user.signingkey", local.signing_key, draft.signing_key);
  push("gpg.ssh.allowedSignersFile", local.allowed_signers_file, draft.allowed_signers_file);
  push("core.sshCommand (auth key)", local.auth_ssh_key, draft.auth_ssh_key);
  push("credential.helper", local.credential_helper, draft.credential_helper);

  const dirty = changes.length > 0;
  usePanelDirty(dirty, "repo-custom-config");

  const isSsh = (format ?? inherited.gpg_format) === "ssh";

  const inheritPlaceholder = (v: string | null, fallback: string) =>
    v ? `inherits: ${v}` : fallback;

  const handleConfirm = () =>
    run(async () => {
      setConfirmPending(false);
      setError(null);
      try {
        const s = await writeRepoManagedConfig(repoId, draft);
        onSaved(s);
      } catch (e) {
        setError(formatAppError(e));
      }
    });

  const handleCancel = () => {
    setName(local.user_name ?? "");
    setEmail(local.user_email ?? "");
    setGpgsign(local.commit_gpgsign);
    setFormat(local.gpg_format);
    setSigningKey(local.signing_key ?? "");
    setAllowedSigners(local.allowed_signers_file ?? "");
    setAuthKey(local.auth_ssh_key ?? "");
    setHelper(local.credential_helper ?? "");
  };

  const browseInto = async (set: (v: string) => void) => {
    const selected = await openDialog({ multiple: false });
    if (typeof selected === "string") set(selected);
  };

  return (
    <div
      style={{
        marginTop: 10,
        padding: "10px 12px",
        border: "1px solid var(--panel-border)",
        borderRadius: 4,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <Field label="user.name">
        <input
          value={name}
          placeholder={inheritPlaceholder(inherited.user_name, "Your Name")}
          onChange={(e) => setName(e.target.value)}
          disabled={saving}
        />
      </Field>
      <Field label="user.email">
        <input
          value={email}
          placeholder={inheritPlaceholder(inherited.user_email, "you@example.com")}
          onChange={(e) => setEmail(e.target.value)}
          disabled={saving}
        />
      </Field>
      <Field label="commit.gpgsign">
        <RadioGroup
          name="repo-custom-gpgsign"
          value={gpgsign}
          options={GPGSIGN_OPTIONS}
          onChange={setGpgsign}
          disabled={saving}
        />
      </Field>
      <Field label="gpg.format">
        <RadioGroup
          name="repo-custom-format"
          value={format}
          options={FORMAT_OPTIONS}
          onChange={setFormat}
          disabled={saving}
        />
      </Field>
      <Field label="user.signingkey">
        <WithBrowse
          value={signingKey}
          onChange={setSigningKey}
          onBrowse={() => browseInto(setSigningKey)}
          placeholder={isSsh ? "Path to SSH key (or literal public key)" : "GPG key id"}
        />
      </Field>
      {isSsh && (
        <Field label="gpg.ssh.allowedSignersFile">
          <WithBrowse
            value={allowedSigners}
            onChange={setAllowedSigners}
            onBrowse={() => browseInto(setAllowedSigners)}
            placeholder="Path to allowed signers file"
          />
        </Field>
      )}
      <Field label="Auth SSH key (core.sshCommand)">
        <WithBrowse
          value={authKey}
          onChange={setAuthKey}
          onBrowse={() => browseInto(setAuthKey)}
          placeholder="Path to SSH private key (for push/pull)"
        />
        {norm(authKey) && !showGenerateKey && <SshKeyActions privateKeyPath={authKey.trim()} />}
        {showGenerateKey ? (
          <GenerateSshKeyForm
            nameSlug={profileNameSlug(repoName)}
            defaultComment={norm(email) ?? ""}
            onGenerated={(path) => {
              setAuthKey(path);
              setShowGenerateKey(false);
            }}
            onCancel={() => setShowGenerateKey(false)}
          />
        ) : (
          <div>
            <button onClick={() => setShowGenerateKey(true)} disabled={saving}>
              Generate new key…
            </button>
          </div>
        )}
      </Field>
      <Field label="credential.helper (HTTPS)">
        <CredentialHelperField value={helper} onChange={setHelper} disabled={saving} />
        <FieldNote>
          Set here, this overrides any inherited (global/system) helper for this repo.
        </FieldNote>
      </Field>

      {confirmPending && (
        <div style={{ padding: "10px 12px", background: "var(--button-hover-bg)", border: "1px solid var(--panel-border)", borderRadius: 4 }}>
          <div style={{ fontWeight: 600, marginBottom: 6, display: "flex", alignItems: "center", gap: 6 }}>
            <WarningIcon /> Save these changes to this repo's .git/config?
          </div>
          <div style={{ marginBottom: 8, fontSize: "var(--fz-md)" }}>
            {changes.map((c) => (
              <div key={c.key} style={{ fontFamily: "monospace" }}>
                <code>{c.key}</code>: <code>{c.before ?? "unset"}</code> → <code>{c.after ?? "unset"}</code>
              </div>
            ))}
          </div>
          <div style={{ fontSize: "var(--fz-md)", color: "var(--subtle-fg)", marginBottom: 10 }}>
            These writes affect only this repository. Unset keys keep inheriting
            your global config.
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <Button variant="primary" onClick={handleConfirm} disabled={saving}>Save</Button>
            <button onClick={() => setConfirmPending(false)} disabled={saving}>Cancel</button>
          </div>
        </div>
      )}

      {!confirmPending && (
        <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
          <Button variant="primary" disabled={!dirty || saving} onClick={() => setConfirmPending(true)}>
            Save
          </Button>
          <button disabled={!dirty || saving} onClick={handleCancel}>
            Cancel
          </button>
        </div>
      )}

      {error && <pre className="legit-error">{error}</pre>}
    </div>
  );
}
