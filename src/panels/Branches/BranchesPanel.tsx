import { useCallback, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useActiveRepo } from "../../store/repos";
import { usePanelFocusEffect } from "../PanelApiContext";
import { invalidateRepoDomains } from "../../lib/repoInvalidation";
import { autoUpdateSubmodules } from "../../lib/submodules";
import {
  repoBranches,
  repoListRemotes,
  repoSwitchBranch,
  repoDeleteBranch,
  repoRenameBranch,
  repoCreateBranch,
  repoCheckoutRemoteBranch,
  repoDeleteRemoteBranch,
  repoMerge,
  repoRebase,
  repoSetUpstream,
} from "../../lib/commands";
import { groupRemoteBranches, shortRemoteBranchName, splitRemoteRef } from "../../lib/branchGroups";
import { ChevronDownIcon, ChevronRightIcon } from "../../icons";
import { Button } from "../shared/buttons";
import { ToolbarButton } from "../shared/ToolbarButton";
import { segStyle } from "../shared/segmented";
import { branchTreeRows, folderHoldsCurrent, leafName } from "./branchTree";
import {
  notifySwitchOutcome,
  notifyRemoteCheckoutOutcome,
  formatSwitchError,
} from "../../lib/switchFeedback";
import { remoteOpErrorMessage } from "../../lib/pushFeedback";
import { PUSH_DOMAINS } from "../Commits/useCommitActions";
import { pushWithTagFollowUp } from "../../lib/autoPushTags";
import { notifyMergeOutcome, notifyOpError, notifyRebaseOutcome } from "../../lib/mergeFeedback";
import { notify } from "../../store/notifications";
import { confirmDialog } from "../../store/confirm";
import { OP_DOMAINS, useOpState } from "../../lib/useOpState";
import { useConfirmDestructive, useSettingsStore } from "../../store/settings";
import { coerceRefsSortMode, sortRefs } from "../../lib/refSort";
import type { Branch, MergeOptions, Remote } from "../../lib/types";
import { formatAppError } from "../../lib/types";
import { PanelLoadingBar } from "../shared/PanelLoadingBar";
import { InlineEditor } from "../shared/InlineEditor";
import { usePanelRunner } from "../shared/usePanelRunner";
import { isRowBackgroundClick, jumpPanelsToCommit } from "../shared/jumpToCommit";
import { PanelContextMenuProvider } from "../Commits/menu/PanelContextMenu";
import { BranchMenuSection, RemoteBranchMenuSection } from "../Commits/menu/BranchMenuSection";

// Switching can create/consume an auto-stash, so "stashes" is invalidated too.
const AFFECTED_DOMAINS = ["branches", "log", "status", "tracking", "stashes"];

