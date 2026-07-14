// The ONE global git-config edit form (identity + signing + credential
// helper), styled exactly like the profile editor: same bordered panel, same
// Field rows, a single Save, so it reads as one coherent "~/.gitconfig" edit
// view. Line endings stay in their own section (rarely touched together with
// these).
//
// Edit-only by design (design/2026-07-13-global-default-profile.md): no
// profile can be applied here, and `core.sshCommand` is deliberately absent:
// SSH auth stays per-repo via profiles. The credential helper is written as a
// single plain value (never the empty reset entry), so system-scope helpers
// like Git Credential Manager are never masked: helpers accumulate instead.

import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useState } from "react";
import { usePanelFocusEffect, usePanelDirty } from "../PanelApiContext";
import { WarningIcon } from "../../icons";
import { formatAppError } from "../../lib/types";
import type { CredentialHelperView, IdentityView, ScopedConfig, SigningView } from "../../lib/types";
import {
  globalCredentialHelperView,
  globalIdentityView,
  globalSigningConfig,
  globalWriteCredentialHelper,
  globalWriteIdentity,
  globalWriteSigning,
} from "../../lib/commands";
import { Button } from "../shared/buttons";
import { Section, FieldNote } from "./primitives";
import { CredentialHelperField } from "./CredentialHelperField";
import { DefaultSshKeysField } from "./SshKeyTools";
import { Field, WithBrowse } from "./GlobalProfilesSection";
import {
  ResolvedBadge,
  RadioGroup,
  GPGSIGN_OPTIONS,
  FORMAT_OPTIONS,
} from "./SigningSettings";

interface ChangeItem { key: string; before: string | null; after: string | null }

