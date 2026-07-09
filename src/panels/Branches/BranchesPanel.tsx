import { useCallback, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useActiveRepo } from "../../store/repos";
import { usePanelFocusEffect } from "../PanelApiContext";
import { invalidateRepoDomains } from "../../lib/repoInvalidation";
import {
  repoBranches,
  repoListRemotes,
  repoSwitchBranch,
  repoDeleteBranch,
  repoRenameBranch,
  repoCreateBranch,
  repoCheckoutRemoteBranch,
  repoMerge,
  repoRebase,
  repoSetUpstream,
} from "../../lib/commands";
import { groupRemoteBranches, shortRemoteBranchName } from "../../lib/branchGroups";
import { ChevronDownIcon } from "../../icons";
import { Button } from "../shared/buttons";
import { notifySwitchOutcome, formatSwitchError } from "../../lib/switchFeedback";
import { notifyMergeOutcome, notifyOpError, notifyRebaseOutcome } from "../../lib/mergeFeedback";
import { OP_DOMAINS, useOpState } from "../../lib/useOpState";
import { useConfirmDestructive } from "../../store/settings";
import type { Branch, MergeOptions, Remote } from "../../lib/types";
import { formatAppError } from "../../lib/types";
import { PanelLoadingBar } from "../shared/PanelLoadingBar";
import { InlineEditor } from "../shared/InlineEditor";
import { PanelContextMenuProvider } from "../Commits/menu/PanelContextMenu";
import { BranchMenuSection, RemoteBranchMenuSection } from "../Commits/menu/BranchMenuSection";

// Switching can create/consume an auto-stash, so "stashes" is invalidated too.
const AFFECTED_DOMAINS = ["branches", "log", "status", "tracking", "stashes"];

type EditState =
  | { name: string; mode: "rename" }
  | { name: string; mode: "delete" }
  | null;

/** localStorage key for the collapsed-remote-groups set (by remote name). */
const COLLAPSED_REMOTES_KEY = "legit.branches-collapsed-remotes";

function loadCollapsedRemotes(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSED_REMOTES_KEY) ?? "{}");
  } catch {
    return {};
  }
}

const monoInput: React.CSSProperties = {
  fontSize: "var(--fz-md)",
  fontFamily: "monospace",
};

/**
 * Branches section — local + remote branch lists with checkout / rename /
 * delete / create. Rendered as a pane inside the combined Refs panel
 * (see `Refs/RefsPanel`), which supplies the header — body-only.
 */
