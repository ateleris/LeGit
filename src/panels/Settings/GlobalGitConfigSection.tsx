// The ONE global git-config edit form (identity + signing + credential
// helper), styled exactly like the profile editor: same bordered panel, same
// Field rows, a single Save, so it reads as one coherent "global config" edit
// view. Line endings stay in their own section (rarely touched together with
// these).
//
// It renders for whichever host the `scope` names — the app machine's config
// or a WSL distribution's own — so the two Settings groups can never drift
// apart. Everything host-specific (which commands run, which affordances
// exist, what the confirmation says) comes from the scope; see
// `gitConfigHost.tsx`.
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
import { Button } from "../shared/buttons";
import { useDelayedBusy } from "../shared/useDelayedBusy";
import { useDelayedFlag } from "../shared/useDelayedFlag";
import { Section, FieldNote } from "./primitives";
import { CredentialHelperField } from "./CredentialHelperField";
import { DefaultSshKeysField } from "./SshKeyTools";
import { Field, WithBrowse } from "./GlobalProfilesSection";
import type { GitConfigScope } from "./gitConfigHost";
import {
  ResolvedBadge,
  RadioGroup,
  GPGSIGN_OPTIONS,
  FORMAT_OPTIONS,
} from "./SigningSettings";

interface ChangeItem { key: string; before: string | null; after: string | null }

/**
 * `enabled` gates loading: a WSL form must not connect to (and thereby start)
 * a distro on mount — the group's Connect action does that. Local scopes pass
 * `true`. `reloadNonce` re-reads after a reconnect; `disabled` blocks saving
 * while the host is unreachable.
 */