type EditState = { name: string; mode: "rename" } | null;

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

  const [edit, setEdit] = useState<EditState>(null);
  const [draftName, setDraftName] = useState("");
  const [createName, setCreateName] = useState("");
  const [createFrom, setCreateFrom] = useState("");

  const invalidate = useCallback(() => {
    if (!repo) return;
    invalidateRepoDomains(queryClient, repo.id, AFFECTED_DOMAINS);
  }, [queryClient, repo]);

  // Rename/delete/create/set-upstream are near-instant local git calls.
  // Errors surface as toasts (never panel-embedded banners: those scroll out
  // of view and reflow the pane); full detail is in the Git Command Log.
  const { busy: mutBusy, run: runMut } = usePanelRunner({
    enabled: !!repo,
    onSuccess: invalidate,
    onError: (e) => notify.error(formatAppError(e)),
  });
  // Checkouts get their own runner: same delayed-busy/guard, but switch
  // failures classify through formatSwitchError (WouldOverwrite... etc.).
  const { busy: switchBusy, run: runSwitch } = usePanelRunner({
    enabled: !!repo,
    onSuccess: invalidate,
    onError: (e) => notify.error(formatSwitchError(e)),
  });
  // Merge/rebase: notify-based feedback, and a failed attempt can still
  // leave op state behind - domains refresh on settle either way. "stashes"
  // too: rebase runs --autostash, which creates and reapplies (or keeps) a
  // stash entry.
  const { busy: opBusy, run: runOp } = usePanelRunner({
    enabled: !!repo,
    onSettled: () => {
      if (repo) invalidateRepoDomains(queryClient, repo.id, [...OP_DOMAINS, "stashes"]);
    },
    onError: notifyOpError,
  });
  // Remote-branch deletion / push are genuine network ops: busy may show
  // immediately per convention (delayMs 0), guard still applies. Failures
  // get the classified remote wording (auth, rejected push, …).
  const { busy: netBusy, run: runNet } = usePanelRunner({
    enabled: !!repo,
    delayMs: 0,
    onError: (e) => notify.error(remoteOpErrorMessage(e)),
  });
  const busy = mutBusy || switchBusy || opBusy || netBusy;

  // User-selected sort order (global setting) applied to the local list and
  // within each remote group; group order itself stays the remotes' order.
  const sortMode = coerceRefsSortMode(useSettingsStore((s) => s.settings?.refs_sort_mode));
  // Global setting (default on): creating a branch also checks it out.
  const checkoutNewBranch = useSettingsStore((s) => s.settings?.checkout_new_branch ?? true);
  // Global list style: folder tree vs flat list. Tree mode uses the tree's
  // own ordering (folders first, alphabetical); refs_sort_mode applies to
  // the flat list only.
  const branchView = useSettingsStore((s) =>
    s.settings?.branch_list_view === "tree" ? "tree" : "flat",
  );
  const setBranchListView = useSettingsStore((s) => s.setBranchListView);
  // Collapse state is ephemeral and per-list (local + one per remote group),
  // keyed by a list id so folder paths can repeat across lists. Absent from
  // the set = expanded (folders default to expanded).
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  const toggleFolder = useCallback((listId: string, path: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      const key = `${listId}\0${path}`;
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const collapsedFor = useCallback(
    (listId: string): ReadonlySet<string> => {
      const prefix = `${listId}\0`;
      const out = new Set<string>();
      for (const key of collapsedFolders) {
        if (key.startsWith(prefix)) out.add(key.slice(prefix.length));
      }
      return out;
    },
    [collapsedFolders],
  );
  const sortBranches = useCallback(
    (list: readonly Branch[]) =>
      sortRefs(list, sortMode, (b) => b.name, (b) => b.created_at),
    [sortMode],
  );

  const localBranches = useMemo(
    () => sortBranches(branches.filter((b) => !b.is_remote)),
    [branches, sortBranches],
  );
  const remoteBranches = branches.filter((b) => b.is_remote);

  // Map full upstream ref → local branch for "tracking" labels + divergence.
  const trackedRemotes = new Map(
    localBranches
      .filter((b) => b.upstream)
      .map((b) => [b.upstream!, b]),
  );

  // `groupRemoteBranches` preserves the input order within each group, so
  // sorting the flat list up front sorts every group.
  const remoteGroups = useMemo(
    () =>
      groupRemoteBranches(
        sortBranches(branches.filter((b) => b.is_remote)),
        remotes.map((r) => r.name),
      ),
    [branches, remotes, sortBranches],
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
    setDraftName(b.name);
    setEdit({ name: b.name, mode: "rename" });
  };

  const saveRename = async (name: string) => {
    const next = draftName.trim();
    if (!next || next === name) { setEdit(null); return; }
    if (await runMut(() => repoRenameBranch(repo!.id, name, next))) setEdit(null);
  };

  // The row's Delete button runs a SAFE delete (confirmed via the central
  // dialog when the destructive-confirm setting is on); force delete stays
  // reachable via the ref-chip / row context menu, which keeps its own
  // inline confirm section.
  const confirmDestructive = useConfirmDestructive();
  const openDelete = async (b: Branch) => {
    if (confirmDestructive) {
      const ok = await confirmDialog({
        title: "Delete branch",
        message: "Deletes the local branch (safe delete: git refuses if it is not fully merged).",
        detail: b.name,
        confirmLabel: "Delete branch",
      });
      if (!ok) return;
    }
    void doDelete(b.name, false);
  };

  const doDelete = async (name: string, force: boolean) => {
    if (await runMut(() => repoDeleteBranch(repo!.id, name, force))) setEdit(null);
  };

  const doCheckout = async (name: string) => {
    await runSwitch(async () => {
      const outcome = await repoSwitchBranch(repo!.id, name);
      notifySwitchOutcome(outcome, name);
      void autoUpdateSubmodules(queryClient, repo!.id);
    });
  };

  const doRemoteCheckout = useCallback(async (fullRef: string) => {
    await runSwitch(async () => {
      const outcome = await repoCheckoutRemoteBranch(repo!.id, fullRef);
      notifyRemoteCheckoutOutcome(outcome, fullRef.replace(/^refs\/remotes\//, ""));
      void autoUpdateSubmodules(queryClient, repo!.id);
    });
  }, [repo, runSwitch, queryClient]);

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
      // Global setting (default on): a new branch is checked out right away.
      // The switch flow handles dirty-tree behavior and its own feedback.
      if (checkoutNewBranch) await doCheckout(name);
    }
  };

  // Merge/rebase entry points (row context menu, shared sections): need the
  // current branch for labels; hidden while an op is already in progress.
  const currentBranch = localBranches.find((b) => b.is_current)?.name ?? null;
  const opState = useOpState(repo?.id);
  const opInProgress = !!opState && opState.kind !== "none";

  // Deletes the branch ON THE REMOTE only (`git push --delete`) — any local
  // counterpart is untouched, mirroring remote tag deletion.
  const handleDeleteRemoteBranch = useCallback(async (remoteRef: string) => {
    if (!repo) return;
    const split = splitRemoteRef(remoteRef, remotes.map((r) => r.name));
    if (!split) return;
    await runNet(async () => {
      await repoDeleteRemoteBranch(repo.id, split.remote, split.branch, crypto.randomUUID());
      notify.success(`Deleted '${split.branch}' on ${split.remote}`);
      invalidateRepoDomains(queryClient, repo.id, AFFECTED_DOMAINS);
    });
  }, [repo, remotes, queryClient, runNet]);

  // Pushes a branch - checked out or not (the backend addresses the full
  // refs/heads/ refspec). `setUpstream` publishes: the target remote becomes
  // the branch's upstream.
  const handleBranchPush = useCallback(async (branch: string, remote: string, setUpstream: boolean) => {
    if (!repo) return;
    await runNet(async () => {
      await pushWithTagFollowUp(
        queryClient,
        repo.id,
        {
          remote,
          branch,
          set_upstream: setUpstream,
          force_with_lease: false,
          recurse_submodules:
            useSettingsStore.getState().settings?.push_recurse_submodules ?? null,
        },
        crypto.randomUUID(),
      );
      notify.success(`Pushed '${branch}' to ${remote}`);
      invalidateRepoDomains(queryClient, repo.id, PUSH_DOMAINS);
    });
  }, [repo, queryClient, runNet]);

  const handleMerge = useCallback(async (target: string, options: MergeOptions) => {
    await runOp(async () => {
      const outcome = await repoMerge(repo!.id, target, options);
      notifyMergeOutcome(outcome, target);
    });
  }, [repo, runOp]);

  const handleRebaseOnto = useCallback(async (onto: string) => {
    await runOp(async () => {
      const outcome = await repoRebase(repo!.id, onto);
      notifyRebaseOutcome(outcome, onto);
    });
  }, [repo, runOp]);

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
        {localBranches.length > 0 && (() => {
          // One row renderer shared by both modes so flat mode stays exactly
          // the pre-tree rendering; tree mode indents it and shows the leaf
          // segment (actions keep the full name).
          const renderLocalRow = (b: Branch, displayName?: string) => (
            <LocalBranchRow
              key={b.name}
              branch={b}
              displayName={displayName}
              edit={edit}
              draftName={draftName}
              busy={busy}
              onDraftChange={setDraftName}
              onOpenRename={() => openRename(b)}
              onSaveRename={() => saveRename(b.name)}
              onOpenDelete={() => void openDelete(b)}
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
                    remotes={remotes.map((r) => r.name)}
                    onCheckout={() => { closeMenu(); doCheckout(b.name); }}
                    onRename={() => { closeMenu(); openRename(b); }}
                    onPush={(remote, setUpstream) => { closeMenu(); void handleBranchPush(b.name, remote, setUpstream); }}
                    onSetUpstream={(up) => { closeMenu(); doSetUpstream(b.name, up); }}
                    onDelete={(force) => { closeMenu(); doDelete(b.name, force); }}
                    onMerge={(options) => { closeMenu(); handleMerge(b.name, options); }}
                    onRebaseOnto={() => { closeMenu(); handleRebaseOnto(b.name); }}
                  />,
                )
              }
            />
          );
          const localByName = new Map(localBranches.map((b) => [b.name, b]));
          return (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {/* Header shares its row with the Tree/List toggle - the
                  toggle governs the remote groups below too. */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <SectionLabel>Local</SectionLabel>
                <div style={{ display: "flex" }}>
                  <button
                    onClick={() => setBranchListView("tree")}
                    aria-pressed={branchView === "tree"}
                    style={segStyle(branchView === "tree", "left")}
                  >
                    Tree
                  </button>
                  <button
                    onClick={() => setBranchListView("flat")}
                    aria-pressed={branchView === "flat"}
                    style={segStyle(branchView === "flat", "right")}
                  >
                    List
                  </button>
                </div>
              </div>
              {branchView === "flat"
                ? localBranches.map((b) => renderLocalRow(b))
                : branchTreeRows(localBranches.map((b) => b.name), collapsedFor("local")).map((row) =>
                    row.kind === "dir" ? (
                      <BranchFolderRow
                        key={`d:${row.path}`}
                        label={row.label}
                        depth={row.depth}
                        count={row.fileCount}
                        collapsed={row.collapsed}
                        holdsCurrent={folderHoldsCurrent(row.path, currentBranch)}
                        onToggle={() => toggleFolder("local", row.path)}
                      />
                    ) : (
                      <div key={row.path} style={{ marginLeft: `${row.depth * 1.25}em` }}>
                        {renderLocalRow(localByName.get(row.path)!, leafName(row.path))}
                      </div>
                    ),
                  )}
            </div>
          );
        })()}

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
              {!collapsed && (() => {
                // Shared by both modes; `displayName` overrides the shown
                // short name in tree mode (actions keep the full ref name).
                const renderRemoteRow = (b: Branch, displayName?: string) => {
                  const fullRef = `refs/remotes/${b.name}`;
                  const trackingBranch = trackedRemotes.get(fullRef);
                  return (
                    <RemoteBranchRow
                      key={b.name}
                      branch={b}
                      shortName={displayName ?? shortRemoteBranchName(b.name, group.remote)}
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
                            onDeleteRemote={() => { closeMenu(); void handleDeleteRemoteBranch(b.name); }}
                          />,
                        )
                      }
                    />
                  );
                };
                if (branchView === "flat") return group.branches.map((b) => renderRemoteRow(b));
                // Tree mode nests within the remote group by the short name
                // (the name without the "<remote>/" prefix, as listed).
                const byShort = new Map(
                  group.branches.map((b) => [shortRemoteBranchName(b.name, group.remote), b]),
                );
                const listId = `remote:${group.remote}`;
                return branchTreeRows([...byShort.keys()], collapsedFor(listId)).map((row) =>
                  row.kind === "dir" ? (
                    <BranchFolderRow
                      key={`d:${row.path}`}
                      label={row.label}
                      depth={row.depth}
                      count={row.fileCount}
                      collapsed={row.collapsed}
                      holdsCurrent={false}
                      onToggle={() => toggleFolder(listId, row.path)}
                    />
                  ) : (
                    <div key={row.path} style={{ marginLeft: `${row.depth * 1.25}em` }}>
                      {renderRemoteRow(byShort.get(row.path)!, leafName(row.path))}
                    </div>
                  ),
                );
              })()}
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

