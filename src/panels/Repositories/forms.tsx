// Clone / Init forms, shared between the Repositories panel and the repo tab
// strip's "+" menu (one implementation — the two surfaces must not drift).

import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useRef, useState } from "react";
import { cancelClone } from "../../lib/commands";
import type { CloneOptions, InitOptions } from "../../lib/commands";
import type { GitProfile } from "../../lib/types";
import { formatAppError, gitErrorKind } from "../../lib/types";
import { useRemoteProgressStore } from "../../store/remoteProgress";
import { useSettingsStore } from "../../store/settings";
import { Button } from "../shared/buttons";
import { useDelayedBusy } from "../shared/useDelayedBusy";

/** Derive a default clone target folder from a URL (last path segment, sans `.git`). */
export function deriveName(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  const seg = trimmed.split(/[/:]/).pop() ?? "";
  return seg.replace(/\.git$/i, "");
}

export function CloneForm({
  profiles,
  onClone,
  onCancel,
  onError,
  onBusyChange,
}: {
  profiles: GitProfile[];
  onClone: (
    url: string,
    parentDir: string,
    name: string,
    profileId: string | null,
    opId: string,
    options: CloneOptions,
  ) => Promise<void>;
  onCancel: () => void;
  onError: (msg: string | null) => void;
  /** Reports the in-flight state so a floating host (the "+" popover) can pin
   * itself open while a clone runs — a dismissed popover would orphan the
   * progress meter and the cancel button. */
  onBusyChange?: (busy: boolean) => void;
}) {
  const [url, setUrl] = useState("");
  // Prefilled with the previous clone's parent - most users keep one source
  // folder for all their repositories. Read once on mount (getState, no
  // subscription): the field is user-editable afterwards.
  const [parentDir, setParentDir] = useState(
    () => useSettingsStore.getState().settings?.last_clone_parent_dir ?? "",
  );
  const [name, setName] = useState("");
  const [profileId, setProfileId] = useState("");
  const [depth, setDepth] = useState("");
  const [branch, setBranch] = useState("");
  const [recurseSubmodules, setRecurseSubmodules] = useState(false);
  const [busy, setBusy] = useState(false);
  const opIdRef = useRef<string | null>(null);
  const cancelRequestedRef = useRef(false);

  const setBusyBoth = (b: boolean) => {
    setBusy(b);
    onBusyChange?.(b);
  };

  // Live clone transfer progress (legit://remote-progress, keyed by our opId).
  const progress = useRemoteProgressStore((s) =>
    opIdRef.current ? s.byOp[opIdRef.current] : undefined,
  );

  const browse = async () => {
    const sel = await openDialog({ directory: true, multiple: false });
    if (typeof sel === "string") setParentDir(sel);
  };

  const submit = async () => {
    if (!url.trim() || !parentDir.trim() || !name.trim()) return;
    const opId = crypto.randomUUID();
    opIdRef.current = opId;
    cancelRequestedRef.current = false;
    setBusyBoth(true);
    onError(null);
    const parsedDepth = Number.parseInt(depth, 10);
    try {
      await onClone(url.trim(), parentDir.trim(), name.trim(), profileId || null, opId, {
        depth: Number.isFinite(parsedDepth) && parsedDepth > 0 ? parsedDepth : null,
        branch: branch.trim() || null,
        recurseSubmodules,
      });
    } catch (e) {
      if (!cancelRequestedRef.current) {
        onError(
          gitErrorKind(e) === "AuthFailed"
            ? "Authentication failed. Pick a profile with the right credentials, or fix your global git credentials."
            : formatAppError(e),
        );
      }
    } finally {
      useRemoteProgressStore.getState().clear(opId);
      setBusyBoth(false);
      opIdRef.current = null;
    }
  };

  const cancel = () => {
    if (opIdRef.current) {
      cancelRequestedRef.current = true;
      void cancelClone(opIdRef.current);
    }
  };

  return (
    <FormCard title="Clone repository">
      <Field label="URL">
        <input
          autoFocus
          value={url}
          onChange={(e) => { setUrl(e.target.value); setName(deriveName(e.target.value)); }}
          placeholder="https://… or git@…"
          style={{ width: "100%", fontFamily: "monospace" }}
        />
      </Field>
      <Field label="Into folder">
        <div style={{ display: "flex", gap: 6 }}>
          <input style={{ flex: 1, fontFamily: "monospace" }} value={parentDir} onChange={(e) => setParentDir(e.target.value)} placeholder="parent directory" />
          <button onClick={browse}>Browse…</button>
        </div>
      </Field>
      <Field label="Folder name">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="target folder" style={{ width: "100%", fontFamily: "monospace" }} />
      </Field>
      <ProfileField profiles={profiles} value={profileId} onChange={setProfileId} />
      <div style={{ display: "flex", gap: 6 }}>
        <Field label="Branch (optional)">
          <input
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            placeholder="remote default"
            style={{ width: "100%", fontFamily: "monospace" }}
          />
        </Field>
        <Field label="Depth (optional)">
          <input
            type="number"
            min={1}
            value={depth}
            onChange={(e) => setDepth(e.target.value)}
            placeholder="full history"
            style={{ width: "100%" }}
          />
        </Field>
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "var(--fz-md)" }}>
        <input
          type="checkbox"
          checked={recurseSubmodules}
          onChange={(e) => setRecurseSubmodules(e.target.checked)}
        />
        Clone submodules
      </label>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
        <Button variant="primary" disabled={busy || !url.trim() || !parentDir.trim() || !name.trim()} onClick={submit}>
          {busy ? "Cloning…" : "Clone"}
        </Button>
        {busy ? (
          <button onClick={cancel}>Cancel clone</button>
        ) : (
          <button onClick={onCancel}>Close</button>
        )}
        {busy && <span className="legit-spinner" aria-hidden="true" />}
        {busy && progress && (
          <span
            className="legit-subtle"
            style={{ fontSize: "var(--fz-sm)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            {progress.phase}
            {progress.percent != null ? ` ${progress.percent}%` : "…"}
          </span>
        )}
      </div>
    </FormCard>
  );
}

