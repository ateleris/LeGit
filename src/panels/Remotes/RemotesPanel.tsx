import { useCallback, useRef, useState } from "react";
import { PanelError } from "../shared/PanelError";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useActiveRepo } from "../../store/repos";
import { usePanelFocusEffect } from "../PanelApiContext";
import { invalidateRepoDomains } from "../../lib/repoInvalidation";
import {
  consoleCancel,
  repoAddRemote,
  repoFetch,
  repoListRemotes,
  repoPruneRemote,
  repoRemoveRemote,
  repoRenameRemote,
  repoSetRemoteUrl,
} from "../../lib/commands";
import type { Remote } from "../../lib/types";
import { formatAppError, gitErrorKind } from "../../lib/types";
import { PanelLoadingBar } from "../shared/PanelLoadingBar";
import { usePanelRunner } from "../shared/usePanelRunner";
import { InlineEditor } from "../shared/InlineEditor";
import { Button } from "../shared/buttons";
import { useConfirmDestructive } from "../../store/settings";
import { FetchIcon } from "../../icons";

// Domains to refresh after any remote change: the remotes list itself, plus
// branches/tracking/log so the Commits sync toolbar's remote derivation and
// ahead/behind indicator stay correct.
const AFFECTED_DOMAINS = ["remotes", "branches", "tracking", "log"];

/** Which row is being edited inline, and how. */
type EditState =
  | { name: string; mode: "rename" }
  | { name: string; mode: "urls" }
  | { name: string; mode: "remove" }
  | null;

/**
 * Remotes section — manage the active repo's git remotes: list with fetch/push
 * URLs, add / remove / rename / set-url, and per-remote fetch / prune.
 * Rendered as a pane inside the combined Refs panel (see `Refs/RefsPanel`),
 * which supplies the header — this component is body-only.
 */