/** A collapsible folder row of the branch tree: chevron + name + count.
 *  Shows the current-branch dot while collapsed and hiding the checkout. */
function BranchFolderRow({
  label,
  depth,
  count,
  collapsed,
  holdsCurrent,
  onToggle,
}: {
  label: string;
  depth: number;
  count: number;
  collapsed: boolean;
  holdsCurrent: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      title={collapsed ? `Expand ${label}` : `Collapse ${label}`}
      style={{
        background: "none",
        border: "none",
        padding: 0,
        marginLeft: `${depth * 1.25}em`,
        display: "flex",
        alignItems: "center",
        gap: 4,
        cursor: "pointer",
        fontSize: "var(--fz-lg)",
        fontFamily: "monospace",
        color: "var(--panel-fg)",
      }}
    >
      {collapsed ? <ChevronRightIcon /> : <ChevronDownIcon />}
      {label}
      {collapsed && holdsCurrent && (
        // Same token as the checked-out chip/row dot: the hidden checkout
        // stays visible on the folder.
        <span style={{ color: "var(--ref-branch-current-fg, rgb(130, 220, 130))" }}>●</span>
      )}
      <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)" }}>({count})</span>
    </button>
  );
}

function LocalBranchRow({
  branch,
  displayName,
  edit,
  draftName,
  busy,
  onDraftChange,
  onOpenRename,
  onSaveRename,
  onOpenDelete,
  onCheckout,
  onCancelEdit,
  onContextMenu,
}: {
  branch: Branch;
  /** Shown instead of the full name (tree mode's leaf segment); every action
   *  and editor keeps operating on `branch.name`. */
  displayName?: string;
  edit: EditState;
  draftName: string;
  busy: boolean;
  onDraftChange: (v: string) => void;
  onOpenRename: () => void;
  onSaveRename: () => void;
  onOpenDelete: () => void;
  onCheckout: () => void;
  onCancelEdit: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const isEditing = edit?.name === branch.name;
  const mono: React.CSSProperties = { fontSize: "var(--fz-md)", fontFamily: "monospace" };

  return (
    <div
      onContextMenu={onContextMenu}
      onClick={(e) => {
        // Background click = show this branch in the commit graph. Skipped
        // while an inline rename/delete is open and for clicks on the row's
        // own controls (their clicks bubble here).
        if (!isEditing && isRowBackgroundClick(e.target)) jumpPanelsToCommit(branch.head);
      }}
      data-testid="branch-row"
      data-branch={branch.name}
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
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span
            style={{ fontSize: "var(--fz-lg)", fontFamily: "monospace", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            title={branch.name}
          >
            {branch.is_current && (
              // Same token as the commit graph's checked-out branch chip
              // (RefsCell chipStyle), so "this is the current branch" reads
              // as one colour across the app.
              <span style={{ color: "var(--ref-branch-current-fg, rgb(130, 220, 130))", marginRight: 6 }}>●</span>
            )}
            {displayName ?? branch.name}
          </span>
          <DivergenceBadge branch={branch} />
          <div style={{ display: "flex", gap: 6, flexShrink: 0, flexWrap: "wrap" }}>
            {!branch.is_current && (
              <ToolbarButton label="Checkout" disabled={busy} onClick={onCheckout} />
            )}
            <ToolbarButton label="Rename" disabled={busy} onClick={onOpenRename} />
            <ToolbarButton label="Delete" disabled={busy} onClick={onOpenDelete} />
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
      onClick={(e) => {
        if (isRowBackgroundClick(e.target)) jumpPanelsToCommit(branch.head);
      }}
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
        <ToolbarButton label="Checkout" disabled={busy} onClick={onCheckout} style={{ flexShrink: 0 }} />
      )}
    </div>
  );
}