export function GlobalGitConfigSection({
  scope,
  enabled = true,
  reloadNonce = 0,
  disabled = false,
}: {
  scope: GitConfigScope;
  enabled?: boolean;
  reloadNonce?: number;
  disabled?: boolean;
}) {
  const [identity, setIdentity] = useState<IdentityView | null>(null);
  const [signing, setSigning] = useState<SigningView | null>(null);
  const [helperView, setHelperView] = useState<CredentialHelperView | null>(null);
  const [loading, setLoading] = useState(enabled);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [gpgsign, setGpgsign] = useState<string | null>(null);
  const [format, setFormat] = useState<string | null>(null);
  const [signingKey, setSigningKey] = useState("");
  const [allowedSigners, setAllowedSigners] = useState("");
  const [helper, setHelper] = useState("");

  const { busy: savingNow, run } = useDelayedBusy();
  const [error, setError] = useState<string | null>(null);
  const [confirmPending, setConfirmPending] = useState(false);
  // Debounced loading indicator: fast loads never flash "Loading…".
  const showLoading = useDelayedFlag(loading);

  const saving = savingNow || disabled;
  const title = `Identity, signing & credentials ${scope.titleSuffix}`;

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
    if (!enabled) return;
    setLoading(true);
    setError(null);
    setConfirmPending(false);
    Promise.all([
      scope.api.identityView(),
      scope.api.signingConfig(),
      scope.api.credentialHelperView(),
    ])
      .then(([id, sg, ch]) => {
        setIdentity(id);
        setSigning(sg);
        setHelperView(ch);
        resetDrafts(id, sg, ch);
      })
      .catch((e) => setError(formatAppError(e)))
      .finally(() => setLoading(false));
  }, [enabled, scope, resetDrafts]);

  useEffect(() => { load(); }, [load, reloadNonce]);
  // `usePanelFocusEffect` never re-subscribes, so the callback must read
  // `enabled` through the ref-stable `load` rather than close over it.
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
  usePanelDirty(dirty, `git-config-${scope.id}`);

  if (!enabled) {
    return (
      <Section title={title} scope="git">
        <span className="legit-subtle">Not loaded yet.</span>
      </Section>
    );
  }

  if (loading) {
    return (
      <Section title={title} scope="git">
        {showLoading && <span className="legit-subtle">Loading…</span>}
      </Section>
    );
  }
  if (!identity || !signing || !helperView) {
    return (
      <Section title={title} scope="git">
        {error ? (
          <pre className="legit-error">{error}</pre>
        ) : (
          showLoading && <span className="legit-subtle">Loading…</span>
        )}
      </Section>
    );
  }

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

  const handleConfirm = () =>
    run(async () => {
      setConfirmPending(false);
      setError(null);
      try {
        let id = identity;
        let sg = signing;
        let ch = helperView;
        if (identityChanged) id = await scope.api.writeIdentity(normName, normEmail);
        if (signingChanged)
          sg = await scope.api.writeSigning(gpgsign, format, normKey, normSigners);
        if (helperChanged) ch = await scope.api.writeCredentialHelper(normHelper);
        setIdentity(id);
        setSigning(sg);
        setHelperView(ch);
        resetDrafts(id, sg, ch);
      } catch (e) {
        setError(formatAppError(e));
      }
    });

  const handleCancel = () => resetDrafts(identity, signing, helperView);

  const browseInto = async (set: (v: string) => void) => {
    const selected = await openDialog({ multiple: false });
    if (typeof selected === "string") set(selected);
  };

  /**
   * A path field. `Browse…` opens the APP MACHINE's file dialog, so a remote
   * scope gets a plain input instead — a `C:\…` path means nothing to a git
   * running inside the distro.
   */
  const pathField = (
    value: string,
    onChange: (v: string) => void,
    placeholder: string
  ) =>
    scope.showBrowse ? (
      <WithBrowse
        value={value}
        onChange={onChange}
        onBrowse={() => browseInto(onChange)}
        placeholder={placeholder}
      />
    ) : (
      <input
        style={{ flex: 1, fontFamily: "monospace" }}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        disabled={saving}
      />
    );

  return (
    <Section title={title} scope="git">
      <FieldNote>
        writes to: {scope.configFileLabel} - the defaults every repo there uses unless a profile
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
            name={`${scope.id}-config-gpgsign`}
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
            name={`${scope.id}-config-format`}
            value={format}
            options={FORMAT_OPTIONS}
            onChange={setFormat}
            disabled={saving}
          />
          <ResolvedBadge label="system" value={signing.format.system.value} source={signing.format.system.source} />
          <ResolvedBadge label="resolved" value={signing.format.resolved.value} source={signing.format.resolved.source} isResolved />
        </Field>

        <Field label="user.signingkey">
          {pathField(
            signingKey,
            setSigningKey,
            isSsh ? "Path to SSH key (or literal public key)" : "GPG key id (e.g. ABC123…)"
          )}
          <ResolvedBadge label="system" value={signing.signing_key.system.value} source={signing.signing_key.system.source} />
          <ResolvedBadge label="resolved" value={signing.signing_key.resolved.value} source={signing.signing_key.resolved.source} isResolved />
        </Field>

        {isSsh && (
          <Field label="gpg.ssh.allowedSignersFile">
            {pathField(allowedSigners, setAllowedSigners, "Path to allowed signers file")}
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
            listHelpers={scope.api.availableHelpers}
            where={scope.hostWhere}
          />
          {normHelper && helperView.helper_system && (
            <FieldNote>
              Helpers accumulate across scopes: the system-scope{" "}
              <code>{helperView.helper_system}</code> still runs as well.
            </FieldNote>
          )}
          {scope.credentialHelperNote && <FieldNote>{scope.credentialHelperNote}</FieldNote>}
        </Field>

        {scope.showSshKeys && (
          <Field label="Default SSH keys (~/.ssh)">
            <DefaultSshKeysField />
          </Field>
        )}

        {confirmPending && (
          <div style={{ padding: "10px 12px", background: "var(--button-hover-bg)", border: "1px solid var(--panel-border)", borderRadius: 4 }}>
            <div style={{ fontWeight: 600, marginBottom: 6, color: "var(--error-fg)", display: "flex", alignItems: "center", gap: 6 }}>
              <WarningIcon /> Save these changes to {scope.configFileLabel}?
            </div>
            <div style={{ marginBottom: 8, fontSize: "var(--fz-md)" }}>
              {changes.map((c) => (
                <div key={c.key} style={{ fontFamily: "monospace" }}>
                  <code>{c.key}</code>: <code>{c.before ?? "unset"}</code> → <code>{c.after ?? "unset"}</code>
                </div>
              ))}
            </div>
            <div style={{ fontSize: "var(--fz-md)", color: "var(--subtle-fg)", marginBottom: 10 }}>
              {scope.confirmBlurb}
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <Button variant="primary" onClick={handleConfirm} disabled={saving}>Save</Button>
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