export function BranchesSection() {
  const repo = useActiveRepo();
  const queryClient = useQueryClient();

  const { data: branches = [], isFetching, refetch } = useQuery<Branch[]>({
    queryKey: [repo?.id, "branches"],
    queryFn: () => repoBranches(repo!.id),
    enabled: !!repo,
    staleTime: 5_000,
  });

  const { data: remotes = [] } = useQuery<Remote[]>({
    queryKey: [repo?.id, "remotes"],
    queryFn: () => repoListRemotes(repo!.id),
    enabled: !!repo,
    staleTime: 5_000,
  });

  const reload = useCallback(() => { refetch(); }, [refetch]);
  usePanelFocusEffect(reload);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState<EditState>(null);
  const [draftName, setDraftName] = useState("");
  const [createName, setCreateName] = useState("");
  const [createFrom, setCreateFrom] = useState("");

  const invalidate = useCallback(() => {
    if (!repo) return;
    invalidateRepoDomains(queryClient, repo.id, AFFECTED_DOMAINS);
  }, [queryClient, repo]);

  // Delayed busy + re-entry guard (see CLAUDE.md: fast ops must not flicker).
  // Rename/delete/create/set-upstream are near-instant local git calls.
  const runningRef = useRef(false);
  const runMut = useCallback(async (fn: () => Promise<unknown>): Promise<boolean> => {
    if (!repo || runningRef.current) return false;
    runningRef.current = true;
    const busyTimer = window.setTimeout(() => setBusy(true), 150);
    setError(null);
    try {
      await fn();
      invalidate();
      return true;
    } catch (e) {
      setError(formatAppError(e));
      return false;
    } finally {
      window.clearTimeout(busyTimer);
      runningRef.current = false;
      setBusy(false);
    }
  }, [repo, invalidate]);

  const localBranches = branches.filter((b) => !b.is_remote);
  const remoteBranches = branches.filter((b) => b.is_remote);

  // Map full upstream ref → local branch for "tracking" labels + divergence.
  const trackedRemotes = new Map(
    localBranches
      .filter((b) => b.upstream)
      .map((b) => [b.upstream!, b]),
  );

  const remoteGroups = useMemo(
    () =>
      groupRemoteBranches(
        branches.filter((b) => b.is_remote),
        remotes.map((r) => r.name),
      ),
    [branches, remotes],
  );

  const [collapsedRemotes, setCollapsedRemotes] = useState<Record<string, boolean>>(
    loadCollapsedRemotes,
  );
  const toggleRemoteCollapsed = (remote: string) => {
    setCollapsedRemotes((prev) => {
      const next = { ...prev, [remote]: !prev[remote] };
      try {
        localStorage.setItem(COLLAPSED_REMOTES_KEY, JSON.stringify(next));
      } catch {
        // best-effort persistence only
      }
      return next;
    });
  };

  const openRename = (b: Branch) => {
    setError(null);
    setDraftName(b.name);
    setEdit({ name: b.name, mode: "rename" });
  };

  const saveRename = async (name: string) => {
    const next = draftName.trim();
    if (!next || next === name) { setEdit(null); return; }
    if (await runMut(() => repoRenameBranch(repo!.id, name, next))) setEdit(null);
  };

  // With destructive confirmations off, Delete runs a safe delete
  // immediately (force delete stays reachable via the ref-chip menu).
  const confirmDestructive = useConfirmDestructive();
  const openDelete = (b: Branch) => {
    setError(null);
    if (!confirmDestructive) {
      void doDelete(b.name, false);
      return;
    }
    setEdit({ name: b.name, mode: "delete" });
  };

  const doDelete = async (name: string, force: boolean) => {
    if (await runMut(() => repoDeleteBranch(repo!.id, name, force))) setEdit(null);
  };

  const doCheckout = async (name: string) => {
    if (!repo) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await repoSwitchBranch(repo.id, name);
      invalidate();
      notifySwitchOutcome(outcome, name);
    } catch (e) {
      setError(formatSwitchError(e));
    } finally {
      setBusy(false);
    }
  };

  const doRemoteCheckout = useCallback(async (fullRef: string) => {
    if (!repo) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await repoCheckoutRemoteBranch(repo.id, fullRef);
      invalidate();
      notifySwitchOutcome(outcome, fullRef.replace(/^refs\/remotes\//, ""));
    } catch (e) {
      setError(formatSwitchError(e));
    } finally {
      setBusy(false);
    }
  }, [repo, invalidate]);

  const doSetUpstream = async (name: string, upstream: string | null) => {
    await runMut(() => repoSetUpstream(repo!.id, name, upstream));
  };

  // Existing same-name remote-tracking branches a local branch could track.
  const upstreamCandidatesFor = (name: string) =>
    remoteBranches.filter((b) => b.name.endsWith(`/${name}`)).map((b) => b.name);

  const doCreate = async () => {
    const name = createName.trim();
    if (!name) return;
    const from = createFrom.trim() || undefined;
    if (await runMut(() => repoCreateBranch(repo!.id, name, from))) {
      setCreateName("");
      setCreateFrom("");
    }
  };

  // Merge/rebase entry points (row context menu, shared sections): need the
  // current branch for labels; hidden while an op is already in progress.
  const currentBranch = localBranches.find((b) => b.is_current)?.name ?? null;
  const opState = useOpState(repo?.id);
  const opInProgress = !!opState && opState.kind !== "none";

  const handleMerge = useCallback(async (target: string, options: MergeOptions) => {
    if (!repo) return;
    setBusy(true);
    try {
      const outcome = await repoMerge(repo.id, target, options);
      invalidateRepoDomains(queryClient, repo.id, OP_DOMAINS);
      notifyMergeOutcome(outcome, target);
    } catch (e) {
      // A failed merge can still leave state behind; refresh either way.
      invalidateRepoDomains(queryClient, repo.id, OP_DOMAINS);
      notifyOpError(e);
    } finally {
      setBusy(false);
    }
  }, [repo, queryClient]);

  const handleRebaseOnto = useCallback(async (onto: string) => {
    if (!repo) return;
    setBusy(true);
    try {
      const outcome = await repoRebase(repo.id, onto);
      invalidateRepoDomains(queryClient, repo.id, OP_DOMAINS);
      notifyRebaseOutcome(outcome, onto);
    } catch (e) {
      invalidateRepoDomains(queryClient, repo.id, OP_DOMAINS);
      notifyOpError(e);
    } finally {
      setBusy(false);
    }
  }, [repo, queryClient]);

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
    <PanelContextMenuProvider baseline={[]}>
      {({ openMenu, closeMenu }) => (
    <div className="legit-panel" style={{ display: "flex", flexDirection: "column" }}>
      <PanelLoadingBar active={isFetching} />
      <div
        className="legit-panel__body"
        style={{ display: "flex", flexDirection: "column", gap: 10 }}
      >
        {error && (
          <pre className="legit-error" style={{ margin: 0, fontSize: "var(--fz-md)" }}>
            {error}
          </pre>
        )}

        {localBranches.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <SectionLabel>Local</SectionLabel>
            {localBranches.map((b) => (
              <LocalBranchRow
                key={b.name}
                branch={b}
                edit={edit}
                draftName={draftName}
                busy={busy}
                onDraftChange={setDraftName}
                onOpenRename={() => openRename(b)}
                onSaveRename={() => saveRename(b.name)}
                onOpenDelete={() => openDelete(b)}
                onDoDelete={(force) => doDelete(b.name, force)}
                onCheckout={() => doCheckout(b.name)}
                onCancelEdit={() => setEdit(null)}
                onContextMenu={(e) =>
                  openMenu(
                    e,
                    <BranchMenuSection
                      name={b.name}
                      isCurrent={b.is_current}
                      currentBranch={currentBranch}
                      opInProgress={opInProgress}
                      upstream={b.upstream}
                      upstreamCandidates={upstreamCandidatesFor(b.name)}
                      onCheckout={() => { closeMenu(); doCheckout(b.name); }}
                      onRename={() => { closeMenu(); openRename(b); }}
                      onSetUpstream={(up) => { closeMenu(); doSetUpstream(b.name, up); }}
                      onDelete={(force) => { closeMenu(); doDelete(b.name, force); }}
                      onMerge={(options) => { closeMenu(); handleMerge(b.name, options); }}
                      onRebaseOnto={() => { closeMenu(); handleRebaseOnto(b.name); }}
                    />,
                  )
                }
              />
            ))}
          </div>
        )}

        {remoteGroups.map((group) => {
          const collapsed = !!collapsedRemotes[group.remote];
          return (
            <div key={group.remote} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <RemoteGroupHeader
                remote={group.remote}
                count={group.branches.length}
                collapsed={collapsed}
                onToggle={() => toggleRemoteCollapsed(group.remote)}
              />
              {!collapsed && group.branches.map((b) => {
                const fullRef = `refs/remotes/${b.name}`;
                const trackingBranch = trackedRemotes.get(fullRef);
                return (
                  <RemoteBranchRow
                    key={b.name}
                    branch={b}
                    shortName={shortRemoteBranchName(b.name, group.remote)}
                    trackingBranch={trackingBranch}
                    busy={busy}
                    onCheckout={() => doRemoteCheckout(b.name)}
                    onContextMenu={(e) =>
                      openMenu(
                        e,
                        <RemoteBranchMenuSection
                          remoteName={b.name}
                          currentBranch={currentBranch}
                          opInProgress={opInProgress}
                          onCheckout={() => { closeMenu(); doRemoteCheckout(b.name); }}
                          onMerge={(options) => { closeMenu(); handleMerge(b.name, options); }}
                          onRebaseOnto={() => { closeMenu(); handleRebaseOnto(b.name); }}
                        />,
                      )
                    }
                  />
                );
              })}
            </div>
          );
        })}

        <div
          style={{
            borderTop: "1px solid var(--panel-border)",
            paddingTop: 10,
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          <SectionLabel>New branch</SectionLabel>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <input
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && doCreate()}
              placeholder="name"
              style={{ ...monoInput, flex: "0 1 35%", minWidth: 0 }}
            />
            <input
              value={createFrom}
              onChange={(e) => setCreateFrom(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && doCreate()}
              placeholder="from (branch / tag / SHA, or blank for HEAD)"
              style={{ ...monoInput, flex: 1, minWidth: 0 }}
            />
            <Button
              variant="primary"
              disabled={busy || !createName.trim()}
              onClick={doCreate}
            >
              Create
            </Button>
          </div>
        </div>
      </div>
    </div>
      )}
    </PanelContextMenuProvider>
  );
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontSize: "var(--fz-sm)",
        textTransform: "uppercase",
        letterSpacing: 0.5,
        color: "var(--subtle-fg)",
      }}
    >
      {children}
    </span>
  );
}

