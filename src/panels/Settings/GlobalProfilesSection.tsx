import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { usePanelFocusEffect } from "../PanelApiContext";
import { formatAppError } from "../../lib/types";
import type { GitProfile } from "../../lib/types";
import {
  createGitProfile,
  updateGitProfile,
  deleteGitProfile,
  reposUsingProfile,
} from "../../lib/commands";
import { useGitProfiles, invalidateGitProfiles } from "../../lib/useGitProfiles";
import { useConfirmDestructive } from "../../store/settings";
import { Button } from "../shared/buttons";
import { Section, FieldNote } from "./primitives";
import { CredentialHelperField } from "./CredentialHelperField";
import { GenerateSshKeyForm, SshKeyActions } from "./SshKeyTools";

const FORMAT_OPTIONS: { label: string; value: string | null }[] = [
  { label: "ssh", value: "ssh" },
  { label: "openpgp (GPG)", value: "openpgp" },
  { label: "x509", value: "x509" },
  { label: "unset", value: null },
];

function emptyProfile(): GitProfile {
  return {
    id: "",
    name: "",
    userName: null,
    userEmail: null,
    gpgFormat: null,
    signingKey: null,
    commitGpgsign: null,
    allowedSignersFile: null,
    authSshKey: null,
    credentialHelper: null,
  };
}

/**
 * Global Settings section: define named git identity profiles. Profiles are
 * applied per-repo from Repo Settings. Definitions live in global settings;
 * applying writes to a repo's local .git/config.
 */
export function GlobalProfilesSection() {
  const queryClient = useQueryClient();
  const profilesQuery = useGitProfiles();
  const profiles = profilesQuery.data ?? [];
  const [editing, setEditing] = useState<GitProfile | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { refetch } = profilesQuery;
  usePanelFocusEffect(useCallback(() => { void refetch(); }, [refetch]));

  const save = async (p: GitProfile) => {
    setError(null);
    try {
      if (p.id === "") {
        await createGitProfile(p);
      } else {
        await updateGitProfile(p);
      }
      setEditing(null);
      invalidateGitProfiles(queryClient);
    } catch (e) {
      setError(formatAppError(e));
    }
  };

  const confirmDestructive = useConfirmDestructive();
  const [confirmingDelete, setConfirmingDelete] =
    useState<{ id: string; usedBy: string[] } | null>(null);

  const doDelete = async (id: string) => {
    setError(null);
    try {
      await deleteGitProfile(id);
      setConfirmingDelete(null);
      invalidateGitProfiles(queryClient);
    } catch (e) {
      setError(formatAppError(e));
    }
  };

  const requestDelete = async (id: string) => {
    // Gated by the global destructive-confirmation setting (never hardcoded).
    if (!confirmDestructive) return void doDelete(id);
    let usedBy: string[] = [];
    try {
      usedBy = await reposUsingProfile(id);
    } catch {
      // Usage lookup is best-effort; the confirmation still shows without it.
    }
    setConfirmingDelete({ id, usedBy });
  };

  return (
    <Section title="Git identity profiles">
      <FieldNote>
        Defined globally; select one per repo in Repo Settings. Applying a profile writes its
        values into that repo's local <code>.git/config</code>. No passwords are stored.
      </FieldNote>

      {profiles.length === 0 && !editing && (
        <div className="legit-subtle" style={{ marginTop: 8, fontSize: "var(--fz-md)" }}>
          No profiles yet.
        </div>
      )}

      <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
        {profiles.map((p) => (
          <div
            key={p.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 8px",
              background: "var(--button-hover-bg)",
              borderRadius: 4,
            }}
          >
            <div style={{ flex: 1, overflow: "hidden" }}>
              <div style={{ fontWeight: 600 }}>{p.name || "(unnamed)"}</div>
              <div className="legit-subtle" style={{ fontSize: "var(--fz-sm)" }}>
                {p.userName ?? "—"} &lt;{p.userEmail ?? "—"}&gt;
              </div>
            </div>
            {confirmingDelete?.id === p.id ? (
              <>
                <span style={{ fontSize: "var(--fz-sm)", textAlign: "right" }}>
                  {confirmingDelete.usedBy.length > 0 ? (
                    <>
                      Used by <b>{confirmingDelete.usedBy.join(", ")}</b>.
                      {" "}Repos keep their git config and show as Custom. Delete profile?
                    </>
                  ) : (
                    "Delete profile?"
                  )}
                </span>
                <Button variant="danger" data-testid="profile-delete-confirm" onClick={() => doDelete(p.id)}>
                  Delete
                </Button>
                <button onClick={() => setConfirmingDelete(null)}>Cancel</button>
              </>
            ) : (
              <>
                <button onClick={() => setEditing(p)} disabled={!!editing}>Edit</button>
                <button data-testid="profile-delete" onClick={() => requestDelete(p.id)} disabled={!!editing}>
                  {confirmDestructive ? "Delete…" : "Delete"}
                </button>
              </>
            )}
          </div>
        ))}
      </div>

      {editing ? (
        <ProfileEditor
          key={editing.id || "new"}
          initial={editing}
          onSave={save}
          onCancel={() => { setEditing(null); setError(null); }}
        />
      ) : (
        <div style={{ marginTop: 10 }}>
          <Button variant="primary" data-testid="profile-new" onClick={() => setEditing(emptyProfile())}>
            New profile
          </Button>
        </div>
      )}

      {(error ?? profilesQuery.error) && (
        <pre className="legit-error" style={{ marginTop: 6 }}>
          {error ?? formatAppError(profilesQuery.error)}
        </pre>
      )}
    </Section>
  );
}

