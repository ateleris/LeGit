import { useCallback, useMemo, useState } from "react";
import { SectionLabel } from "../shared/SectionChrome";
import {
  checkoutBranch,
  checkoutRemoteBranch,
  createBranch,
  deleteBranch,
  deleteRemoteBranch,
  mergeInto,
  pushBranch,
  rebaseOnto,
  renameBranch,
  setUpstream,
  type RefActionContext,
} from "../../lib/refActions";
import { confirmDestructiveAction } from "../../store/confirm";
import { useQueryClient } from "@tanstack/react-query";
import { useActiveRepo } from "../../store/repos";
import { usePanelFocusEffect } from "../PanelApiContext";
import { groupRemoteBranches, shortRemoteBranchName } from "../../lib/branchGroups";
import { ChevronDownIcon, ChevronRightIcon } from "../../icons";
import { Button } from "../shared/buttons";
import { ToolbarButton } from "../shared/ToolbarButton";
import { segStyle } from "../shared/segmented";
import { branchTreeRows, folderHoldsCurrent, leafName } from "./branchTree";
import { notify } from "../../store/notifications";
import { useOpState } from "../../lib/useOpState";
import { useBranches, useRemotes } from "../../lib/queries/useRepoQueries";
import { useSettingsStore } from "../../store/settings";
import { coerceRefsSortMode, sortRefs } from "../../lib/refSort";
import type { Branch, MergeOptions } from "../../lib/types";
import { formatAppError } from "../../lib/errors";
import { PanelLoadingBar } from "../shared/PanelLoadingBar";
import { InlineEditor } from "../shared/InlineEditor";
import { ShrinkingPathText } from "../shared/ShrinkingPathText";
import { splitRefName } from "../shared/pathSplit";
import { RefFilterRow } from "../shared/RefFilterRow";
import { matchesRefFilter, filterRemoteGroups } from "../../lib/refFilter";
import { usePanelRunner } from "../shared/usePanelRunner";
import { isRowBackgroundClick, jumpPanelsToCommit } from "../shared/jumpToCommit";
import { PanelContextMenuProvider } from "../shared/menu/PanelContextMenu";
import { BranchMenuSection, RemoteBranchMenuSection } from "../Commits/menu/BranchMenuSection";

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

  const { data: branches = [], isFetching, refetch } = useBranches(repo?.id);
  const { data: remotes = [] } = useRemotes(repo?.id);

  const reload = useCallback(() => { refetch(); }, [refetch]);
  usePanelFocusEffect(reload);

  const [edit, setEdit] = useState<EditState>(null);
  const [draftName, setDraftName] = useState("");
  const [createName, setCreateName] = useState("");
  const [createFrom, setCreateFrom] = useState("");

  const actionCtx = useMemo<RefActionContext | null>(
    () => (repo ? { queryClient, repo, remoteNames: remotes.map((r) => r.name) } : null),
    [queryClient, repo, remotes],
  );
  // The shared actions report their own errors and refresh their domains;
  // the runners add only the re-entry guard and delayed busy state. Network
  // ops (push, remote delete) may show busy immediately.
  const { busy: localBusy, run: runLocal } = usePanelRunner({
    enabled: !!repo,
    onError: (e) => notify.error(formatAppError(e)),
  });
  const { busy: netBusy, run: runNet } = usePanelRunner({
    enabled: !!repo,
    delayMs: 0,
    onError: (e) => notify.error(formatAppError(e)),
  });
  const busy = localBusy || netBusy;
  /** Run a shared action under `run`'s guard; resolves the action's result. */
  const guarded = useCallback(
    async (run: typeof runLocal, action: (c: RefActionContext) => Promise<boolean>) => {
      if (!actionCtx) return false;
      let ok = false;
      await run(async () => {
        ok = await action(actionCtx);
      });
      return ok;
    },
    [actionCtx],
  );

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

  // Filter is ephemeral per-section state; it narrows the local list and the
  // remote groups by substring (remote branches by their short name).
  const [filterQuery, setFilterQuery] = useState("");

  const localBranches = useMemo(
    () => sortBranches(branches.filter((b) => !b.is_remote)),
    [branches, sortBranches],
  );
  const filteredLocal = useMemo(
    () => localBranches.filter((b) => matchesRefFilter(b.name, filterQuery)),
    [localBranches, filterQuery],
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
      filterRemoteGroups(
        groupRemoteBranches(
          sortBranches(branches.filter((b) => b.is_remote)),
          remotes.map((r) => r.name),
        ),
        filterQuery,
      ),
    [branches, remotes, sortBranches, filterQuery],
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
    if (await guarded(runLocal, (c) => renameBranch(c, name, next))) setEdit(null);
  };

  // The row's Delete button runs a SAFE delete; force delete stays reachable
  // via the ref-chip / row context menu.
  const openDelete = async (b: Branch) => {
    const ok = await confirmDestructiveAction({
      title: "Delete branch",
      message: "Deletes the local branch (safe delete: a not fully merged branch prompts with guidance first).",
      detail: b.name,
      confirmLabel: "Delete branch",
    });
    if (ok) void doDelete(b.name, false);
  };

  const doDelete = async (name: string, force: boolean) => {
    if (await guarded(runLocal, (c) => deleteBranch(c, name, force))) setEdit(null);
  };

  const doCheckout = (name: string) => guarded(runLocal, (c) => checkoutBranch(c, name));

  const doRemoteCheckout = useCallback(
    (fullRef: string) => guarded(runLocal, (c) => checkoutRemoteBranch(c, fullRef)),
    [guarded, runLocal],
  );

  const doSetUpstream = (name: string, upstream: string | null) =>
    guarded(runLocal, (c) => setUpstream(c, name, upstream));

  // Existing same-name remote-tracking branches a local branch could track.
  const upstreamCandidatesFor = (name: string) =>
    remoteBranches.filter((b) => b.name.endsWith(`/${name}`)).map((b) => b.name);

  const doCreate = async () => {
    const name = createName.trim();
    if (!name) return;
    const from = createFrom.trim() || undefined;
    // Global setting (default on): a new branch is checked out right away.
    const created = await guarded(runLocal, (c) =>
      createBranch(c, name, from, { checkout: checkoutNewBranch }),
    );
    if (created) {
      setCreateName("");
      setCreateFrom("");
    }
  };

  // Merge/rebase entry points (row context menu, shared sections): need the
  // current branch for labels; hidden while an op is already in progress.
  const currentBranch = localBranches.find((b) => b.is_current)?.name ?? null;
  const opState = useOpState(repo?.id);
  const opInProgress = !!opState && opState.kind !== "none";

  const handleDeleteRemoteBranch = useCallback(
    (remoteRef: string) => guarded(runNet, (c) => deleteRemoteBranch(c, remoteRef)),
    [guarded, runNet],
  );

  const handleBranchPush = useCallback(
    (branch: string, remote: string, setUpstream: boolean) =>
      guarded(runNet, (c) => pushBranch(c, branch, remote, setUpstream)),
    [guarded, runNet],
  );

  const handleMerge = useCallback(
    (target: string, options: MergeOptions) => guarded(runLocal, (c) => mergeInto(c, target, options)),
    [guarded, runLocal],
  );

  const handleRebaseOnto = useCallback(
    (onto: string) => guarded(runLocal, (c) => rebaseOnto(c, onto)),
    [guarded, runLocal],
  );

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
        style={{ display: "flex", flexDirection: "column", gap: "0.833em" }}
      >
        {branches.length > 0 && (
          <RefFilterRow query={filterQuery} onQueryChange={setFilterQuery} sortScope="branches" label="branches" />
        )}
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
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5em" }}>
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
              {filteredLocal.length === 0 && (
                <span className="legit-subtle" style={{ fontSize: "var(--fz-md)" }}>
                  No matches.
                </span>
              )}
              {branchView === "flat"
                ? filteredLocal.map((b) => renderLocalRow(b))
                : branchTreeRows(filteredLocal.map((b) => b.name), collapsedFor("local")).map((row) =>
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
            <div key={group.remote} style={{ display: "flex", flexDirection: "column", gap: "0.5em" }}>
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
            paddingTop: "0.833em",
            display: "flex",
            flexDirection: "column",
            gap: "0.5em",
          }}
        >
          <SectionLabel>New branch</SectionLabel>
          <div style={{ display: "flex", gap: "0.5em", flexWrap: "wrap" }}>
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
        gap: "0.333em",
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
        gap: "0.333em",
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
        padding: "0.667em 0.833em",
        display: "flex",
        flexDirection: "column",
        gap: "0.5em",
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
        <div style={{ display: "flex", alignItems: "center", gap: "0.667em", flexWrap: "wrap" }}>
          <ShrinkingPathText
            {...splitRefName(displayName ?? branch.name)}
            style={{ fontSize: "var(--fz-lg)", fontFamily: "monospace", flex: 1 }}
            title={branch.name}
          >
            {branch.is_current && (
              // Same token as the commit graph's checked-out branch chip
              // (RefsCell chipStyle), so "this is the current branch" reads
              // as one colour across the app.
              <span style={{ color: "var(--ref-branch-current-fg, rgb(130, 220, 130))", marginRight: "0.5em", flexShrink: 0 }}>●</span>
            )}
          </ShrinkingPathText>
          <DivergenceBadge branch={branch} />
          <div style={{ display: "flex", gap: "0.5em", flexShrink: 0, flexWrap: "wrap" }}>
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
        padding: "0.667em 0.833em",
        display: "flex",
        alignItems: "center",
        gap: "0.667em",
        flexWrap: "wrap",
      }}
    >
      <ShrinkingPathText
        {...splitRefName(shortName)}
        style={{ fontSize: "var(--fz-lg)", fontFamily: "monospace", flex: 1 }}
      />
      {trackingBranch ? (
        <>
          <DivergenceBadge branch={trackingBranch} />
          <ShrinkingPathText
            prefix={`tracking: ${splitRefName(trackingBranch.name).prefix}`}
            leaf={splitRefName(trackingBranch.name).leaf}
            className="legit-subtle"
            style={{ fontSize: "var(--fz-sm)", flexShrink: 0, maxWidth: "100%" }}
          />
        </>
      ) : (
        <ToolbarButton label="Checkout" disabled={busy} onClick={onCheckout} style={{ flexShrink: 0 }} />
      )}
    </div>
  );
}