/** Collapsible per-remote group heading in the remote-branches area. */
function RemoteGroupHeader({
  remote,
  count,
  collapsed,
  onToggle,
}: {
  remote: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      title={collapsed ? `Expand ${remote}` : `Collapse ${remote}`}
      style={{
        background: "none",
        border: "none",
        padding: 0,
        display: "flex",
        alignItems: "center",
        gap: 4,
        cursor: "pointer",
        color: "var(--subtle-fg)",
        alignSelf: "flex-start",
      }}
    >
      <ChevronDownIcon
        style={{
          transform: collapsed ? "rotate(-90deg)" : undefined,
          transition: "transform 120ms",
        }}
      />
      <SectionLabel>
        {remote} ({count})
      </SectionLabel>
    </button>
  );
}

/**
 * Ahead/behind arrows for a local branch relative to its upstream, or an
 * "upstream gone" warning when the configured upstream ref no longer exists.
 */
function DivergenceBadge({ branch }: { branch: Branch }) {
  if (branch.upstream_gone) {
    return (
      <span style={{ fontSize: "var(--fz-sm)", color: "var(--warning-fg)", flexShrink: 0 }}>
        upstream gone
      </span>
    );
  }
  if (!branch.ahead && !branch.behind) return null;
  return (
    <span
      className="legit-subtle"
      style={{ fontSize: "var(--fz-sm)", fontFamily: "monospace", flexShrink: 0 }}
      title="Commits ahead/behind the upstream"
    >
      {branch.ahead ? `↑${branch.ahead}` : ""}
      {branch.ahead && branch.behind ? " " : ""}
      {branch.behind ? `↓${branch.behind}` : ""}
    </span>
  );
}