/** File-name-safe slug from a profile name, for the generated key's default name. */
export function profileNameSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function ProfileEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: GitProfile;
  onSave: (p: GitProfile) => void;
  onCancel: () => void;
}) {
  const [p, setP] = useState<GitProfile>(initial);
  const [showGenerateKey, setShowGenerateKey] = useState(false);
  const set = <K extends keyof GitProfile>(k: K, v: GitProfile[K]) =>
    setP((prev) => ({ ...prev, [k]: v }));
  const setStr = (k: keyof GitProfile) => (v: string) =>
    set(k, (v.trim() === "" ? null : v) as GitProfile[keyof GitProfile]);

  const isSsh = p.gpgFormat === "ssh";

  const browseInto = async (k: keyof GitProfile) => {
    const sel = await openDialog({ multiple: false });
    if (typeof sel === "string") set(k, sel as GitProfile[keyof GitProfile]);
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
      <Field label="Profile name">
        <input data-testid="profile-name-input" value={p.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Work" />
      </Field>
      <Field label="user.name">
        <input value={p.userName ?? ""} onChange={(e) => setStr("userName")(e.target.value)} placeholder="Your Name" />
      </Field>
      <Field label="user.email">
        <input value={p.userEmail ?? ""} onChange={(e) => setStr("userEmail")(e.target.value)} placeholder="you@example.com" />
      </Field>

      <Field label="commit.gpgsign">
        <Radio
          name="prof-gpgsign"
          value={p.commitGpgsign}
          options={[{ label: "On", value: "true" }, { label: "Off", value: "false" }, { label: "unset", value: null }]}
          onChange={(v) => set("commitGpgsign", v)}
        />
      </Field>
      <Field label="gpg.format">
        <Radio name="prof-format" value={p.gpgFormat} options={FORMAT_OPTIONS} onChange={(v) => set("gpgFormat", v)} />
      </Field>
      <Field label="user.signingkey">
        <WithBrowse value={p.signingKey ?? ""} onChange={setStr("signingKey")} onBrowse={() => browseInto("signingKey")} placeholder={isSsh ? "SSH key path or literal key" : "GPG key id"} />
      </Field>
      {isSsh && (
        <Field label="gpg.ssh.allowedSignersFile">
          <WithBrowse value={p.allowedSignersFile ?? ""} onChange={setStr("allowedSignersFile")} onBrowse={() => browseInto("allowedSignersFile")} placeholder="Path to allowed signers file" />
        </Field>
      )}
      <Field label="Auth SSH key (core.sshCommand)">
        <WithBrowse value={p.authSshKey ?? ""} onChange={setStr("authSshKey")} onBrowse={() => browseInto("authSshKey")} placeholder="Path to SSH private key (for push/pull)" />
        {p.authSshKey && !showGenerateKey && <SshKeyActions privateKeyPath={p.authSshKey} />}
        {showGenerateKey ? (
          <GenerateSshKeyForm
            nameSlug={profileNameSlug(p.name)}
            defaultComment={p.userEmail ?? ""}
            onGenerated={(path) => {
              set("authSshKey", path as GitProfile[keyof GitProfile]);
              setShowGenerateKey(false);
            }}
            onCancel={() => setShowGenerateKey(false)}
          />
        ) : (
          <div>
            <button onClick={() => setShowGenerateKey(true)}>Generate new key…</button>
          </div>
        )}
      </Field>
      <Field label="credential.helper (HTTPS)">
        <CredentialHelperField
          value={p.credentialHelper ?? ""}
          onChange={(v) => setStr("credentialHelper")(v)}
        />
        <FieldNote>
          Applying overrides any inherited (global/system) helper for this repo.
        </FieldNote>
      </Field>

      <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
        <Button variant="primary" data-testid="profile-save" disabled={p.name.trim() === ""} onClick={() => onSave({ ...p, name: p.name.trim() })}>
          Save profile
        </Button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// --- small presentational helpers (shared with GlobalGitConfigSection) ---

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <span style={{ fontSize: "var(--fz-md)", fontFamily: "monospace", color: "var(--subtle-fg)" }}>{label}</span>
      {children}
    </label>
  );
}

export function WithBrowse({
  value,
  onChange,
  onBrowse,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onBrowse: () => void;
  placeholder?: string;
}) {
  return (
    <div style={{ display: "flex", gap: 6 }}>
      <input style={{ flex: 1 }} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      <button onClick={onBrowse}>Browse…</button>
    </div>
  );
}

function Radio({
  name,
  value,
  options,
  onChange,
}: {
  name: string;
  value: string | null;
  options: { label: string; value: string | null }[];
  onChange: (v: string | null) => void;
}) {
  return (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
      {options.map((opt) => (
        <label key={opt.label} style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
          <input type="radio" name={name} checked={value === opt.value} onChange={() => onChange(opt.value)} />
          <code style={{ fontSize: "var(--fz-md)" }}>{opt.label}</code>
        </label>
      ))}
    </div>
  );
}

