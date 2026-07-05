import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";
import { cancelClone, listGitProfiles, recentRepos } from "../../lib/commands";
import type { CloneOptions, InitOptions } from "../../lib/commands";
import type { GitProfile } from "../../lib/types";
import { formatAppError, gitErrorKind } from "../../lib/types";
import { useRepoStore } from "../../store/repos";
import { useRemoteProgressStore } from "../../store/remoteProgress";
import { notify } from "../../store/notifications";
import { Button } from "../shared/buttons";

type Mode = "none" | "clone" | "init";

/** Derive a default clone target folder from a URL (last path segment, sans `.git`). */
function deriveName(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  const seg = trimmed.split(/[/:]/).pop() ?? "";
  return seg.replace(/\.git$/i, "");
}

/** Repositories panel — open / clone / init / close / switch. */
export function RepositoriesPanel() {
  const openRepos = useRepoStore((s) => s.openRepos);
  const activeRepoId = useRepoStore((s) => s.activeRepoId);
  const openRepo = useRepoStore((s) => s.openRepo);
  const initRepo = useRepoStore((s) => s.initRepo);
  const cloneRepo = useRepoStore((s) => s.cloneRepo);
  const closeRepo = useRepoStore((s) => s.closeRepo);
  const setActive = useRepoStore((s) => s.setActive);
  const refresh = useRepoStore((s) => s.refresh);
  const initialized = useRepoStore((s) => s.initialized);

  const [recents, setRecents] = useState<string[]>([]);
  const [profiles, setProfiles] = useState<GitProfile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("none");

  useEffect(() => {
    if (!initialized) refresh();
    recentRepos().then(setRecents).catch(console.warn);
    listGitProfiles().then(setProfiles).catch(console.warn);
  }, [initialized, refresh]);

  const refreshRecents = () => recentRepos().then(setRecents).catch(console.warn);

  const doOpen = async (path: string) => {
    setError(null);
    try {
      await openRepo(path);
      refreshRecents();
    } catch (e) {
      setError(formatAppError(e));
    }
  };

  const doDialog = async () => {
    const selected = await openDialog({ directory: true, multiple: false });
    if (typeof selected === "string") await doOpen(selected);
  };

  return (
    <div className="legit-panel">
      <div className="legit-panel__toolbar" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Button variant="primary" onClick={doDialog}>Open repository…</Button>
        <button onClick={() => { setError(null); setMode(mode === "clone" ? "none" : "clone"); }} aria-pressed={mode === "clone"}>
          Clone…
        </button>
        <button onClick={() => { setError(null); setMode(mode === "init" ? "none" : "init"); }} aria-pressed={mode === "init"}>
          Init…
        </button>
        <span className="legit-subtle" style={{ marginLeft: "auto" }}>
          {openRepos.length} open · {recents.length} recent
        </span>
      </div>
      <div className="legit-panel__body">
        {error && <div className="legit-error" style={{ marginBottom: 8 }}>{error}</div>}

        {mode === "clone" && (
          <CloneForm
            profiles={profiles}
            onCancel={() => setMode("none")}
            onError={setError}
            onClone={async (url, parentDir, name, profileId, opId, options) => {
              await cloneRepo(url, parentDir, name, profileId, opId, options);
              setMode("none");
              refreshRecents();
            }}
          />
        )}
        {mode === "init" && (
          <InitForm
            profiles={profiles}
            onCancel={() => setMode("none")}
            onError={setError}
            onInit={async (path, profileId, options) => {
              const summary = await initRepo(path, profileId, options);
              setMode("none");
              refreshRecents();
              if (!summary) {
                notify.success(`Bare repository created at ${path}`);
              }
            }}
          />
        )}

        <Section title="Open">
          {openRepos.length === 0 && <div className="legit-subtle">No repositories are open.</div>}
          {openRepos.map((r) => (
            <div
              key={r.id}
              style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", borderBottom: "1px solid var(--panel-border)" }}
            >
              <Button onClick={() => setActive(r.id)} style={{ minWidth: 80 }} variant={r.id === activeRepoId ? "primary" : "default"}>
                {r.id === activeRepoId ? "Active" : "Activate"}
              </Button>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600 }}>{r.name}</div>
                <div className="legit-subtle" style={{ fontSize: "var(--fz-sm)" }}>{r.path}</div>
              </div>
              <Button variant="danger" onClick={() => closeRepo(r.id)} aria-label={`Close ${r.name}`}>Close</Button>
            </div>
          ))}
        </Section>
        <Section title="Recent">
          {recents.length === 0 && <div className="legit-subtle">No recent repositories yet.</div>}
          {recents.map((p) => (
            <div key={p} style={{ display: "flex", alignItems: "center", gap: 8, padding: "2px 0" }}>
              <button onClick={() => doOpen(p)} style={{ minWidth: 80 }}>Open</button>
              <span style={{ flex: 1 }}>{p}</span>
            </div>
          ))}
        </Section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

function CloneForm({
  profiles,
  onClone,
  onCancel,
  onError,
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
}) {
  const [url, setUrl] = useState("");
  const [parentDir, setParentDir] = useState("");
  const [name, setName] = useState("");
  const [profileId, setProfileId] = useState("");
  const [depth, setDepth] = useState("");
  const [branch, setBranch] = useState("");
  const [recurseSubmodules, setRecurseSubmodules] = useState(false);
  const [busy, setBusy] = useState(false);
  const opIdRef = useRef<string | null>(null);
  const cancelRequestedRef = useRef(false);

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
    setBusy(true);
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
      setBusy(false);
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

function InitForm({
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
  const [busy, setBusy] = useState(false);

  const browse = async () => {
    const sel = await openDialog({ directory: true, multiple: false });
    if (typeof sel === "string") setDir(sel);
  };

  const submit = async () => {
    if (!dir.trim()) return;
    setBusy(true);
    onError(null);
    try {
      await onInit(dir.trim(), profileId || null, {
        bare,
        initialBranch: initialBranch.trim() || null,
      });
    } catch (e) {
      onError(formatAppError(e));
    } finally {
      setBusy(false);
    }
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

// ---------------------------------------------------------------------------
// Presentational helpers
// ---------------------------------------------------------------------------

function FormCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ border: "1px solid var(--panel-border)", borderRadius: 4, padding: "10px 12px", marginBottom: 14, display: "flex", flexDirection: "column", gap: 8 }}>
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: "var(--fz-sm)", textTransform: "uppercase", letterSpacing: 0.5, color: "var(--subtle-fg)", marginBottom: 6 }}>
        {title}
      </div>
      {children}
    </div>
  );
}