export function GlobalGitConfigSection() {
  const [identity, setIdentity] = useState<IdentityView | null>(null);
  const [signing, setSigning] = useState<SigningView | null>(null);
  const [helperView, setHelperView] = useState<CredentialHelperView | null>(null);
  const [loading, setLoading] = useState(true);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [gpgsign, setGpgsign] = useState<string | null>(null);
  const [format, setFormat] = useState<string | null>(null);
  const [signingKey, setSigningKey] = useState("");
  const [allowedSigners, setAllowedSigners] = useState("");
  const [helper, setHelper] = useState("");

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmPending, setConfirmPending] = useState(false);

  const resetDrafts = useCallback(
    (id: IdentityView, sg: SigningView, ch: CredentialHelperView) => {
      setName(id.name_global.value ?? "");
      setEmail(id.email_global.value ?? "");
      setGpgsign(sg.gpgsign.global.value ?? null);
      setFormat(sg.format.global.value ?? null);
      setSigningKey(sg.signing_key.global.value ?? "");
      setAllowedSigners(sg.allowed_signers.global.value ?? "");
      setHelper(ch.helper_global ?? "");
    },
    []
  );

  const load = useCallback(() => {
    setLoading(true);
    setConfirmPending(false);
    Promise.all([globalIdentityView(), globalSigningConfig(), globalCredentialHelperView()])
      .then(([id, sg, ch]) => {
        setIdentity(id);
        setSigning(sg);
        setHelperView(ch);
        resetDrafts(id, sg, ch);
      })
      .catch((e) => setError(formatAppError(e)))
      .finally(() => setLoading(false));
  }, [resetDrafts]);

  useEffect(() => { load(); }, [load]);
  usePanelFocusEffect(load);

  // Trimmed drafts; empty = unset the key.
  const norm = (v: string) => (v.trim() === "" ? null : v.trim());
  const normName = norm(name);
  const normEmail = norm(email);
  const normKey = norm(signingKey);
  const normSigners = norm(allowedSigners);
  const normHelper = norm(helper);

  const globalVal = (c: ScopedConfig) => c.global.value ?? null;

  const identityChanged =
    identity !== null &&
    (normName !== (identity.name_global.value ?? null) ||
      normEmail !== (identity.email_global.value ?? null));
  const signingChanged =
    signing !== null &&
    (gpgsign !== globalVal(signing.gpgsign) ||
      format !== globalVal(signing.format) ||
      normKey !== globalVal(signing.signing_key) ||
      normSigners !== globalVal(signing.allowed_signers));
  const helperChanged = helperView !== null && normHelper !== helperView.helper_global;

  const dirty = identityChanged || signingChanged || helperChanged;
  usePanelDirty(dirty);

  const title = "Identity, signing & credentials (global)";

  if (loading) {
    return <Section title={title} scope="git"><span className="legit-subtle">Loading…</span></Section>;
  }
  if (!identity || !signing || !helperView) return null;

  const isSsh = (format ?? signing.format.resolved.value) === "ssh";

  const changes: ChangeItem[] = [];
  const push = (key: string, before: string | null, after: string | null) => {
    if (before !== after) changes.push({ key, before, after });
  };
  push("user.name", identity.name_global.value ?? null, normName);
  push("user.email", identity.email_global.value ?? null, normEmail);
  push("commit.gpgsign", globalVal(signing.gpgsign), gpgsign);
  push("gpg.format", globalVal(signing.format), format);
  push("user.signingkey", globalVal(signing.signing_key), normKey);
  push("gpg.ssh.allowedSignersFile", globalVal(signing.allowed_signers), normSigners);
  push("credential.helper", helperView.helper_global, normHelper);

  const handleConfirm = async () => {
    setConfirmPending(false);
    setSaving(true);
    setError(null);
    try {
      let id = identity;
      let sg = signing;
      let ch = helperView;
      if (identityChanged) id = await globalWriteIdentity(normName, normEmail);
      if (signingChanged) sg = await globalWriteSigning(gpgsign, format, normKey, normSigners);
      if (helperChanged) ch = await globalWriteCredentialHelper(normHelper);
      setIdentity(id);
      setSigning(sg);
      setHelperView(ch);
      resetDrafts(id, sg, ch);
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => resetDrafts(identity, signing, helperView);

  const browseInto = async (set: (v: string) => void) => {
    const selected = await openDialog({ multiple: false });
    if (typeof selected === "string") set(selected);
  };

  return (
    <Section title={title} scope="git">
      <FieldNote>
        writes to: ~/.gitconfig - the defaults every repo uses unless a profile
        is applied to it in Repo Settings
      </FieldNote>

      {/* Same panel as the profile editor: one border, Field rows, one Save. */}
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
            placeholder="Your Name"
            onChange={(e) => setName(e.target.value)}
            disabled={saving}
          />
          <ResolvedBadge label="system" value={identity.name_system.value} source={identity.name_system.source} />
          <ResolvedBadge label="resolved" value={identity.name_resolved.value} source={identity.name_resolved.source} isResolved />
        </Field>

        <Field label="user.email">
          <input
            value={email}
            placeholder="you@example.com"
            onChange={(e) => setEmail(e.target.value)}
            disabled={saving}
          />
          <ResolvedBadge label="system" value={identity.email_system.value} source={identity.email_system.source} />
          <ResolvedBadge label="resolved" value={identity.email_resolved.value} source={identity.email_resolved.source} isResolved />
        </Field>

        <Field label="commit.gpgsign">
          <RadioGroup
            name="global-config-gpgsign"
            value={gpgsign}
            options={GPGSIGN_OPTIONS}
            onChange={setGpgsign}
            disabled={saving}
          />
          <ResolvedBadge label="system" value={signing.gpgsign.system.value} source={signing.gpgsign.system.source} />
          <ResolvedBadge label="resolved" value={signing.gpgsign.resolved.value} source={signing.gpgsign.resolved.source} isResolved />
        </Field>

        <Field label="gpg.format">
          <RadioGroup
            name="global-config-format"
            value={format}
            options={FORMAT_OPTIONS}
            onChange={setFormat}
            disabled={saving}
          />
          <ResolvedBadge label="system" value={signing.format.system.value} source={signing.format.system.source} />
          <ResolvedBadge label="resolved" value={signing.format.resolved.value} source={signing.format.resolved.source} isResolved />
        </Field>

        <Field label="user.signingkey">
          <WithBrowse
            value={signingKey}
            onChange={setSigningKey}
            onBrowse={() => browseInto(setSigningKey)}
            placeholder={isSsh ? "Path to SSH key (or literal public key)" : "GPG key id (e.g. ABC123…)"}
          />
          <ResolvedBadge label="system" value={signing.signing_key.system.value} source={signing.signing_key.system.source} />
          <ResolvedBadge label="resolved" value={signing.signing_key.resolved.value} source={signing.signing_key.resolved.source} isResolved />
        </Field>

        {isSsh && (
          <Field label="gpg.ssh.allowedSignersFile">
            <WithBrowse
              value={allowedSigners}
              onChange={setAllowedSigners}
              onBrowse={() => browseInto(setAllowedSigners)}
              placeholder="Path to allowed signers file"
            />
            <FieldNote>
              Required to verify SSH signatures. Without it, git cannot check them, so even
              your own SSH-signed commits show as <em>unsigned</em> in the log.
            </FieldNote>
            <ResolvedBadge label="system" value={signing.allowed_signers.system.value} source={signing.allowed_signers.system.source} />
            <ResolvedBadge label="resolved" value={signing.allowed_signers.resolved.value} source={signing.allowed_signers.resolved.source} isResolved />
          </Field>
        )}

        <Field label="credential.helper (HTTPS)">
          <CredentialHelperField
            value={helper}
            onChange={setHelper}
            disabled={saving}
            systemHelper={helperView.helper_system}
          />
          {normHelper && helperView.helper_system && (
            <FieldNote>
              Helpers accumulate across scopes: the system-scope{" "}
              <code>{helperView.helper_system}</code> still runs as well.
            </FieldNote>
          )}
        </Field>

        <Field label="Default SSH keys (~/.ssh)">
          <DefaultSshKeysField />
        </Field>

        {confirmPending && (
          <div style={{ padding: "10px 12px", background: "var(--button-hover-bg)", border: "1px solid var(--panel-border)", borderRadius: 4 }}>
            <div style={{ fontWeight: 600, marginBottom: 6, color: "var(--error-fg)", display: "flex", alignItems: "center", gap: 6 }}>
              <WarningIcon /> Save these changes to your global Git config (~/.gitconfig)?
            </div>
            <div style={{ marginBottom: 8, fontSize: "var(--fz-md)" }}>
              {changes.map((c) => (
                <div key={c.key} style={{ fontFamily: "monospace" }}>
                  <code>{c.key}</code>: <code>{c.before ?? "unset"}</code> → <code>{c.after ?? "unset"}</code>
                </div>
              ))}
            </div>
            <div style={{ fontSize: "var(--fz-md)", color: "var(--subtle-fg)", marginBottom: 10 }}>
              These changes affect every repository on this machine that doesn't override
              them (in LeGit: by applying a profile in Repo Settings), and every tool that
              reads your global Git config.
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <Button variant="primary" onClick={handleConfirm} disabled={saving}>Save globally</Button>
              <button onClick={() => setConfirmPending(false)}>Cancel</button>
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
    </Section>
  );
}