export function InitForm({
  profiles,
  onInit,
  onCancel,
  onError,
}: {
  profiles: GitProfile[];
  onInit: (path: string, profileId: string | null, options: InitOptions) => Promise<void>;
  onCancel: () => void;
  onError: (msg: string | null) => void;
}) {
  const [dir, setDir] = useState("");
  const [profileId, setProfileId] = useState("");
  const [bare, setBare] = useState(false);
  const [initialBranch, setInitialBranch] = useState("");
  // Delayed busy (unlike Clone's, which is a genuinely slow network op and
  // may show busy immediately): a local init is usually instant.
  const { busy, run } = useDelayedBusy();

  const browse = async () => {
    const sel = await openDialog({ directory: true, multiple: false });
    if (typeof sel === "string") setDir(sel);
  };

  const submit = () => {
    if (!dir.trim()) return;
    return run(async () => {
      onError(null);
      try {
        await onInit(dir.trim(), profileId || null, {
          bare,
          initialBranch: initialBranch.trim() || null,
        });
      } catch (e) {
        onError(formatAppError(e));
      }
    });
  };

  return (
    <FormCard title="Initialize repository">
      <Field label="Directory">
        <div style={{ display: "flex", gap: 6 }}>
          <input style={{ flex: 1, fontFamily: "monospace" }} value={dir} onChange={(e) => setDir(e.target.value)} placeholder="folder to init" />
          <button onClick={browse}>Browse…</button>
        </div>
      </Field>
      <Field label="Initial branch (optional)">
        <input
          value={initialBranch}
          onChange={(e) => setInitialBranch(e.target.value)}
          placeholder="git default"
          style={{ width: "100%", fontFamily: "monospace" }}
        />
      </Field>
      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "var(--fz-md)" }}>
        <input type="checkbox" checked={bare} onChange={(e) => setBare(e.target.checked)} />
        Bare repository (created but not opened, it has no working tree)
      </label>
      <ProfileField profiles={profiles} value={profileId} onChange={setProfileId} disabled={bare} />
      <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
        <Button variant="primary" disabled={busy || !dir.trim()} onClick={submit}>
          {busy ? "Initializing…" : "Init"}
        </Button>
        <button onClick={onCancel}>Close</button>
      </div>
    </FormCard>
  );
}

/** Profile selector with the built-in "Use global config" sentinel (value ""). */
function ProfileField({
  profiles,
  value,
  onChange,
  disabled,
}: {
  profiles: GitProfile[];
  value: string;
  onChange: (v: string) => void;
  /** Disable when a profile cannot apply (profiles are session-scoped, e.g. bare init). */
  disabled?: boolean;
}) {
  return (
    <Field label="Profile">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ width: "100%" }}
        disabled={disabled}
      >
        <option value="">Use global config</option>
        {profiles.map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>
    </Field>
  );
}

function FormCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ border: "1px solid var(--panel-border)", borderRadius: 4, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ fontSize: "var(--fz-sm)", textTransform: "uppercase", letterSpacing: 0.5, color: "var(--subtle-fg)" }}>{title}</div>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <span style={{ fontSize: "var(--fz-sm)", color: "var(--subtle-fg)" }}>{label}</span>
      {children}
    </label>
  );
}
