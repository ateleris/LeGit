import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useActiveRepo, useRepoStore } from "../../store/repos";
import { usePanelFocusEffect } from "../PanelApiContext";
import {
  repoSubmoduleAdd,
  repoSubmoduleCreateBranch,
  repoSubmoduleDeleteGitdir,
  repoSubmoduleFetch,
  repoSubmoduleGitdirInfo,
  repoSubmoduleRemove,
  repoSubmoduleSetBranch,
  repoSubmoduleSetUrl,
  repoSubmoduleSync,
  repoSubmoduleUpdate,
  repoSubmoduleUpdateRemote,
  repoSubmodules,
} from "../../lib/commands";
import {
  formatAppError,
  type SubmoduleGitdirInfo,
  type SubmoduleInfo,
  type SubmoduleUpdateStrategy,
} from "../../lib/types";
import { invalidateRepoDomains } from "../../lib/repoInvalidation";
import { notifySubmoduleUpdateResults } from "../../lib/submodules";
import { notify } from "../../store/notifications";
import { PanelLoadingBar } from "../shared/PanelLoadingBar";
import { usePanelRunner } from "../shared/usePanelRunner";
import { ToolbarButton } from "../shared/ToolbarButton";
import { Button } from "../shared/buttons";
import { useConfirmDestructive } from "../../store/settings";
import { SubmoduleRow } from "./SubmoduleRow";

// Submodule ops touch the submodule list, the status view, and (after an
// update moves pointers) the log decorations.
const AFFECTED_DOMAINS = ["submodules", "status", "log"];

/**
 * Submodules section (spec 2026-07-08, tiers 2-3): rows with state +
 * operations, bulk update, `update --remote` with a strategy select, an add
 * form, and the magit-grade remove flow - remove keeps `.git/modules/<name>`
 * and a SEPARATE, always-explicit prompt offers gitdir deletion (with an
 * unpushed-commits warning), because that step destroys history for good.
 */
