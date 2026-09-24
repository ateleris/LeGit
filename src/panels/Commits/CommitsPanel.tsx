import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PanelError } from "../shared/PanelError";
import { useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useActiveRepo, useRepoStore } from "../../store/repos";
import { usePanelViewState } from "../../store/panelViewState";
import { useThemeStore } from "../../store/themes";
import { effectiveLaneChipFilters } from "../../theme/filters";
import {
  useSettingsStore,
  COMMITS_ROW_HEIGHT_DEFAULT,
  COMMITS_LANE_WIDTH_DEFAULT,
  COMMITS_DOT_RADIUS_DEFAULT,
  COMMITS_LINE_WIDTH_DEFAULT,
  UI_FONT_SIZE_DEFAULT,
  minCommitsRowHeight,
} from "../../store/settings";
import { useLaneLocks, useLaneLocksStore } from "../../store/laneLocks";
import { usePanelFocusEffect, useRestoreVirtualizerScroll } from "../PanelApiContext";
import { useSummonStore, useSummonTarget } from "../../store/summon";
import { PanelLoadingBar } from "../shared/PanelLoadingBar";
import { TOOLBAR_FIELD_STYLE } from "../shared/fields";
import { useDelayedFlag } from "../shared/useDelayedFlag";
import { invalidateRepoDomains } from "../../lib/repoInvalidation";
import { useLayer } from "../../store/layers";
import { useOpState } from "../../lib/useOpState";
import type { Commit, CommitId, RepoSummary, Signature } from "../../lib/types";
import { formatAppError } from "../../lib/errors";
import { worktreeLocator } from "../../lib/locator";
import { createBranch, stashBranch } from "../../lib/refActions";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { notify } from "../../store/notifications";
import { SignedIcon } from "../../icons";
import { useSignatureStore } from "../../store/signatures";
import { formatAbsolute, formatRelative } from "../../lib/time";
import { laneColor } from "./cells/GraphCell";
import { pickHeadCommitId } from "./headId";
import { growJumpWindow, pendingJumpAction, shouldCenterScroll } from "./scrollToRow";
import { applyRowClickSelection, type SelectionState } from "./multiSelect";
import type { LockMap } from "./graph/types";
import { buildLockMap, WORKING_DIR_ID } from "./commitRows";
import { useCommitActions } from "./useCommitActions";
import { CommitsRowContext, type CommitsRowContextValue } from "./RowContext";
import { CommitRow } from "./CommitRow";
import { maxVisibleLaneFor, useGraphModel } from "./useGraphModel";
import { useInlineEdits } from "./useInlineEdits";
import { useQuickJump } from "./useQuickJump";
import { useColumnState } from "./columns/useColumnState";
import { ColumnHeader } from "./columns/ColumnHeader";
import { LaneLockIndicator } from "./LaneLockIndicator";
import { PanelContextMenuProvider, type BaselineEntry } from "../shared/menu/PanelContextMenu";
import { RemoteSyncToolbar } from "./RemoteSyncToolbar";
import { SEARCH_MAX_RESULTS, useCommitsQueries } from "./useCommitsQueries";
import { COLUMN_GAP, NON_HIDEABLE, NON_RESIZABLE } from "./columns/types";
import type { ColumnId } from "./columns/types";
import { computeColumnLayout, reorderColumns } from "./columns/layout";
import { computeContentMaxWidths } from "./columns/contentWidths";

const COLUMN_LABELS: Record<ColumnId, string> = {
  refs: "Refs",
  graph: "Graph",
  signed: "Signed",
  // User-facing label is "Message" everywhere (matching the filter's kind
  // dropdown); "subject" stays the internal/persisted column id.
  subject: "Message",
  date: "Date",
  author: "Author",
  sha: "SHA",
};

// Line height (ROW_HEIGHT) and per-lane horizontal spacing (LANE_SPACING) are
// user-configurable via Global Settings; the values below are only the
// fallbacks used until the settings store has loaded. Both feed the layout:
// ROW_HEIGHT drives the virtualizer + grid row height, LANE_SPACING drives the
// graph column width and lock-indicator positions.
//
// Note on ROW_HEIGHT: rows carry no vertical padding so the SVG fills the full
// height and graph lines connect seamlessly between adjacent rows. Must NOT use
// vItem.size for the row height because vItem.size is the measured border-box
// height, which would create an infinite growth loop via measureElement.

const PAGE_SIZE = 500;

// Cap for the toolbar search: hits are cycled, and both underlying walks are
// capped - a big cap costs only git time.

async function toggleAbdaesele(): Promise<void> {
  const win = getCurrentWindow();
  const title = await win.title();
  const next = title.includes("LegIt")
    ? title.replace("LegIt", "LeGit")
    : title.replace("LeGit", "LegIt");
  if (next !== title) await win.setTitle(next);
}


export { WORKING_DIR_ID } from "./commitRows";

// Placeholder signature for the synthetic working-dir row. Its author/date
// columns are rendered blank, so these values are never shown.
const EMPTY_SIGNATURE: Signature = {
  name: "",
  email: "",
  timestamp: 0,
  tz_offset_minutes: 0,
};

/** Commits panel — virtualised, multi-column log of commits for the active repo. */
export function CommitsPanel() {
  const repo = useActiveRepo();
  // The guard lives OUTSIDE the stateful body: the panel stays mounted when
  // the last repo closes, and any hook below a conditional return inside one
  // component changes the hook count across the transition and crashes the
  // tree (React errors 300/310; see CommitsPanel.test.tsx). As its own
  // component, the body's hooks simply unmount instead.
  if (!repo) {
    return (
      <div className="legit-panel">
        <div className="legit-panel__body">
          <span className="legit-subtle">No repo open.</span>
        </div>
      </div>
    );
  }
  return <CommitsPanelBody repo={repo} />;
}