function LocalBranchRow({
  branch,
  edit,
  draftName,
  busy,
  onDraftChange,
  onOpenRename,
  onSaveRename,
  onOpenDelete,
  onDoDelete,
  onCheckout,
  onCancelEdit,
  onContextMenu,
}: {
  branch: Branch;
  edit: EditState;
  draftName: string;
  busy: boolean;
  onDraftChange: (v: string) => void;
  onOpenRename: () => void;
  onSaveRename: () => void;
  onOpenDelete: () => void;
  onDoDelete: (force: boolean) => void;
  onCheckout: () => void;
  onCancelEdit: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const isEditing = edit?.name === branch.name;
  const mono: React.CSSProperties = { fontSize: "var(--fz-md)", fontFamily: "monospace" };

  return (
    <div
      onContextMenu={onContextMenu}
      style={{
        border: "1px solid var(--panel-border)",
        borderRadius: 4,
        padding: "8px 10px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      {isEditing && edit?.mode === "rename" ? (
        <InlineEditor
          label="Rename branch"
          disabled={busy}
          onSave={onSaveRename}
          onCancel={onCancelEdit}
        >
          <input
            autoFocus
            value={draftName}
            onChange={(e) => onDraftChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onSaveRename();
              if (e.key === "Escape") onCancelEdit();
            }}
            style={mono}
          />
        </InlineEditor>
      ) : isEditing && edit?.mode === "delete" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ fontSize: "var(--fz-md)" }}>
            Delete <strong>{branch.name}</strong>?
          </span>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <Button variant="danger" disabled={busy} onClick={() => onDoDelete(false)}>
              Delete
            </Button>
            <button disabled={busy} onClick={() => onDoDelete(true)}>
              Force Delete
            </button>
            <button disabled={busy} onClick={onCancelEdit}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span
            style={{ fontSize: "var(--fz-lg)", fontFamily: "monospace", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            {branch.is_current && (
              <span style={{ color: "var(--accent)", marginRight: 6 }}>●</span>
            )}
            {branch.name}
          </span>
          <DivergenceBadge branch={branch} />
          <div style={{ display: "flex", gap: 6, flexShrink: 0, flexWrap: "wrap" }}>
            {!branch.is_current && (
              <button disabled={busy} onClick={onCheckout}>
                Checkout
              </button>
            )}
            <button disabled={busy} onClick={onOpenRename}>
              Rename
            </button>
            <button disabled={busy} onClick={onOpenDelete}>
              Delete
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function RemoteBranchRow({
  branch,
  shortName,
  trackingBranch,
  busy,
  onCheckout,
  onContextMenu,
}: {
  branch: Branch;
  /** Branch name without the remote prefix (the group header carries it). */
  shortName: string;
  /** The local branch tracking this remote branch, if any. */
  trackingBranch: Branch | undefined;
  busy: boolean;
  onCheckout: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  return (
    <div
      onContextMenu={onContextMenu}
      title={branch.name}
      style={{
        border: "1px solid var(--panel-border)",
        borderRadius: 4,
        padding: "8px 10px",
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexWrap: "wrap",
      }}
    >
      <span
        style={{
          fontSize: "var(--fz-lg)",
          fontFamily: "monospace",
          flex: 1,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {shortName}
      </span>
      {trackingBranch ? (
        <>
          <DivergenceBadge branch={trackingBranch} />
          <span
            className="legit-subtle"
            style={{
              fontSize: "var(--fz-sm)",
              flexShrink: 0,
              maxWidth: "100%",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            tracking: {trackingBranch.name}
          </span>
        </>
      ) : (
        <button disabled={busy} onClick={onCheckout} style={{ flexShrink: 0 }}>
          Checkout
        </button>
      )}
    </div>
  );
}