export function SubmodulesSection() {
  const repo = useActiveRepo();
  const queryClient = useQueryClient();
  const openRepo = useRepoStore((s) => s.openRepo);
  const confirmDestructive = useConfirmDestructive();

  const { data: subs = [], isFetching, refetch } = useQuery<SubmoduleInfo[]>({
    queryKey: [repo?.id, "submodules"],
    queryFn: () => repoSubmodules(repo!.id),
    enabled: !!repo,
    staleTime: 5_000,
  });
  const reload = useCallback(() => { refetch(); }, [refetch]);
  usePanelFocusEffect(reload);

  const [error, setError] = useState<string | null>(null);
  const [recursive, setRecursive] = useState(false);
  const [strategy, setStrategy] = useState<SubmoduleUpdateStrategy>("checkout");
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null); // path
  // Post-remove gitdir prompt: name + info of the retained gitdir.
  const [gitdirPrompt, setGitdirPrompt] = useState<
    { name: string; info: SubmoduleGitdirInfo } | null
  >(null);
  const [addUrl, setAddUrl] = useState("");
  const [addPath, setAddPath] = useState("");
  const [addBranch, setAddBranch] = useState("");

  // Error banners, pending remove confirms, and the gitdir prompt all refer
  // to a specific repo - clear them when the active repo changes, or they
  // linger over the next repo's submodule list.
  const repoId = repo?.id;
  useEffect(() => {
    setError(null);
    setConfirmRemove(null);
    setGitdirPrompt(null);
  }, [repoId]);

  const { busy, run } = usePanelRunner({
    enabled: !!repo,
    onStart: () => setError(null),
    onSuccess: () => invalidateRepoDomains(queryClient, repo!.id, AFFECTED_DOMAINS),
    onError: (e) => setError(formatAppError(e)),
  });

  // A submodule opens as its own peer repo tab; `register_open_repo` dedupes
  // by canonical toplevel, so re-opening focuses the existing tab.
  const openSubmodule = (info: SubmoduleInfo) => {
    if (!repo || !info.state.populated) return;
    openRepo(`${repo.path}/${info.path}`).catch((e) => notify.error(formatAppError(e)));
  };

  const updateAll = () =>
    run(() =>
      repoSubmoduleUpdate(repo!.id, { init: true, recursive, paths: [] }, crypto.randomUUID()),
    );

  const pullLatest = (paths: string[]) =>
    run(async () => {
      const results = await repoSubmoduleUpdateRemote(
        repo!.id,
        paths,
        strategy,
        crypto.randomUUID(),
      );
      notifySubmoduleUpdateResults(results);
    });

  const doRemove = (s: SubmoduleInfo) =>
    run(async () => {
      await repoSubmoduleRemove(repo!.id, s.path);
      setConfirmRemove(null);
      // Second stage: offer gitdir deletion only if one was retained. This
      // prompt is ALWAYS explicit (even with the confirm setting off): it
      // permanently destroys any unpushed commits (spec: separate step).
      const info = await repoSubmoduleGitdirInfo(repo!.id, s.name);
      if (info) setGitdirPrompt({ name: s.name, info });
    });

  const requestRemove = (s: SubmoduleInfo) => {
    setError(null);
    if (confirmDestructive) setConfirmRemove(s.path);
    else void doRemove(s);
  };

  const doAdd = () =>
    run(async () => {
      const url = addUrl.trim();
      const path = addPath.trim();
      if (!url || !path) return;
      await repoSubmoduleAdd(repo!.id, url, path, addBranch.trim() || null, crypto.randomUUID());
      setAddUrl("");
      setAddPath("");
      setAddBranch("");
    });

  if (!repo) {
    return (
      <div className="legit-panel">
        <div className="legit-panel__body">
          <span className="legit-subtle">No repository open.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="legit-panel" style={{ display: "flex", flexDirection: "column" }}>
      <PanelLoadingBar active={isFetching} />
      <div
        className="legit-panel__body"
        style={{ display: "flex", flexDirection: "column", gap: 6 }}
      >
        {error && (
          <pre className="legit-error" style={{ margin: 0, fontSize: "var(--fz-md)" }}>
            {error}
          </pre>
        )}

        {gitdirPrompt && (
          <div
            style={{
              padding: "8px 10px",
              border: "1px solid var(--panel-border)",
              borderRadius: 4,
              background: "var(--button-hover-bg)",
            }}
          >
            <div style={{ marginBottom: 8, fontSize: "var(--fz-md)" }}>
              Submodule removed. Its repository data is kept at{" "}
              <span style={{ fontFamily: "monospace" }}>{gitdirPrompt.info.path}</span> (so it
              can be re-added later).
              {gitdirPrompt.info.unpushed && (
                <strong>
                  {" "}
                  It contains commits that are on no remote - deleting destroys them permanently.
                </strong>
              )}
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <Button
                variant="danger"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await repoSubmoduleDeleteGitdir(repo.id, gitdirPrompt.name);
                    setGitdirPrompt(null);
                  })
                }
              >
                Delete repository data
              </Button>
              <button disabled={busy} onClick={() => setGitdirPrompt(null)}>
                Keep
              </button>
            </div>
          </div>
        )}

        {subs.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <ToolbarButton
              label="Update all"
              title="git submodule update --init: check out the recorded commit of every submodule"
              disabled={busy}
              onClick={updateAll}
            />
            <ToolbarButton
              label="Pull latest"
              title="git submodule update --remote: fetch every submodule's tracked branch and stage the pointers"
              disabled={busy}
              onClick={() => pullLatest([])}
            />
            <select
              value={strategy}
              onChange={(e) => setStrategy(e.target.value as SubmoduleUpdateStrategy)}
              title="How update --remote integrates the fetched branch"
              style={{ fontSize: "var(--fz-sm)" }}
            >
              <option value="checkout">checkout</option>
              <option value="rebase">rebase</option>
              <option value="merge">merge</option>
            </select>
            <label
              className="legit-subtle"
              style={{ display: "flex", alignItems: "center", gap: 4, fontSize: "var(--fz-sm)" }}
              title="Recurse into nested submodules (--recursive; Update all only)"
            >
              <input
                type="checkbox"
                checked={recursive}
                onChange={(e) => setRecursive(e.target.checked)}
              />
              recursive
            </label>
          </div>
        )}

        {subs.length === 0 ? (
          <span className="legit-subtle" style={{ fontSize: "var(--fz-md)" }}>
            No submodules.
          </span>
        ) : (
          subs.map((s) => (
            <SubmoduleRow
              key={s.name}
              info={s}
              busy={busy}
              removing={confirmRemove === s.path ? "confirm" : null}
              onOpen={() => openSubmodule(s)}
              onInitUpdate={() =>
                run(() =>
                  repoSubmoduleUpdate(
                    repo.id,
                    { init: true, recursive: false, paths: [s.path] },
                    crypto.randomUUID(),
                  ),
                )
              }
              onUpdate={() =>
                run(() =>
                  repoSubmoduleUpdate(
                    repo.id,
                    { init: false, recursive: false, paths: [s.path] },
                    crypto.randomUUID(),
                  ),
                )
              }
              onPullLatest={() => pullLatest([s.path])}
              onSync={() =>
                run(async () => {
                  await repoSubmoduleSync(repo.id, [s.path], false);
                  notify.success(`Synced URL for '${s.path}'`);
                })
              }
              onFetch={() => run(() => repoSubmoduleFetch(repo.id, s.path, crypto.randomUUID()))}
              onSetUrl={(url) => run(() => repoSubmoduleSetUrl(repo.id, s.path, url))}
              onSetBranch={(branch) =>
                run(() => repoSubmoduleSetBranch(repo.id, s.path, branch))
              }
              onCreateBranch={(name) =>
                run(() => repoSubmoduleCreateBranch(repo.id, s.path, name))
              }
              onRemove={() => requestRemove(s)}
              onConfirmRemove={() => void doRemove(s)}
              onCancelRemove={() => setConfirmRemove(null)}
            />
          ))
        )}

        <div
          style={{
            borderTop: "1px solid var(--panel-border)",
            paddingTop: 10,
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          <span
            style={{
              fontSize: "var(--fz-sm)",
              textTransform: "uppercase",
              letterSpacing: 0.5,
              color: "var(--subtle-fg)",
            }}
          >
            Add submodule
          </span>
          <input
            value={addUrl}
            onChange={(e) => setAddUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && doAdd()}
            placeholder="repository URL"
            style={{ fontSize: "var(--fz-md)", fontFamily: "monospace" }}
          />
          <div style={{ display: "flex", gap: 6 }}>
            <input
              value={addPath}
              onChange={(e) => setAddPath(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && doAdd()}
              placeholder="path"
              style={{ fontSize: "var(--fz-md)", fontFamily: "monospace", flex: 1 }}
            />
            <input
              value={addBranch}
              onChange={(e) => setAddBranch(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && doAdd()}
              placeholder="branch (optional)"
              style={{ fontSize: "var(--fz-md)", fontFamily: "monospace", width: "10em" }}
            />
            <Button
              variant="primary"
              disabled={busy || !addUrl.trim() || !addPath.trim()}
              onClick={doAdd}
            >
              Add
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