function CommitsPanelBody({ repo }: { repo: RepoSummary }) {
  const queryClient = useQueryClient();

  // User-configurable graph metrics (Global Settings). Fall back to defaults
  // until the settings store has loaded.
  const storedRowHeight = useSettingsStore(
    (s) => s.settings?.commits_row_height ?? COMMITS_ROW_HEIGHT_DEFAULT,
  );
  const storedLaneWidth = useSettingsStore(
    (s) => s.settings?.commits_lane_width ?? COMMITS_LANE_WIDTH_DEFAULT,
  );
  const DOT_RADIUS = useSettingsStore(
    (s) => s.settings?.commits_dot_radius ?? COMMITS_DOT_RADIUS_DEFAULT,
  );
  const LINE_WIDTH = useSettingsStore(
    (s) => s.settings?.commits_line_width ?? COMMITS_LINE_WIDTH_DEFAULT,
  );
  // Column/chip text follows the global UI font size — the panel has no text
  // size of its own (CLAUDE.md: everything scales with `--ui-font-size`). It
  // stays a px *number* (not a CSS var) because the chip-overflow measurement
  // and the inline editors need the concrete value.
  const TEXT_SIZE = useSettingsStore(
    (s) => s.settings?.ui_font_size ?? UI_FONT_SIZE_DEFAULT,
  );
  // Opt-in author avatars in the commit dots (off by default — no Gravatar
  // request leaves the app unless the user enabled the setting).
  const AVATARS_ENABLED = useSettingsStore((s) => s.settings?.commit_avatars ?? false);
  const INITIALS_ENABLED = useSettingsStore((s) => s.settings?.commit_initials ?? false);
  // Date column: full author datetime instead of the relative form (global
  // setting), in the user's chosen format.
  const DATE_ABSOLUTE = useSettingsStore((s) => s.settings?.commit_date_absolute ?? false);
  const DATE_FORMAT = useSettingsStore((s) => s.settings?.commit_date_format ?? "iso");
  const DATE_SHOW_TIME = useSettingsStore((s) => s.settings?.commit_date_show_time ?? true);
  // Global setting (default on): creating a branch also checks it out.
  const checkoutNewBranch = useSettingsStore((s) => s.settings?.checkout_new_branch ?? true);

  // Render-time floors (the settings clamps only run on save): rows must
  // always clear a ref chip by 2px so chips on adjacent rows never touch —
  // even when the font size was raised *after* the values were saved. Lane
  // width shares the same font-derived floor (but not the row height itself;
  // the two are independent above it).
  const metricsFloor = minCommitsRowHeight(TEXT_SIZE);
  const ROW_HEIGHT = Math.max(storedRowHeight, metricsFloor);
  const LANE_SPACING = Math.max(storedLaneWidth, metricsFloor);

  // Selection, filters, and the fetch window are per-repo view state
  // (store/panelViewState.ts): they survive a layout apply's dock rebuild
  // and panel close/reopen, and each repo keeps its own across tab switches.
  const [selectedId, setSelectedId] = usePanelViewState<CommitId | null>(
    "commits.selectedId",
    null,
  );
  // Multi-selection (Ctrl/Shift click; see multiSelect.ts for the rules).
  // Contains the lead when set; single-select paths (summon, search,
  // quick-jump) collapse it via selectSingle.
  const [selectedIds, setSelectedIds] = usePanelViewState<ReadonlySet<CommitId>>(
    "commits.selectedIds",
    new Set(),
  );
  const selectSingle = useCallback((id: CommitId) => {
    setSelectedId(id);
    setSelectedIds(new Set([id]));
  }, []);
  // Kept with the selection: a restored selection deep in the log needs its
  // fetch window, or the highlighted row would not be loaded.
  const [extraPages, setExtraPages] = usePanelViewState("commits.extraPages", 0);
  // A jump target (adoptSelection) not yet in the loaded window; the seek
  // effect below keeps growing the fetch window until it loads, then scrolls.
  const [pendingJump, setPendingJump] = useState<CommitId | null>(null);
  // Toolbar search: a submitted query runs a full-history backend search
  // (`git log --grep/--author`, message OR author - a client-side scan of
  // the loaded window would silently miss unloaded commits) and Enter CYCLES
  // the selection through the hits, newest first, inside the intact graph
  // (Shift+Enter goes back). The query is also tried as a rev-parse
  // expression (SHA, branch, tag, HEAD~2, ...); a resolving one becomes the
  // FIRST hit, so pasting a sha or ref name jumps straight to it.
  const [searchDraft, setSearchDraft] = usePanelViewState("commits.searchDraft", "");
  const [search, setSearch] = usePanelViewState<{ query: string } | null>(
    "commits.search",
    null,
  );
  // Which hit the selection sits on; Enter advances it (wrapping).
  const [searchHit, setSearchHit] = usePanelViewState("commits.searchHit", 0);
  // Branch filter (ref menus' "Show only this branch"): restricts the log
  // WALK to commits reachable from the ref (`repoLog` revision_range). The
  // graph stays - a ref's history is connected, unlike text-search results.
  const [branchFilter, setBranchFilter] = usePanelViewState<string | null>(
    "commits.branchFilter",
    null,
  );
  // Author filter (row menu "Show only commits by …"): restricts the walk to
  // one author (`--author`, matched by email; the name labels the chip).
  // Unlike a branch, an author's commits are an arbitrary subset, so the
  // graph column hides while this is active. Combines with the branch filter.
  const [authorFilter, setAuthorFilter] = usePanelViewState<
    { name: string; email: string } | null
  >("commits.authorFilter", null);
  const parentRef = useRef<HTMLDivElement>(null);
  // The list's horizontal scroll offset, mirrored onto the header grid as a
  // translateX. A transform (not wrapper scrollLeft) because the header
  // wrapper's own max scroll is SMALLER than the list's (the vertical
  // scrollbar narrows the list viewport), so a scrollLeft sync clamps near
  // the end and the columns drift apart on the final few pixels.
  const [headerShift, setHeaderShift] = useState(0);

  // Column ordering, hiding, and widths — read from global settings on mount
  // and persisted (debounced) via `patch_global_settings`.
  const { state: colState, setOrder, setHidden, setWidth } = useColumnState();

  const totalToFetch = PAGE_SIZE * (1 + extraPages);

  // Load lane locks on mount / when the active repo changes.
  const loadLocks = useLaneLocksStore((s) => s.loadLocks);
  useEffect(() => {
    loadLocks(repo.id);
  }, [repo.id, loadLocks]);

  // Drop a stale jump target when the active repo changes (the in-place
  // edits reset inside useInlineEdits). Selection, search, and filters need
  // no reset: they are keyed per repo (usePanelViewState).
  useEffect(() => {
    setPendingJump(null);
  }, [repo.id]);

  // Raw lock list from the store; used by the Refs context menu UI.
  const rawLocks = useLaneLocks(repo.id);

  // Build a conflict-free LockMap for the lane algorithm. §H.5 says the
  // backend storage is permissive; if two locks claim the same lane (e.g.
  // from a hand-edited settings.json), the first one wins.
  const lockMap = useMemo((): LockMap => buildLockMap(rawLocks), [rawLocks]);

  // Every react-query read plus its directly-derived memos live in the
  // extracted hook (2026-08-24 structural split); the panel keeps only
  // state-dependent wiring.
  const signedColumnVisible = !colState.hidden.includes("signed");
  const {
    commits,
    isFetching,
    isError,
    error,
    searchHits,
    searchFetching,
    branches,
    tracking,
    status,
    upstreamMap,
    worktreeBranches,
    worktreeHeadsBySha,
    unpushedSet,
    currentBranchName,
    tagRemote,
    remoteNames,
    pushedTags,
    tagTargetsOnRemote,
    signedSet,
  } = useCommitsQueries(repo, {
    totalToFetch,
    branchFilter,
    authorFilter,
    search,
    signedColumnVisible,
  });

  const opState = useOpState(repo.id);
  const opInProgress = !!opState && opState.kind !== "none";

  // Lane-coloured branch chips: the on/off toggles are GLOBAL settings; the
  // theme contributes only the per-part filters. Reading the theme draft-first
  // gives the Theme Editor live preview while editing.
  const laneChipsEnabled = useSettingsStore(
    (s) => s.settings?.lane_colored_branch_chips ?? false,
  );
  const themeDoc = useThemeStore((s) => s.draft ?? s.activeDocument);
  const laneChipFilters = useMemo(
    () => (laneChipsEnabled ? effectiveLaneChipFilters(themeDoc?.laneChipFilters) : null),
    [laneChipsEnabled, themeDoc],
  );
  const stashBaseLaneColor = useSettingsStore(
    (s) => s.settings?.stash_base_lane_color ?? false,
  );

  // Open a detached worktree (from its HEAD chip) as its own repo tab.
  const handleOpenWorktree = useCallback(
    (path: string) => {

      void useRepoStore
        .getState()
        .openRepo(worktreeLocator(repo.locator ?? repo.path, path))
        .catch(
          (e: unknown) => notify.error(formatAppError(e)),
        );
    },
    [repo],
  );

  // Verification verdicts for every commit inspected in Commit Details this
  // session (the list itself never verifies - it only knows presence). Each
  // recorded verdict upgrades that row's neutral "signed" chip permanently,
  // not just while the row is selected.
  const verifiedSignatures = useSignatureStore((s) => (repo ? s.byRepo[repo.id] : undefined));

  // All mutating row/menu actions (merge, sequencer, branch/tag/stash ops,
  // checkouts) live in this hook; every returned callback is stable.
  const actions = useCommitActions(repo, remoteNames);
  const {
    handleMerge,
    handleCherryPick,
    handleRevert,
    handleReset,
    handleUndoLastCommit,
    handleRebaseOnto,
    handleBulkRewrite,
    handleBranchCheckout,
    handleBranchDelete,
    handleBranchPush,
    handleSetUpstream,
    handleRemoteCheckout,
    handleCommitCheckout,
    handleRemoteBranchDelete,
    handleTagPush,
    handleTagDelete,
    handleTagDeleteRemote,
    handleStashApply,
    handleStashPop,
    handleStashDrop,
    handleCreateStash,
  } = actions;

  // Existing same-name remote-tracking branches a local branch could track —
  // the candidates offered by the "Set upstream to …" menu entries.
  const upstreamCandidatesFor = useCallback(
    (name: string) =>
      branches.filter((b) => b.is_remote && b.name.endsWith(`/${name}`)).map((b) => b.name),
    [branches],
  );

  // The current local branch and its tip — v1 rewords HEAD only.
  const currentBranch = useMemo(
    () => branches.find((b) => b.is_current && !b.is_remote) ?? null,
    [branches],
  );
  const headSha = currentBranch?.head ?? null;
  // The tip is rewordable while it is local: no upstream at all, or ahead of the
  // upstream. Hidden once pushed (upstream exists and ahead === 0). The backend
  // enforces this authoritatively; this gate just avoids offering a doomed action.
  const headIsRewordable = useMemo(() => {
    if (!headSha) return false; // detached / unborn — unsupported in v1
    if (currentBranch?.upstream && tracking && tracking.ahead === 0) return false;
    return true;
  }, [headSha, currentBranch, tracking]);

  const refetch = useCallback(() => {
    if (repo) {
      invalidateRepoDomains(queryClient, repo.id, ["log", "branches", "status", "tracking", "stashes", "tags"]);
    }
  }, [repo, queryClient]);

  usePanelFocusEffect(refetch);

  // Baseline context-menu entries — present on every right-click in the panel,
  // regardless of what was clicked. While a branch filter is active, the way
  // back rides along: the filter is applied via a context menu, so removing
  // it must not depend on spotting the toolbar chip's ✕.
  const baseline = useMemo<BaselineEntry[]>(
    () => [
      ...(branchFilter !== null
        ? [{ label: `Show all branches (remove '${branchFilter}' filter)`, onClick: () => setBranchFilter(null) }]
        : []),
      ...(authorFilter !== null
        ? [{ label: `Show all authors (remove '${authorFilter.name}' filter)`, onClick: () => setAuthorFilter(null) }]
        : []),
      // Refresh stays the last entry.
      { label: "Refresh", onClick: refetch, disabled: isFetching },
    ],
    [refetch, isFetching, branchFilter, authorFilter],
  );

  // HEAD commit id — the parent of the synthetic working-dir row.
  const headId = useMemo((): CommitId | null => pickHeadCommitId(commits), [commits]);

  // Synthetic "uncommitted changes" row, present only when the working tree is
  // dirty and a HEAD commit is known. Its node renders as a hollow ring.
  const workingDirRow = useMemo((): Commit | null => {
    if (status.length === 0 || headId === null) return null;
    const noun = status.length === 1 ? "file" : "files";
    return {
      id: WORKING_DIR_ID,
      parents: [headId],
      author: EMPTY_SIGNATURE,
      committer: EMPTY_SIGNATURE,
      message: `Uncommitted changes (${status.length} ${noun})`,
      timestamp: 0,
      signature: null,
      has_signature: false,
      decorations: [],
    };
  }, [status.length, headId]);

  // Rows actually rendered: the synthetic row (when present) pinned at the top,
  // above all real commits. The graph edge connecting it to HEAD may span many
  // rows when HEAD is not the newest commit (e.g. detached HEAD, behind a
  // branch). Lane layout is computed on `commits` for stability, then augmented
  // with the synthetic node — so paging/recompute never see it.
  // In search/filter mode the rows are the flat result list instead: no
  // synthetic row, no injected stashes, and the graph column is hidden (lane
  // layout over an arbitrary subset would be meaningless).
  // Under a branch filter the synthetic row only makes sense on the branch
  // that actually owns the working tree (HEAD may not be in the walk at all);
  // under an author filter it is not "a commit by this author" at all.
  const showWorkingDirRow =
    workingDirRow !== null &&
    authorFilter === null &&
    (branchFilter === null || branchFilter === currentBranchName);
  const rows = useMemo(
    () =>
      showWorkingDirRow && workingDirRow
        ? [workingDirRow, ...commits]
        : commits,
    [showWorkingDirRow, workingDirRow, commits],
  );

  // Content-width caps for the Author / Date / SHA columns: a column never
  // renders wider than its widest rendered value plus padding (the synthetic
  // working-dir row renders empty cells, so `commits` is the full universe).
  // Recomputed when the loaded window grows or the font/date settings change.
  const contentMaxWidths = useMemo(() => {
    // No caps before the first page loads: header-only caps would collapse
    // the columns for a frame and make them jump when the rows arrive.
    if (commits.length === 0) return {};
    const authorTexts = new Set<string>();
    const dateTexts = new Set<string>();
    for (const c of commits) {
      authorTexts.add(c.author.name);
      dateTexts.add(
        DATE_ABSOLUTE
          ? formatAbsolute(c.timestamp, c.author.tz_offset_minutes, DATE_FORMAT, DATE_SHOW_TIME)
          : formatRelative(c.timestamp),
      );
    }
    return computeContentMaxWidths({
      authorTexts,
      dateTexts,
      uiFontSize: TEXT_SIZE,
      headerLabels: COLUMN_LABELS,
    });
  }, [commits, TEXT_SIZE, DATE_ABSOLUTE, DATE_FORMAT, DATE_SHOW_TIME]);

  // Subject lookup for the merge-commit mainline picker: parents are almost
  // always within the loaded window; an unloaded one degrades to sha-only.
  const commitMessageById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of commits) m.set(c.id, c.message);
    return m;
  }, [commits]);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  // estimateSize closes over ROW_HEIGHT; re-measure when the user changes the
  // configured line height so existing rows pick up the new size.
  useEffect(() => {
    rowVirtualizer.measure();
  }, [ROW_HEIGHT, rowVirtualizer]);

  // Restore scroll (and re-render) when this panel is tab-shown again.
  useRestoreVirtualizerScroll(rowVirtualizer, parentRef);

  // Adopt an externally-driven selection: File History / Search / Blame push
  // the commit they act on here via `notifyIfOpen("log", sha)` so the graph
  // highlight, Commit Details and Changed Files always agree. We only move the
  // highlight (and scroll to it) — the source panel already summons Commit
  // Details / Changed Files, so this panel must NOT re-summon them (that would
  // loop). Refs keep the callback stable so the summon target isn't
  // re-registered every render. A commit outside the loaded window sets the
  // selection and becomes a pending jump: the seek effect (below, next to the
  // infinite-scroll effect) grows the fetch window until the commit loads,
  // then centers it.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const virtualizerRef = useRef(rowVirtualizer);
  virtualizerRef.current = rowVirtualizer;
  // In-place edit state (reword / stash rename / branch rename / create
  // branch / create tag) and its handlers; rows read it via the row context.
  const edits = useInlineEdits({
    repo,
    actions,
    queryClient,
    checkoutNewBranch,
    headId,
    rowsRef,
    virtualizerRef,
  });
  const { handleCreateBranchStart } = edits;

  const adoptSelection = useCallback((payload: unknown) => {
    // `{ filterRef }` payload (ref menus' "Show only this branch"): switch
    // the walk to that ref. Clears an active search - its hits may not be
    // reachable from the ref, so cycling would just toast.
    if (payload && typeof payload === "object") {
      const filterRef = (payload as { filterRef?: unknown }).filterRef;
      if (typeof filterRef === "string") {
        setBranchFilter(filterRef);
        setSearch(null);
        setSearchDraft("");
        setSearchHit(0);
      }
      return;
    }
    if (typeof payload !== "string") return;
    selectSingle(payload as CommitId);
    const idx = rowsRef.current.findIndex((c) => c.id === payload);
    if (idx >= 0) {
      if (shouldCenterScroll(idx, virtualizerRef.current.range)) {
        virtualizerRef.current.scrollToIndex(idx, { align: "center" });
      }
    } else {
      // Beyond the loaded window - hand off to the seek effect, which grows
      // the fetch window until the commit is loaded, then scrolls to it.
      setPendingJump(payload as CommitId);
    }
  }, []);
  useSummonTarget("log", adoptSelection);

  // Lane assignments, edge lookups, and row spans for the graph column.
  const {
    stashSelectorById,
    assignments,
    edgesByCommit,
    incomingEdgesByCommit,
    edgeSpans,
    stashConnectorSpans,
  } = useGraphModel({
    repoId: repo.id,
    rows,
    commits,
    graphDisabled: authorFilter !== null,
    lockMap,
    rawLocks,
    stashBaseLaneColor,
  });

  // Dynamic column width. getVirtualItems() always returns a new array
  // reference so we compute inline; also include active pass-through lanes
  // so the column is wide enough when a pass-through lane is wider than any
  // visible commit lane.
  const visibleItems = rowVirtualizer.getVirtualItems();

  // More commits may exist when the backend returned a full page. Once it
  // returns fewer than requested, the end of history has been reached. The
  // injected stash nodes don't count toward the page — only real commits are
  // capped by `--max-count`.
  const hasMore = commits.length - stashSelectorById.size >= totalToFetch;

  // The "Loading more…" strip follows the delayed-busy rule: watcher-driven
  // background refetches settle well within the delay and must not flash it.
  const showLoadingMore = useDelayedFlag(hasMore && isFetching);

  // Infinite scroll: grow the fetch window when the user scrolls the last row
  // into view. The growing queryKey turns `isFetching` true, which guards
  // against re-triggering until the new page has arrived; once the taller list
  // renders, the last row is no longer in view, so it won't auto-page forever.
  const lastVisibleIndex = visibleItems[visibleItems.length - 1]?.index ?? 0;
  useEffect(() => {
    if (hasMore && !isFetching && lastVisibleIndex >= rows.length - 1) {
      setExtraPages((n) => n + 1);
    }
  }, [hasMore, isFetching, lastVisibleIndex, rows.length]);

  // Seek for a jump target beyond the loaded window (Refs click on an old
  // tag/branch/stash): grow the fetch window until the commit is loaded, then
  // center it. `isFetching` gates each step so the decision only runs on
  // settled data; the growth is exponential (see `growJumpWindow`). When the
  // walk is exhausted without a hit the commit is unreachable in the walked
  // refs (e.g. hidden remote branches) - stop and say so instead of silence.
  useEffect(() => {
    if (!pendingJump || isFetching) return;
    const idx = rows.findIndex((c) => c.id === pendingJump);
    const action = pendingJumpAction(idx >= 0, hasMore);
    if (action === "scroll") {
      setPendingJump(null);
      if (shouldCenterScroll(idx, rowVirtualizer.range)) {
        rowVirtualizer.scrollToIndex(idx, { align: "center" });
      }
    } else if (action === "extend") {
      setExtraPages(growJumpWindow);
    } else {
      setPendingJump(null);
      notify.info("This commit is not in the log - it may only be reachable from hidden remote branches.");
    }
  }, [pendingJump, isFetching, rows, hasMore, rowVirtualizer]);

  // Land the selection on the toolbar search's current hit once results
  // settle or the hit index moves (Enter cycles it). Keyed so a background
  // refetch of the same search (watcher invalidation) never re-jumps under
  // the user. The pending-jump seek does the centering, growing the window
  // when the hit is beyond the loaded rows (or toasting when it isn't in
  // the walk at all, e.g. off-branch under a branch filter).
  const lastHitJumpRef = useRef("");
  useEffect(() => {
    if (search === null) {
      lastHitJumpRef.current = "";
      return;
    }
    if (searchFetching) return;
    const key = `${search.query}\0${searchHit}`;
    if (lastHitJumpRef.current === key) return;
    const hit = searchHits[searchHit];
    if (!hit) return;
    lastHitJumpRef.current = key;
    selectSingle(hit);
    setPendingJump(hit);
  }, [search, searchFetching, searchHits, searchHit]);

  const maxVisibleLane = maxVisibleLaneFor(visibleItems, rows, assignments, edgeSpans);

  // Latest-ref so handleRowClick stays referentially stable across selection
  // changes (same pattern as rowsRef above).
  const selectionRef = useRef<SelectionState>({ lead: null, ids: new Set() });
  selectionRef.current = { lead: selectedId, ids: selectedIds };

  // The working-dir row and stash rows never join a multi-selection: the
  // bulk actions (cherry-pick/revert/compare) don't apply to them.
  const isMultiSelectable = useCallback(
    (id: CommitId) => id !== WORKING_DIR_ID && !stashSelectorById.has(id),
    [stashSelectorById],
  );

  const handleRowClick = useCallback(
    (commit: Commit, e: React.MouseEvent) => {
      const modifiers = { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey };
      const next = applyRowClickSelection(
        selectionRef.current,
        rowsRef.current.map((r) => r.id),
        commit.id,
        modifiers,
        isMultiSelectable,
      );
      if (next !== selectionRef.current) {
        setSelectedId(next.lead);
        setSelectedIds(next.ids);
      }
      // Modifier clicks build a bulk selection - they never summon panels.
      if (modifiers.ctrl || modifiers.shift) return;
      summonForRow(commit);
    },
    [isMultiSelectable]
  );

  // The detail panels a single-selection lands on (plain click or plain
  // arrow step share this).
  const summonForRow = useCallback((commit: Commit) => {
    const summon = useSummonStore.getState();
    if (commit.id === WORKING_DIR_ID) {
      // Working-dir row → show the staging/commit panel in the shared side
      // slot (swapping out Changed Files). No commit-details for the index.
      // The `null` payload tells the panel to sync the Diff/Merge slot to
      // its own selection (clearing a stale commit diff).
      summon.swapSummon("working-changes", "changed-files", null);
      return;
    }
    summon.summon("commit-details", commit.id);
    // Show Changed Files in the shared slot (swapping out Working Changes).
    summon.swapSummon("changed-files", "working-changes", commit.id);
  }, []);

  // Type-to-jump quick search and list keyboard navigation.
  const applySelection = useCallback((sel: SelectionState) => {
    setSelectedId(sel.lead);
    setSelectedIds(sel.ids);
  }, []);
  const { quickOverlay, handleQuickSearchKey } = useQuickJump({
    rowsRef,
    virtualizerRef,
    selectionRef,
    selectedId,
    selectSingle,
    applySelection,
    isMultiSelectable,
    summonForRow,
  });

  // Grid column layout — driven by `colState` (order + widths + hidden).
  // Memoized so the row context (which carries it) only changes identity
  // when the layout actually does.
  const layout = useMemo(
    () =>
      computeColumnLayout({
        colState,
        authorFilterActive: authorFilter !== null,
        maxVisibleLane,
        laneSpacing: LANE_SPACING,
        uiFontSize: TEXT_SIZE,
        maxWidths: contentMaxWidths,
      }),
    [colState, authorFilter, maxVisibleLane, LANE_SPACING, TEXT_SIZE, contentMaxWidths],
  );
  const { visibleColumns, colWidth, gridColumns: GRID_COLUMNS, minRowWidth } = layout;

  const handleReorder = (
    draggedId: ColumnId,
    targetId: ColumnId,
    side: "left" | "right"
  ) => {
    const next = reorderColumns(colState.order, draggedId, targetId, side);
    if (next) setOrder(next);
  };
  const handleHide = (id: ColumnId) => {
    if (colState.hidden.includes(id)) return;
    setHidden([...colState.hidden, id]);
  };
  const handleShow = (id: ColumnId) =>
    setHidden(colState.hidden.filter((h) => h !== id));

  // Enter on an already-submitted query advances to the next hit (wrapping);
  // Shift+Enter steps back. A changed query submits a new search - the
  // hit-jump effect (above, next to the seek effect) lands on its first hit
  // once results arrive.
  const submitSearch = (backwards = false) => {
    const q = searchDraft.trim();
    if (!q) {
      clearSearch();
      return;
    }
    if (search !== null && search.query === q) {
      const n = searchHits.length;
      if (n > 0) setSearchHit((h) => (h + (backwards ? -1 : 1) + n) % n);
      return;
    }
    if (q.toLowerCase() === "abdäsele") void toggleAbdaesele().catch(() => {});
    setSearch({ query: q });
    setSearchHit(0);
  };

  const clearSearch = useCallback(() => {
    setSearch(null);
    setSearchDraft("");
    setSearchHit(0);
  }, []);

  // Everything panel-constant the rows need, plus stable getters for the
  // volatile selection/rows (read at event time, so selection changes don't
  // re-render every row through the context).
  const getSelection = useCallback(() => selectionRef.current, []);
  const getRows = useCallback(() => rowsRef.current, []);
  const rowContext = useMemo<CommitsRowContextValue>(
    () => ({
      repoId: repo.id,
      textSize: TEXT_SIZE,
      rowHeight: ROW_HEIGHT,
      laneSpacing: LANE_SPACING,
      dotRadius: DOT_RADIUS,
      lineWidth: LINE_WIDTH,
      avatarsEnabled: AVATARS_ENABLED,
      initialsEnabled: INITIALS_ENABLED,
      dateAbsolute: DATE_ABSOLUTE,
      dateFormat: DATE_FORMAT,
      dateShowTime: DATE_SHOW_TIME,
      laneChipFilters,
      stashBaseLaneColor,
      locks: rawLocks,
      upstreamMap,
      worktreeBranches,
      worktreeHeadsBySha,
      branches,
      remotes: remoteNames,
      currentBranch: currentBranchName ?? null,
      currentBranchLocal: currentBranch,
      tracking: tracking ?? null,
      headSha,
      headIsRewordable,
      pushedTags,
      tagTargetsOnRemote,
      tagRemote: tagRemote ?? null,
      unpushedSet,
      commitMessageById,
      stashSelectorById,
      signedSet,
      verifiedSignatures,
      opInProgress,
      assignments,
      edgesByCommit,
      incomingEdgesByCommit,
      edgeSpans,
      stashConnectorSpans,
      visibleColumns,
      gridColumns: GRID_COLUMNS,
      maxVisibleLane,
      getSelection,
      getRows,
      isMultiSelectable,
      actions,
      edits,
      upstreamCandidatesFor,
      onOpenWorktree: handleOpenWorktree,
      setAuthorFilter,
      clearSearch,
      onRowClick: handleRowClick,
    }),
    [
      repo.id,
      TEXT_SIZE,
      ROW_HEIGHT,
      LANE_SPACING,
      DOT_RADIUS,
      LINE_WIDTH,
      AVATARS_ENABLED,
      INITIALS_ENABLED,
      DATE_ABSOLUTE,
      DATE_FORMAT,
      DATE_SHOW_TIME,
      laneChipFilters,
      stashBaseLaneColor,
      rawLocks,
      upstreamMap,
      worktreeBranches,
      worktreeHeadsBySha,
      branches,
      remoteNames,
      currentBranchName,
      currentBranch,
      tracking,
      headSha,
      headIsRewordable,
      pushedTags,
      tagTargetsOnRemote,
      tagRemote,
      unpushedSet,
      commitMessageById,
      stashSelectorById,
      signedSet,
      verifiedSignatures,
      opInProgress,
      assignments,
      edgesByCommit,
      incomingEdgesByCommit,
      edgeSpans,
      stashConnectorSpans,
      visibleColumns,
      GRID_COLUMNS,
      maxVisibleLane,
      getSelection,
      getRows,
      isMultiSelectable,
      actions,
      edits,
      upstreamCandidatesFor,
      handleOpenWorktree,
      setAuthorFilter,
      clearSearch,
      handleRowClick,
    ],
  );

  return (
    <PanelContextMenuProvider baseline={baseline}>
      {({ openMenu }) => (
        <CommitsRowContext.Provider value={rowContext}>
        <div
          className="legit-panel"
          style={{ display: "flex", flexDirection: "column" }}
          // Catch-all: any right-click that isn't handled by a more specific
          // target (chip, header, graph cell) opens the baseline-only menu and
          // suppresses the native browser menu.
          onContextMenu={(e) => openMenu(e)}
        >
      {/* Loading indicator — thin top-edge bar, no layout shift. Refresh lives
          in the panel context menu (baseline entry). */}
      <PanelLoadingBar active={isFetching || searchFetching} />

      {/* Remote sync toolbar — fetch / pull / push + ahead-behind for the
          current branch. Self-contained; reuses the already-fetched branches.
          The trailing slot carries the search controls: Enter runs a
          full-history backend search and cycles the selection through the
          hits inside the intact graph (Shift+Enter backwards; Esc / Clear
          dismisses). The branch chip shows an active branch-only walk (ref
          menus' "Show only this branch"). */}
      <RemoteSyncToolbar
        repoId={repo.id}
        branches={branches}
        onCreateBranch={handleCreateBranchStart}
        onStash={handleCreateStash}
        hasUncommittedChanges={status.length > 0}
        trailing={
          <div
            // Right-floating block, packed right (flex-end) and growing into
            // the line's free space so chips render full-length whenever room
            // exists. The flex BASIS is the block's acceptable compressed
            // minimum (input min + ~6em per chip + counter): the block stays
            // on the buttons' line while it can still compress (chips
            // ellipsize, input shrinks), and wraps onto its own full-width
            // line exactly when compression would go below that minimum.
            style={{
              marginLeft: "auto",
              flex: `1 1 ${
                10 +
                (branchFilter !== null ? 6 : 0) +
                (authorFilter !== null ? 6 : 0) +
                (search !== null ? 5 : 0)
              }em`,
              minWidth: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "flex-end",
              gap: "0.5em",
            }}
          >
            {branchFilter !== null && (
              <FilterChip
                label={branchFilter}
                title={`Showing only commits reachable from ${branchFilter}`}
                clearTitle="Show all branches again"
                onClear={() => setBranchFilter(null)}
              />
            )}
            {authorFilter !== null && (
              <FilterChip
                label={authorFilter.name}
                title={`Showing only commits by ${authorFilter.name} <${authorFilter.email}>`}
                clearTitle="Show all authors again"
                onClear={() => setAuthorFilter(null)}
              />
            )}
            <div
              // No minimum: under pressure the input yields all the way down
              // rather than pushing overflow into the hit counter / chips
              // (form controls also carry an intrinsic minimum - the inner
              // input zeroes it explicitly).
              style={{
                position: "relative",
                flex: "1 1 12em",
                minWidth: 0,
                maxWidth: "22em",
                display: "flex",
              }}
            >
              <input
                type="text"
                value={searchDraft}
                onChange={(e) => setSearchDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitSearch(e.shiftKey);
                  if (e.key === "Escape") clearSearch();
                }}
                placeholder="Search commits…"
                title="Searches message and author across full history; a SHA, branch, tag, or rev expression jumps there first. Enter cycles through the hits (Shift+Enter backwards), Esc clears."
                // Right padding keeps the text clear of the ✕; minWidth 0
                // defeats the browser's intrinsic input minimum so the field
                // can actually shrink with its wrapper.
                style={{ ...TOOLBAR_FIELD_STYLE, flex: 1, minWidth: 0, paddingRight: "1.8em" }}
              />
              {(searchDraft !== "" || search !== null) && (
                <button
                  title="Clear search (Esc)"
                  onClick={clearSearch}
                  style={{
                    position: "absolute",
                    right: 2,
                    top: "50%",
                    transform: "translateY(-50%)",
                    height: "auto",
                    padding: "0 0.333em",
                    border: "none",
                    background: "transparent",
                    cursor: "pointer",
                    color: "var(--subtle-fg)",
                    fontSize: "var(--fz-sm)",
                    lineHeight: 1,
                  }}
                >
                  ✕
                </button>
              )}
            </div>
            {search !== null && (
              <span
                className="legit-subtle"
                // Keeps its space unconditionally: the input never grows (or
                // pushes overflow) into the hit counter.
                style={{ fontSize: "var(--fz-sm)", whiteSpace: "nowrap", flexShrink: 0 }}
              >
                {searchHits.length === 0
                  ? searchFetching
                    ? "searching…"
                    : "no matches"
                  : `${searchHit + 1} of ${searchHits.length}${
                      searchHits.length >= SEARCH_MAX_RESULTS ? "+" : ""
                    }`}
              </span>
            )}
          </div>
        }
      />

      {isError && (
        <PanelError error={error} />
      )}

      {/* Column headers - fixed above the virtualised list; the grid is
          translated by the list's horizontal scroll offset so the header
          columns stay exactly over their cells (see headerShift). */}
      <div style={{ overflow: "hidden", flexShrink: 0 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: GRID_COLUMNS,
          gap: `0 ${COLUMN_GAP}px`,
          padding: "0.25em 1em",
          borderBottom: "1px solid var(--panel-border, rgba(255,255,255,0.10))",
          background: "var(--panel-bg, transparent)",
          minWidth: minRowWidth,
          minHeight: 22,
          transform: `translateX(${-headerShift}px)`,
        }}
      >
        {visibleColumns.map((colId, colIndex) => {
          // Columns right of the elastic Subject filler are anchored at their
          // right edge — growing them expands leftward — so their resize
          // handle lives on the left edge with inverted drag direction.
          // (Subject is non-hideable, so it is always in `visibleColumns`.)
          const resizeEdge =
            colIndex > visibleColumns.indexOf("subject") ? "left" : "right";
          return colId === "graph" ? (
            <div key="graph-header" style={{ position: "relative", overflow: "hidden" }}>
              <ColumnHeader
                colId={colId}
                // Header label intentionally blank; the graph column needs no
                // title. COLUMN_LABELS.graph is still used for the show/hide menu.
                label=""
                width={colWidth(colId)}
                isDraggable={true}
                isResizable={!NON_RESIZABLE.includes(colId)}
                isHideable={!NON_HIDEABLE.includes(colId)}
                hidden={colState.hidden}
                labels={COLUMN_LABELS}
                onReorder={handleReorder}
                onHide={handleHide}
                onShow={handleShow}
                onResizeEnd={(id, w) => setWidth(id, w)}
                showSeparator={colIndex < visibleColumns.length - 1}
              />
              {/* Lock indicators: a lock icon per locked lane visible in the
                  current window (§F.7); click it to remove the lock. */}
              {rawLocks.map((lock) => {
                const laneIdx = lockMap[lock.refName];
                if (laneIdx === undefined) return null;
                return (
                  <LaneLockIndicator
                    key={lock.refName}
                    refName={lock.refName}
                    laneIndex={laneIdx}
                    laneSpacing={LANE_SPACING}
                    repoId={repo.id}
                    color={laneColor(laneIdx)}
                  />
                );
              })}
            </div>
          ) : (
            <ColumnHeader
              key={colId}
              colId={colId}
              // The Signed column is icon-only (one icon wide): its header is
              // the same key glyph the cells use. COLUMN_LABELS.signed still
              // labels it in the show/hide menu.
              label={
                colId === "signed" ? (
                  <SignedIcon aria-label="Signed" style={{ display: "block" }} />
                ) : (
                  COLUMN_LABELS[colId]
                )
              }
              width={colWidth(colId)}
              isDraggable={true}
              isResizable={!NON_RESIZABLE.includes(colId)}
              isHideable={!NON_HIDEABLE.includes(colId)}
              hidden={colState.hidden}
              labels={COLUMN_LABELS}
              onReorder={handleReorder}
              onHide={handleHide}
              onShow={handleShow}
              onResizeEnd={(id, w) => setWidth(id, w)}
              resizeEdge={resizeEdge}
              showSeparator={colIndex < visibleColumns.length - 1}
            />
          );
        })}
      </div>
      </div>

      {/* Virtualised rows. A little top padding keeps the first row clear of
          the header so a tall chip on the top commit isn't clipped against it;
          it scrolls away with the content. Focusable (clicking anywhere in the
          list focuses it) so type-to-jump quick search receives keystrokes. */}
      <div
        ref={parentRef}
        tabIndex={0}
        onKeyDown={handleQuickSearchKey}
        onScroll={(e) => {
          // Keep the (vertically fixed) header horizontally in lockstep.
          // Same-value updates bail out, so vertical scrolling is free.
          setHeaderShift(e.currentTarget.scrollLeft);
        }}
        style={{ flex: 1, overflow: "auto", position: "relative", paddingTop: "0.333em", outline: "none" }}
      >
        {/* Quick-search indicator: what's been typed, while the buffer is
            live. Sticky so it stays put as the list scrolls under it. */}
        {quickOverlay !== null && (
          <div
            style={{
              position: "sticky",
              top: 0,
              zIndex: 3,
              display: "flex",
              justifyContent: "flex-end",
              height: 0,
              overflow: "visible",
            }}
          >
            <span
              style={{
                margin: "0.167em 1em 0 0",
                padding: "0.167em 0.667em",
                fontSize: "var(--fz-sm)",
                fontFamily: "monospace",
                background: "var(--panel-bg)",
                border: "1px solid var(--panel-border)",
                borderRadius: 3,
                boxShadow: "0 2px 8px var(--shadow-color)",
                whiteSpace: "nowrap",
              }}
            >
              {quickOverlay}
              <span className="legit-subtle"> — Alt+↑/↓ next/prev</span>
            </span>
          </div>
        )}
        <div
          style={{
            height: rowVirtualizer.getTotalSize(),
            width: "100%",
            // Wider than the viewport when the columns overflow: the rows
            // are width-100% OF THIS BOX, so their selection/hover
            // backgrounds span the whole scrollable line.
            minWidth: minRowWidth,
            position: "relative",
          }}
        >
          {visibleItems.map((vItem) => {
            const commit = rows[vItem.index];
            return (
              <CommitRow
                key={vItem.key}
                commit={commit}
                rowIndex={vItem.index}
                start={vItem.start}
                isSelected={commit.id === selectedId || selectedIds.has(commit.id)}
                measureElement={rowVirtualizer.measureElement}
              />
            );
          })}
        </div>
      </div>

      {/* Auto-loads the next page as the last row scrolls into view; the
          spinner indicates that fetch is in flight (debounced ~150ms). */}
      {showLoadingMore && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "0.667em",
            padding: "0.667em 1em",
            borderTop: "1px solid var(--panel-border)",
          }}
        >
          <span className="legit-spinner" aria-hidden="true" />
          <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)" }}>
            Loading more…
          </span>
        </div>
      )}
        </div>
        </CommitsRowContext.Provider>
      )}
    </PanelContextMenuProvider>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Active-filter chip in the sync toolbar (branch / author walk filters):
 *  the same "selected" surface as the active view-mode toggles, plus an ✕.
 *  The ✕ opts out of the toolbar's 2em button height (it sits INSIDE a 2em
 *  chip). */
function FilterChip({
  label,
  title,
  clearTitle,
  onClear,
}: {
  label: string;
  title: string;
  clearTitle: string;
  onClear: () => void;
}) {
  return (
    <span
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.333em",
        fontSize: "var(--fz-sm)",
        fontFamily: "monospace",
        border: "1px solid var(--panel-border)",
        borderRadius: 3,
        padding: "0 0.333em",
        height: "2em",
        boxSizing: "border-box",
        whiteSpace: "nowrap",
        // Shrinkable (the label ellipsizes) so long filter labels squeeze
        // before they crush the search input into the panel border.
        flex: "0 1 auto",
        minWidth: "5em",
        background: "var(--button-active-bg, rgba(255,255,255,0.12))",
      }}
    >
      {/* minWidth 0 lets the label actually shrink inside the flex chip. */}
      <span style={{ flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
        {label}
      </span>
      <button
        title={clearTitle}
        onClick={onClear}
        style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--panel-fg)", padding: 0, height: "auto", flexShrink: 0 }}
      >
        ✕
      </button>
    </span>
  );
}