export function RemotesSection() {
  const repo = useActiveRepo();
  const queryClient = useQueryClient();
  const confirmDestructive = useConfirmDestructive();

  const { data: remotes = [], isFetching, refetch } = useQuery<Remote[]>({
    queryKey: [repo?.id, "remotes"],
    queryFn: () => repoListRemotes(repo!.id),
    enabled: !!repo,
    staleTime: 5_000,
  });

  const reload = useCallback(() => {
    refetch();
  }, [refetch]);
  usePanelFocusEffect(reload);

  // Network op in flight, as `"fetch:<name>"` / `"prune:<name>"` (for the row spinner).
  const [busyNet, setBusyNet] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState<EditState>(null);
  // Drafts for the inline editors.
  const [draftName, setDraftName] = useState("");
  const [draftFetch, setDraftFetch] = useState("");
  const [draftPush, setDraftPush] = useState("");

  const opIdRef = useRef<string | null>(null);
  const cancelRequestedRef = useRef(false);

  // A blocking, non-network mutation (add/remove/rename/set-url). Returns
  // whether it succeeded so callers can close their inline editor only on
  // success. Delayed busy + double-click guard per convention.
  const { busy, run: runMut } = usePanelRunner({
    enabled: !!repo,
    onStart: () => setError(null),
    onSuccess: () => invalidateRepoDomains(queryClient, repo!.id, AFFECTED_DOMAINS),
    onError: (e) => setError(formatAppError(e)),
  });

  // A cancellable network op (fetch / prune). `tag` is `"fetch:<name>"` etc.
  // Bespoke (not usePanelRunner): the row spinner needs the tag identity and
  // a cancel must suppress the error toast. Immediate busy is the network-op
  // convention; the ref guard still blocks double-clicks.
  const netRunningRef = useRef(false);
  const runNet = useCallback(
    async (tag: string, fn: (opId: string) => Promise<unknown>) => {
      if (!repo || netRunningRef.current) return;
      netRunningRef.current = true;
      const opId = crypto.randomUUID();
      opIdRef.current = opId;
      cancelRequestedRef.current = false;
      setBusyNet(tag);
      setError(null);
      try {
        await fn(opId);
        invalidateRepoDomains(queryClient, repo.id, AFFECTED_DOMAINS);
      } catch (e) {
        if (!cancelRequestedRef.current) {
          setError(
            gitErrorKind(e) === "AuthFailed"
              ? "Authentication failed — check this repo's git profile credentials (SSH key / credential helper)."
              : formatAppError(e),
          );
        }
      } finally {
        netRunningRef.current = false;
        setBusyNet(null);
        opIdRef.current = null;
      }
    },
    [repo, queryClient],
  );

  const cancelNet = useCallback(() => {
    if (repo && opIdRef.current) {
      cancelRequestedRef.current = true;
      void consoleCancel(repo.id, opIdRef.current);
    }
  }, [repo]);

  const openRename = (r: Remote) => {
    setError(null);
    setDraftName(r.name);
    setEdit({ name: r.name, mode: "rename" });
  };
  const openUrls = (r: Remote) => {
    setError(null);
    setDraftFetch(r.fetch_url);
    setDraftPush(r.push_url);
    setEdit({ name: r.name, mode: "urls" });
  };

  const saveRename = async (name: string) => {
    const next = draftName.trim();
    if (next === "" || next === name) {
      setEdit(null);
      return;
    }
    if (await runMut(() => repoRenameRemote(repo!.id, name, next))) setEdit(null);
  };

  const saveUrls = async (r: Remote) => {
    const f = draftFetch.trim();
    const p = draftPush.trim();
    const ok = await runMut(async () => {
      if (f && f !== r.fetch_url) await repoSetRemoteUrl(repo!.id, r.name, f, false);
      if (p !== r.push_url && p !== "") await repoSetRemoteUrl(repo!.id, r.name, p, true);
    });
    if (ok) setEdit(null);
  };

  const doRemove = async (name: string) => {
    if (await runMut(() => repoRemoveRemote(repo!.id, name))) setEdit(null);
  };

  const addRemote = async (name: string, url: string): Promise<boolean> =>
    runMut(() => repoAddRemote(repo!.id, name, url));

  if (!repo) {
    return (
      <div className="legit-panel">
        <div className="legit-panel__body">
          <span className="legit-subtle">No repository open.</span>
        </div>
      </div>
    );
  }

  const blocked = busy || busyNet !== null;

  return (
    <div className="legit-panel" style={{ display: "flex", flexDirection: "column" }}>
      <PanelLoadingBar active={isFetching} />
      <div className="legit-panel__body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {error && (
          <PanelError error={error} margin={0} />
        )}

        {remotes.length === 0 ? (
          <span className="legit-subtle">No remotes configured.</span>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {remotes.map((r) => (
              <div
                key={r.name}
                style={{
                  border: "1px solid var(--panel-border)",
                  borderRadius: 4,
                  padding: "8px 10px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                }}
              >
                {edit?.name === r.name && edit.mode === "rename" ? (
                  <InlineEditor
                    label="Rename remote"
                    disabled={busy}
                    onSave={() => saveRename(r.name)}
                    onCancel={() => setEdit(null)}
                  >
                    <input
                      autoFocus
                      value={draftName}
                      onChange={(e) => setDraftName(e.target.value)}
                      placeholder="new name"
                      style={inputStyle}
                    />
                  </InlineEditor>
                ) : edit?.name === r.name && edit.mode === "urls" ? (
                  <InlineEditor
                    label={`Edit URLs — ${r.name}`}
                    disabled={busy}
                    onSave={() => saveUrls(r)}
                    onCancel={() => setEdit(null)}
                  >
                    <UrlField label="fetch" value={draftFetch} onChange={setDraftFetch} />
                    <UrlField label="push" value={draftPush} onChange={setDraftPush} />
                  </InlineEditor>
                ) : edit?.name === r.name && edit.mode === "remove" ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <span style={{ fontSize: "var(--fz-md)" }}>
                      Remove remote <strong>{r.name}</strong>? Its remote-tracking refs will be deleted.
                    </span>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      <Button variant="danger" disabled={busy} onClick={() => doRemove(r.name)}>
                        Remove
                      </Button>
                      <button disabled={busy} onClick={() => setEdit(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                      <strong style={{ fontSize: "var(--fz-lg)" }}>{r.name}</strong>
                      {busyNet === `fetch:${r.name}` || busyNet === `prune:${r.name}` ? (
                        <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)", display: "flex", alignItems: "center", gap: 6 }}>
                          <span className="legit-spinner" aria-hidden="true" />
                          {busyNet.startsWith("fetch") ? "Fetching…" : "Pruning…"}
                          <button onClick={cancelNet} style={linkBtnStyle}>Cancel</button>
                        </span>
                      ) : null}
                    </div>
                    <UrlRow label="fetch" url={r.fetch_url} />
                    {r.push_url !== r.fetch_url && <UrlRow label="push" url={r.push_url} />}
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 2 }}>
                      <button
                        disabled={blocked}
                        onClick={() =>
                          runNet(`fetch:${r.name}`, (opId) =>
                            repoFetch(repo.id, { all: false, prune: false, remote: r.name }, opId),
                          )
                        }
                        style={{ display: "flex", alignItems: "center", gap: 4 }}
                      >
                        <FetchIcon /> Fetch
                      </button>
                      <button
                        disabled={blocked}
                        title="Delete local remote-tracking refs that no longer exist on the remote"
                        onClick={() =>
                          runNet(`prune:${r.name}`, (opId) => repoPruneRemote(repo.id, r.name, opId))
                        }
                      >
                        Prune
                      </button>
                      <button disabled={blocked} onClick={() => openUrls(r)}>Edit URLs</button>
                      <button disabled={blocked} onClick={() => openRename(r)}>Rename</button>
                      <button
                        disabled={blocked}
                        onClick={() => {
                          setError(null);
                          // Global destructive-confirmation setting: when off,
                          // remove runs immediately.
                          if (confirmDestructive) setEdit({ name: r.name, mode: "remove" });
                          else void doRemove(r.name);
                        }}
                      >
                        Remove
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        )}

        <AddRemoteForm disabled={blocked} onAdd={addRemote} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

function AddRemoteForm({
  disabled,
  onAdd,
}: {
  disabled: boolean;
  onAdd: (name: string, url: string) => Promise<boolean>;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");

  const submit = async () => {
    if (name.trim() === "" || url.trim() === "") return;
    if (await onAdd(name.trim(), url.trim())) {
      setName("");
      setUrl("");
    }
  };

  return (
    <div
      style={{
        borderTop: "1px solid var(--panel-border)",
        paddingTop: 10,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <span style={{ fontSize: "var(--fz-sm)", textTransform: "uppercase", letterSpacing: 0.5, color: "var(--subtle-fg)" }}>
        Add remote
      </span>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="name (e.g. origin)"
          style={{ ...inputStyle, flex: "0 1 30%", minWidth: 0 }}
        />
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="URL (https://… or git@…)"
          style={{ ...inputStyle, flex: 1, minWidth: 0 }}
        />
        <Button
          variant="primary"
          disabled={disabled || name.trim() === "" || url.trim() === ""}
          onClick={submit}
        >
          Add
        </Button>
      </div>
    </div>
  );
}

function UrlField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)", width: 40 }}>{label}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} style={{ ...inputStyle, flex: 1 }} />
    </label>
  );
}

function UrlRow({ label, url }: { label: string; url: string }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 6, minWidth: 0 }}>
      <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)", width: 40, flexShrink: 0 }}>{label}</span>
      <span
        title={url}
        style={{ fontFamily: "monospace", fontSize: "var(--fz-sm)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
      >
        {url || "—"}
      </span>
    </div>
  );
}

const inputStyle: React.CSSProperties = { fontSize: "var(--fz-md)", fontFamily: "monospace" };

const linkBtnStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--accent)",
  cursor: "pointer",
  fontSize: "var(--fz-sm)",
  padding: 0,
};
