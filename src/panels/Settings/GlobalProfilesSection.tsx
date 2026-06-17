import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useState } from "react";
import { usePanelFocusEffect } from "../PanelApiContext";
import { formatAppError } from "../../lib/types";
import type { GitProfile } from "../../lib/types";
import {
  listGitProfiles,
  createGitProfile,
  updateGitProfile,
  deleteGitProfile,
} from "../../lib/commands";

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
  };
}

/**
 * Global Settings section: define named git identity profiles. Profiles are
 * applied per-repo from Repo Settings. Definitions live in global settings;
 * applying writes to a repo's local .git/config.
 */
export function GlobalProfilesSection() {
  const [profiles, setProfiles] = useState<GitProfile[]>([]);
  const [editing, setEditing] = useState<GitProfile | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    listGitProfiles()
      .then(setProfiles)
      .catch((e) => setError(formatAppError(e)));
  }, []);

  useEffect(() => { load(); }, [load]);
  usePanelFocusEffect(load);

  const save = async (p: GitProfile) => {
    setError(null);
    try {
      if (p.id === "") {
        await createGitProfile(p);
      } else {
        await updateGitProfile(p);
      }
      setEditing(null);
      load();
    } catch (e) {
      setError(formatAppError(e));
    }
  };

  const remove = async (id: string) => {
    setError(null);
    try {
      await deleteGitProfile(id);
      load();
    } catch (e) {
      setError(formatAppError(e));
    }
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
            <button onClick={() => setEditing(p)} disabled={!!editing}>Edit</button>
            <button onClick={() => remove(p.id)} disabled={!!editing}>Delete</button>
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
          <button className="primary" onClick={() => setEditing(emptyProfile())}>
            New profile
          </button>
        </div>
      )}

      {error && <pre className="legit-error" style={{ marginTop: 6 }}>{error}</pre>}
    </Section>
  );
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
        <input value={p.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Work" />
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
      </Field>

      <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
        <button className="primary" disabled={p.name.trim() === ""} onClick={() => onSave({ ...p, name: p.name.trim() })}>
          Save profile
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// --- small presentational helpers ---

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <span style={{ fontSize: "var(--fz-md)", fontFamily: "monospace", color: "var(--subtle-fg)" }}>{label}</span>
      {children}
    </label>
  );
}

function WithBrowse({
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: "var(--fz-sm)", textTransform: "uppercase", letterSpacing: 0.5, color: "var(--subtle-fg)", marginBottom: 8 }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function FieldNote({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: "var(--fz-sm)", color: "var(--subtle-fg)", marginTop: 4 }}>
      {children}
    </div>
  );
}
