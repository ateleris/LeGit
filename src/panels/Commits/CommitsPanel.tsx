import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PanelError } from "../shared/PanelError";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useActiveRepo, useRepoStore } from "../../store/repos";
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
import { ToolbarButton } from "../shared/ToolbarButton";
import { Button } from "../shared/buttons";
import { CaretDropdown } from "../shared/CaretDropdown";
import { invalidateRepoDomains } from "../../lib/repoInvalidation";
import { autoUpdateSubmodules } from "../../lib/submodules";
import {
  consoleCancel,
  repoBranches,
  repoCreateBranch,
  repoFetch,
  repoListRemotes,
  repoLog,
  repoResolveCommit,
  repoSearchCommits,
  repoPull,
  repoSignaturePresence,
  repoStatus,
  repoTrackingStatus,
  repoStashBranch,
  repoTags,
  repoRemoteTags,
} from "../../lib/commands";
import { pushedTagNames, resolveTagRemote } from "../../lib/tags";
import { openStashDiff } from "../Stashes/StashesPanel";
import { notifySwitchError } from "../../lib/switchFeedback";
import { useOpState } from "../../lib/useOpState";
import type { Branch, Commit, CommitId, FileStatus, MergeOptions, PullStrategy, PushOptions, Remote, RemoteTag, ResetMode, Signature, TagInfo, TrackingStatus } from "../../lib/types";
import { useRemoteProgressStore } from "../../store/remoteProgress";
import { formatAppError } from "../../lib/types";
import { remoteOpErrorMessage } from "../../lib/pushFeedback";
import { pushWithTagFollowUp } from "../../lib/autoPushTags";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { notify } from "../../store/notifications";
import { BranchIcon, BranchPlusIcon, FetchIcon, PullIcon, PushIcon, ChevronDownIcon, RemoteIcon, SignedIcon, StashIcon, TagIcon } from "../../icons";
import { useSignatureStore } from "../../store/signatures";
import { useTagRemoteChoice } from "../../store/tagRemote";
import { formatAbsolute, formatFull, formatRelative } from "../../lib/time";
import { RefsCell } from "./cells/RefsCell";
import { InlineRenameInput } from "./cells/InlineRenameInput";
import { SignatureBadge } from "./cells/SignatureBadge";
import { GraphCellWithAvatar, laneColor } from "./cells/GraphCell";
import { computeLanes } from "./graph/lanes";
import { computeEdgeSpans } from "./graph/spans";
import { pickHeadCommitId } from "./headId";
import { growJumpWindow, pendingJumpAction, shouldCenterScroll } from "./scrollToRow";
import { mergeSearchResults, quickSearchMatch } from "./commitSearch";
import { applyRowClickSelection, bulkActionPlan, type SelectionState } from "./multiSelect";
import type { LaneEdge, LaneIndex, LaneResult, LockMap, RefsAtCommit } from "./graph/types";
import {
  buildLockMap,
  buildRefsAt,
  buildStashSelectorById,
  buildUpstreamMap,
} from "./commitRows";
import { BRANCH_DOMAINS, useCommitActions } from "./useCommitActions";
import { useColumnState } from "./columns/useColumnState";
import { ColumnHeader } from "./columns/ColumnHeader";
import { LaneLockIndicator } from "./LaneLockIndicator";
import { PanelContextMenuProvider, type BaselineEntry } from "./menu/PanelContextMenu";
import { MenuItem, SectionLabel, Separator, Submenu } from "./menu/primitives";
import { StashMenuSection } from "./menu/StashMenuSection";
import { ResetMenuItems } from "./menu/ResetMenuItems";
import { UndoLastCommitMenuItem } from "./menu/UndoLastCommitMenuItem";
import { undoLastCommitPlan } from "./undoLastCommit";
import { mainlineChoices } from "./mainline";
import { BranchMenuSection, RemoteBranchMenuSection } from "./menu/BranchMenuSection";
import { TagMenuSection } from "./menu/TagMenuSection";
import { branchesAt } from "./cells/refChips";
import {
  COLUMN_GAP,
  columnGridTrack,
  columnsMinWidth,
  NON_HIDEABLE,
  NON_RESIZABLE,
} from "./columns/types";
import type { ColumnId } from "./columns/types";
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
const SEARCH_MAX_RESULTS = 1000;

// Easter egg (inherited from the retired Search panel): searching for
// "abdäsele" swaps the window title between "LeGit" and "LegIt" (dev builds:
// "LeGit DEV" / "LegIt DEV"). Purely session-local: nothing is persisted, a
// restart restores the real title.
async function toggleAbdaesele(): Promise<void> {
  const win = getCurrentWindow();
  const title = await win.title();
  const next = title.includes("LegIt")
    ? title.replace("LegIt", "LeGit")
    : title.replace("LeGit", "LegIt");
  if (next !== title) await win.setTitle(next);
}


// Sentinel id for the synthetic "uncommitted changes" row prepended above HEAD.
// Chosen to never collide with a real 40-hex commit id.
export const WORKING_DIR_ID = "__legit_working_dir__";

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

  const [selectedId, setSelectedId] = useState<CommitId | null>(null);
  // Multi-selection (Ctrl/Shift click; see multiSelect.ts for the rules).
  // Contains the lead when set; single-select paths (summon, search,
  // quick-jump) collapse it via selectSingle.
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<CommitId>>(new Set());
  const selectSingle = useCallback((id: CommitId) => {
    setSelectedId(id);
    setSelectedIds(new Set([id]));
  }, []);
  const [extraPages, setExtraPages] = useState(0);
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
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState<{ query: string } | null>(null);
  // Which hit the selection sits on; Enter advances it (wrapping).
  const [searchHit, setSearchHit] = useState(0);
  // Branch filter (ref menus' "Show only this branch"): restricts the log
  // WALK to commits reachable from the ref (`repoLog` revision_range). The
  // graph stays - a ref's history is connected, unlike text-search results.
  const [branchFilter, setBranchFilter] = useState<string | null>(null);
  // Author filter (row menu "Show only commits by …"): restricts the walk to
  // one author (`--author`, matched by email; the name labels the chip).
  // Unlike a branch, an author's commits are an arbitrary subset, so the
  // graph column hides while this is active. Combines with the branch filter.
  const [authorFilter, setAuthorFilter] = useState<{ name: string; email: string } | null>(null);
  const parentRef = useRef<HTMLDivElement>(null);
  // The list's horizontal scroll offset, mirrored onto the header grid as a
  // translateX. A transform (not wrapper scrollLeft) because the header
  // wrapper's own max scroll is SMALLER than the list's (the vertical
  // scrollbar narrows the list viewport), so a scrollLeft sync clamps near
  // the end and the columns drift apart on the final few pixels.
  const [headerShift, setHeaderShift] = useState(0);

  // In-place editing in the Subject column: rewording a commit's subject line
  // or renaming a stash's message. The row keeps its normal layout — only the
  // subject text is swapped for an input (Enter approves, Esc discards).
  const [subjectEdit, setSubjectEdit] = useState<
    { kind: "reword" | "stashRename"; id: string } | null
  >(null);
  const [subjectBusy, setSubjectBusy] = useState(false);

  // Branch being renamed in place inside its ref chip (short name, unique
  // across the repo — at most one chip matches).
  const [renamingBranch, setRenamingBranch] = useState<string | null>(null);

  // Create-new-branch mode: shows an empty branch-name input on `rowId`'s ref
  // cell; the branch is only created when a name is confirmed. From the
  // toolbar the input sits on the HEAD row and `startPoint` is undefined
  // (git branches at HEAD proper); from a row's context menu the clicked
  // commit's SHA is the explicit start point. With `stashSha` set (a stash
  // row's "Branch from stash…"), confirming runs `git stash branch` instead:
  // branch at the stash's base, stash applied and dropped.
  const [branchCreation, setBranchCreation] = useState<
    { rowId: CommitId; startPoint?: string; stashSha?: string } | null
  >(null);

  // Create-new-tag mode (row context menu): same pattern as branchCreation;
  // the input creates a lightweight tag at the clicked commit. Annotated tags
  // (with a message) are created via the Refs panel's Tags section.
  const [tagCreation, setTagCreation] = useState<{ rowId: CommitId } | null>(null);

  // Column ordering, hiding, and widths — read from global settings on mount
  // and persisted (debounced) via `save_column_preferences`.
  const { state: colState, setOrder, setHidden, setWidth } = useColumnState();

  const totalToFetch = PAGE_SIZE * (1 + extraPages);

  // Load lane locks on mount / when the active repo changes.
  const loadLocks = useLaneLocksStore((s) => s.loadLocks);
  useEffect(() => {
    if (repo) loadLocks(repo.id);
  }, [repo?.id, loadLocks]);

  // Discard any in-place edit when the active repo changes — the edited
  // commit/stash/branch belongs to the previous repo.
  useEffect(() => {
    setSubjectEdit(null);
    setRenamingBranch(null);
    setBranchCreation(null);
    setTagCreation(null);
    setPendingJump(null);
    setSearch(null);
    setSearchDraft("");
    setSearchHit(0);
    setBranchFilter(null);
    setAuthorFilter(null);
  }, [repo?.id]);

  // Raw lock list from the store; used by the Refs context menu UI.
  const rawLocks = useLaneLocks(repo?.id ?? "");

  // Build a conflict-free LockMap for the lane algorithm. §H.5 says the
  // backend storage is permissive; if two locks claim the same lane (e.g.
  // from a hand-edited settings.json), the first one wins.
  const lockMap = useMemo((): LockMap => buildLockMap(rawLocks), [rawLocks]);

  // Per-repo "show remote branches in the commit tree" (null = default ON).
  // Part of the query key so flipping the setting refetches the walk.
  const repoSettings = useRepoStore((s) => (repo ? s.repoSettings[repo.id] : undefined));
  const loadRepoSettings = useRepoStore((s) => s.loadRepoSettings);
  useEffect(() => {
    if (repo && !repoSettings) loadRepoSettings(repo.id);
  }, [repo?.id, repoSettings, loadRepoSettings]);
  const showRemoteBranches = repoSettings?.show_remote_branches ?? true;

  const queryKey = [repo?.id, "log", totalToFetch, showRemoteBranches, branchFilter, authorFilter?.email];

  const { data: commits = [], isFetching, isError, error } = useQuery<Commit[]>({
    queryKey,
    queryFn: () =>
      repoLog(
        repo!.id,
        totalToFetch,
        0,
        branchFilter ?? undefined,
        showRemoteBranches,
        authorFilter?.email,
        // Branch filter: still show stashes BASED ON commits in the walk
        // (they hang off their base like in the full graph).
        branchFilter !== null ? true : undefined,
      ),
    enabled: !!repo,
    staleTime: 5_000,
    // Keep the current (smaller) page rendered while the larger page fetches.
    // Without this, the new totalToFetch query key has no cached data, the list
    // collapses to zero height, and the scroll position jumps back to the top.
    placeholderData: keepPreviousData,
  });

  // Filter results: same walk universe and row shape as the graph (the
  // backend searches HEAD + all local branches with the log format), capped
  // like the Search panel. Under the "log" domain so the watcher refreshes
  // the results after commits/amends like it does the graph.
  const { data: searchHits = [], isFetching: searchFetching } = useQuery<CommitId[]>({
    queryKey: [repo?.id, "log", "commits-search", search],
    queryFn: async () => {
      const { query } = search!;
      // Message OR author: git ANDs --grep and --author in one invocation,
      // so OR takes two walks merged client-side. The rev-parse probe runs
      // alongside; failure just means the query isn't a rev.
      const [resolved, byMessage, byAuthor] = await Promise.all([
        repoResolveCommit(repo!.id, query).catch(() => null),
        repoSearchCommits(repo!.id, query, "message", SEARCH_MAX_RESULTS),
        repoSearchCommits(repo!.id, query, "author", SEARCH_MAX_RESULTS),
      ]);
      const ids = mergeSearchResults(byMessage, byAuthor)
        .map((c) => c.id)
        .filter((id) => id !== resolved);
      return resolved ? [resolved, ...ids] : ids;
    },
    enabled: !!repo && search !== null,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });

  // Branch list (for upstream tracking). Drives chip fusion: a local branch
  // and its configured upstream remote collapse into one chip when both sit on
  // the same commit.
  const { data: branches = [] } = useQuery<Branch[]>({
    queryKey: [repo?.id, "branches"],
    queryFn: () => repoBranches(repo!.id),
    enabled: !!repo,
    staleTime: 5_000,
  });

  // Ahead/behind vs upstream — used to gate "Reword message…" (the tip commit
  // is only rewordable while it is local / not yet pushed). `null` when HEAD is
  // detached or the branch has no upstream.
  const { data: tracking } = useQuery<TrackingStatus | null>({
    queryKey: [repo?.id, "tracking"],
    queryFn: () => repoTrackingStatus(repo!.id),
    enabled: !!repo,
    staleTime: 5_000,
  });

  // Working-tree status — drives the synthetic "uncommitted changes" row.
  const { data: status = [] } = useQuery<FileStatus[]>({
    queryKey: [repo?.id, "status"],
    queryFn: () => repoStatus(repo!.id),
    enabled: !!repo,
    staleTime: 5_000,
  });

  // Full local ref → full upstream ref (e.g. refs/heads/dev → refs/remotes/origin/dev).
  const upstreamMap = useMemo(() => buildUpstreamMap(branches), [branches]);

  // Merge/rebase entry points need the current branch NAME for labels and are
  // hidden while an operation is already in progress. (Distinct from the
  // `currentBranch` Branch object below, which drives reword gating.)
  const currentBranchName = useMemo(
    () => branches.find((b) => !b.is_remote && b.is_current)?.name ?? null,
    [branches],
  );
  const opState = useOpState(repo?.id);
  const opInProgress = !!opState && opState.kind !== "none";

  // Tags: the local list (drives the row menus), the configured remotes (to
  // pick the tag-push target). ls-remote (below) is a network call — long
  // staleTime, no retry.
  const { data: tags = [] } = useQuery<TagInfo[]>({
    queryKey: [repo?.id, "tags"],
    queryFn: () => repoTags(repo!.id),
    enabled: !!repo,
    staleTime: 5_000,
  });
  const { data: remotesList = [] } = useQuery<Remote[]>({
    queryKey: [repo?.id, "remotes"],
    queryFn: () => repoListRemotes(repo!.id),
    enabled: !!repo,
    staleTime: 5_000,
  });
  // Same per-repo choice + resolver as the Tags section, so the "pushed"
  // indicators agree across panels and the remote-tags query is shared.
  const tagRemoteChoice = useTagRemoteChoice(repo?.id);
  const tagRemote = useMemo(
    () => resolveTagRemote(tagRemoteChoice, remotesList),
    [tagRemoteChoice, remotesList],
  );
  const remoteNames = useMemo(() => remotesList.map((r) => r.name), [remotesList]);

  // Verification verdicts for every commit inspected in Commit Details this
  // session (the list itself never verifies - it only knows presence). Each
  // recorded verdict upgrades that row's neutral "signed" chip permanently,
  // not just while the row is selected.
  const verifiedSignatures = useSignatureStore((s) => (repo ? s.byRepo[repo.id] : undefined));

  // Signature PRESENCE for the Signed column - pay-per-view: queried only
  // while the column is visible, as a second pass so the list itself renders
  // without waiting (and without the extra subprocess when hidden). Presence
  // is immutable per SHA, hence staleTime: Infinity and no watcher
  // invalidation; new commits change the key, and the backend's per-SHA cache
  // makes that refetch pay only for unseen SHAs. keepPreviousData stops the
  // chips from blinking out while the refetch runs.
  const signedColumnVisible = !colState.hidden.includes("signed");
  const commitIds = useMemo(() => commits.map((c) => c.id), [commits]);
  const { data: signedIds } = useQuery<CommitId[]>({
    queryKey: [repo?.id, "sig-presence", commitIds],
    queryFn: () => repoSignaturePresence(repo!.id, commitIds),
    enabled: !!repo && signedColumnVisible && commitIds.length > 0,
    staleTime: Infinity,
    placeholderData: keepPreviousData,
  });
  const signedSet = useMemo(() => new Set(signedIds ?? []), [signedIds]);

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

  // Branch rename happens in place, inside the branch's ref chip.
  const handleBranchRename = useCallback((name: string) => {
    setRenamingBranch(name);
  }, []);

  const handleBranchRenameSave = useCallback(
    async (oldName: string, newName: string) => {
      setRenamingBranch(null);
      await actions.handleBranchRenameSave(oldName, newName);
    },
    [actions],
  );

  const handleBranchRenameCancel = useCallback(() => {
    setRenamingBranch(null);
  }, []);

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

  const handleRewordStart = useCallback((commit: Commit) => {
    setSubjectEdit({ kind: "reword", id: commit.id });
    setSubjectBusy(false);
  }, []);

  const handleSubjectEditCancel = useCallback(() => {
    setSubjectEdit(null);
    setSubjectBusy(false);
  }, []);

  // Save the in-place subject edit. For a reword, only the subject line is
  // edited — a multi-line body (everything after the first line) is preserved
  // verbatim. For a stash, the whole reflog subject is the message. On failure
  // the editor stays open (toast carries the error) so the draft isn't lost.
  const handleSubjectEditSave = useCallback(
    async (commit: Commit, value: string) => {
      if (!subjectEdit) return;
      setSubjectBusy(true);
      try {
        if (subjectEdit.kind === "reword") {
          await actions.rewordCommit(commit, value);
        } else {
          await actions.renameStash(commit.id, value);
        }
        setSubjectEdit(null);
      } catch (e) {
        notify.error(formatAppError(e));
      } finally {
        setSubjectBusy(false);
      }
    },
    [subjectEdit, actions],
  );

  const { data: remoteTags = [] } = useQuery<RemoteTag[]>({
    queryKey: [repo?.id, "remote-tags", tagRemote],
    queryFn: () => repoRemoteTags(repo!.id, tagRemote!, crypto.randomUUID()),
    enabled: !!repo && tagRemote !== null,
    staleTime: 300_000,
    retry: false,
  });
  const pushedTags = useMemo(() => pushedTagNames(tags, remoteTags), [tags, remoteTags]);
  // Tags whose target commit is on the remote; pushing the others is disabled
  // (it would upload commits no remote branch references).
  const tagTargetsOnRemote = useMemo(
    () => new Set(tags.filter((t) => t.target_on_remote).map((t) => t.name)),
    [tags],
  );

  // Create-new-tag flow: the input shows on the clicked row; the (lightweight)
  // tag is only created when a name is confirmed.
  const handleCreateTagStart = useCallback((commitId: CommitId) => {
    setTagCreation({ rowId: commitId });
  }, []);

  const handleCreateTagSave = useCallback(
    async (name: string) => {
      const creation = tagCreation;
      setTagCreation(null);
      if (!creation) return;
      await actions.createTag(name, creation.rowId, null);
    },
    [tagCreation, actions],
  );

  const handleCreateTagCancel = useCallback(() => {
    setTagCreation(null);
  }, []);

  // Stash rename happens in place: the stash row's subject (which shows the
  // stash message) becomes an input.
  const handleStashRename = useCallback((sha: string) => {
    setSubjectEdit({ kind: "stashRename", id: sha });
    setSubjectBusy(false);
  }, []);

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

  // Create-new-branch flow: scroll the target row into view and show the
  // empty branch-name input there; the branch is only created when a name is
  // confirmed (Esc leaves no trace). No `startPoint` = branch at HEAD proper
  // (the toolbar button); a commit SHA = branch from that commit (row menu).
  const handleCreateBranchStart = useCallback((startPoint?: string) => {
    const rowId = startPoint ?? headId;
    if (rowId === null) return; // empty repo — nothing to branch from
    setBranchCreation({ rowId, startPoint });
    const idx = rows.findIndex((c) => c.id === rowId);
    if (idx >= 0 && shouldCenterScroll(idx, rowVirtualizer.range)) {
      rowVirtualizer.scrollToIndex(idx, { align: "center" });
    }
  }, [headId, rows, rowVirtualizer]);

  // "Branch from stash…" — reuses the create-branch chip input on the stash's
  // own row; the save handler routes to `git stash branch` via `stashSha`.
  const handleStashBranchStart = useCallback((sha: string) => {
    setBranchCreation({ rowId: sha, stashSha: sha });
    const idx = rows.findIndex((c) => c.id === sha);
    if (idx >= 0 && shouldCenterScroll(idx, rowVirtualizer.range)) {
      rowVirtualizer.scrollToIndex(idx, { align: "center" });
    }
  }, [rows, rowVirtualizer]);

  const handleCreateBranchSave = useCallback(async (name: string) => {
    const creation = branchCreation;
    setBranchCreation(null);
    if (!repo || !creation) return;
    try {
      if (creation.stashSha) {
        await repoStashBranch(repo.id, creation.stashSha, name);
        notify.info(`Created branch '${name}' from the stash and checked it out.`);
      } else {
        await repoCreateBranch(repo.id, name, creation.startPoint);
        // Global setting (default on): a new branch is checked out right
        // away. handleBranchCheckout carries the switch feedback and its
        // own error handling (dirty-tree behavior etc.).
        if (checkoutNewBranch) await handleBranchCheckout(name);
      }
      invalidateRepoDomains(queryClient, repo.id, BRANCH_DOMAINS);
    } catch (e) {
      // stash branch checks out the new branch, so its failure mode is a
      // switch failure (dirty tree) — use the switch messaging for it.
      if (creation.stashSha) notifySwitchError(e);
      else notify.error(formatAppError(e));
    }
  }, [repo, branchCreation, checkoutNewBranch, queryClient]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCreateBranchCancel = useCallback(() => {
    setBranchCreation(null);
  }, []);

  // refsAt map (commitId -> [refName,...]) from log decorations: branch and
  // tag refs feed the lane algorithm (via §H locks in Phase 6).
  const refsAt = useMemo((): RefsAtCommit => buildRefsAt(commits), [commits]);

  // Stash nodes (synthetic commits the backend injects into the log). Maps the
  // stash's commit id → its reflog selector (e.g. "stash@{0}"), driving the
  // distinct diamond dot and the stash context-menu actions.
  const stashSelectorById = useMemo(() => buildStashSelectorById(commits), [commits]);

  // Stability refs for load-more. previousAssignments are reused ONLY when the
  // new rows are a pure bottom-append of the previous ones (pagination): i.e.
  // the previous row ids are still an exact prefix. Any other change — a stash
  // created/dropped, the working-dir row appearing/disappearing, a branch op —
  // fails the prefix test and triggers a full recompute. (A length-only check
  // would misread a synthetic-node insertion as load-more and pin rows to
  // lanes that were chosen for a different graph shape.)
  const prevAssignmentsRef = useRef<Map<string, number> | undefined>(undefined);
  const prevRowIdsRef = useRef<string[] | undefined>(undefined);

  const resetPrevAssignments = () => {
    prevAssignmentsRef.current = undefined;
    prevRowIdsRef.current = undefined;
  };

  // Reset on repo or lock change — a full recompute is needed in both cases.
  useEffect(() => { resetPrevAssignments(); }, [repo?.id]);    // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { resetPrevAssignments(); }, [rawLocks]);    // eslint-disable-line react-hooks/exhaustive-deps

  // Lane assignments + edges for EVERY row — real commits, injected stash nodes,
  // and the synthetic working-dir row alike. Nothing is special-cased out of the
  // graph: each node's parents drive its lane and edges through the one
  // algorithm. The working-dir row hangs off HEAD and a stash hangs off its base
  // exactly as any childless commit would. Only the working-dir row is flagged
  // to inherit its parent's locked lane (it continues HEAD's line). Stashes
  // deliberately are NOT (revised 2026-08-06): they render on free side lanes
  // exactly as they do without a lock - flagging them piled every stash onto
  // the locked lane (design/2026-07-09-lane-lock-synthetic-nodes.md).
  const { assignments, edges: allEdges } = useMemo((): LaneResult => {
    // An author-filtered walk is an arbitrary, mostly-disconnected subset:
    // the graph column is hidden, so skip the lane walk entirely (it would
    // open a lane per dangling parent and never close them).
    const laneRows = authorFilter !== null ? [] : rows;
    const forGraph = laneRows.map((c) => ({
      id: c.id,
      parentIds: c.parents,
      inheritsParentLane: c.id === WORKING_DIR_ID || undefined,
    }));
    const prevIds = prevRowIdsRef.current;
    const isPrefixAppend =
      prevIds !== undefined &&
      prevAssignmentsRef.current !== undefined &&
      forGraph.length > prevIds.length &&
      prevIds.every((id, i) => id === forGraph[i].id);
    const result = computeLanes(
      forGraph,
      lockMap,
      refsAt,
      isPrefixAppend ? prevAssignmentsRef.current : undefined,
    );
    prevAssignmentsRef.current = result.assignments;
    prevRowIdsRef.current = forGraph.map((c) => c.id);
    return result;
  }, [rows, authorFilter, lockMap, refsAt, stashSelectorById]);

  // Outgoing edge lookup: edges originating at each commit (child → parent).
  const edgesByCommit = useMemo(() => {
    const map = new Map<string, LaneEdge[]>();
    for (const edge of allEdges) {
      const arr = map.get(edge.fromCommitId) ?? [];
      arr.push(edge);
      map.set(edge.fromCommitId, arr);
    }
    return map;
  }, [allEdges]);

  // Incoming edge lookup: all edges arriving at each commit as parent.
  // GraphCell derives the top stub and jog arcs from these.
  const incomingEdgesByCommit = useMemo(() => {
    const map = new Map<string, LaneEdge[]>();
    for (const edge of allEdges) {
      const arr = map.get(edge.toCommitId) ?? [];
      arr.push(edge);
      map.set(edge.toCommitId, arr);
    }
    return map;
  }, [allEdges]);


  // Maps commitId → row index. Used to convert edges into row-span records.
  const commitIndexById = useMemo(
    () => new Map(rows.map((c, i) => [c.id, i])),
    [rows],
  );

  // Edge spans: for each edge, the lane that is "active" (waiting for the
  // parent commit) for the rows strictly between the two commit rows.
  const edgeSpans = useMemo(
    () => computeEdgeSpans(allEdges, commitIndexById, rows.length),
    [allEdges, commitIndexById, rows.length],
  );

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

  let maxVisibleLane = 0;
  for (const vItem of visibleItems) {
    const rowIndex = vItem.index;
    const c = rows[rowIndex];
    if (!c) continue;
    const lane = assignments.get(c.id) ?? 0;
    if (lane > maxVisibleLane) maxVisibleLane = lane;
    for (const span of edgeSpans) {
      if (span.fromRow < rowIndex && rowIndex < span.toRow && span.lane > maxVisibleLane) {
        maxVisibleLane = span.lane;
      }
    }
  }

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
    },
    [isMultiSelectable]
  );

  // Type-to-jump quick search state (used further below): declared BEFORE the
  // no-repo early return - the panel stays mounted when the last repo closes,
  // so a hook below that return changes the hook count across the transition
  // and crashes the tree (React errors 300/310; see CommitsPanel.test.tsx).
  const quickBufferRef = useRef("");
  const lastQuickQueryRef = useRef("");
  const quickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [quickOverlay, setQuickOverlay] = useState<string | null>(null);

  if (!repo) {
    return (
      <div className="legit-panel">
        <div className="legit-panel__body">
          <span className="legit-subtle">No repo open.</span>
        </div>
      </div>
    );
  }

  // Grid column layout — driven by `colState` (order + widths + hidden).
  // The Graph column's width tracks the maximum visible lane; Subject is
  // always the elastic filler. All others use the persisted px width
  // (or DEFAULT_WIDTHS if not yet set).
  const graphColWidth = (maxVisibleLane + 2) * LANE_SPACING;
  // The graph column hides under an author filter - lanes/edges between an
  // arbitrary subset of commits would be meaningless.
  const visibleColumns = colState.order.filter(
    (id) => !colState.hidden.includes(id) && !(authorFilter !== null && id === "graph")
  );

  // Signed column: fixed one-icon width, derived from the UI font size so it
  // scales with the rest of the chrome (icons render at 1em of TEXT_SIZE).
  const signedColWidth = Math.round(TEXT_SIZE * 1.3);

  // Subject never collapses below ~10 characters (see columnGridTrack).
  const subjectMinWidth = Math.round(TEXT_SIZE * 10);

  const colWidth = (id: ColumnId): string =>
    columnGridTrack(id, {
      graphColWidth,
      signedColWidth,
      subjectMinWidth,
      widths: colState.widths,
      maxWidths: contentMaxWidths,
    });

  const GRID_COLUMNS = visibleColumns.map(colWidth).join(" ");

  // Shared width floor for the header grid and the row container: a bare
  // `width: 100%` resolves to the scroller's VIEWPORT width, so with a
  // horizontal scrollbar the selection background ended mid-row. 24 = the
  // rows'/header's horizontal padding (border-box).
  const minRowWidth = columnsMinWidth(
    visibleColumns,
    { graphColWidth, signedColWidth, subjectMinWidth, widths: colState.widths, maxWidths: contentMaxWidths },
    COLUMN_GAP,
    24,
  );

  const handleReorder = (
    draggedId: ColumnId,
    targetId: ColumnId,
    side: "left" | "right"
  ) => {
    if (draggedId === targetId) return;
    const newOrder = [...colState.order];
    const fromIdx = newOrder.indexOf(draggedId);
    if (fromIdx === -1) return;
    newOrder.splice(fromIdx, 1);
    const toIdx = newOrder.indexOf(targetId);
    if (toIdx === -1) return;
    const insertAt = toIdx + (side === "right" ? 1 : 0);
    newOrder.splice(insertAt, 0, draggedId);
    setOrder(newOrder);
  };
  const handleHide = (id: ColumnId) => {
    if (colState.hidden.includes(id)) return;
    setHidden([...colState.hidden, id]);
  };
  const handleShow = (id: ColumnId) =>
    setHidden(colState.hidden.filter((h) => h !== id));

  // Type-to-jump quick search (GitExtensions-style): with the list focused,
  // typing jumps the selection to the next loaded row whose subject or ref
  // label matches; Alt+Down/Up steps through matches (also after the typing
  // buffer expired - `lastQuickQuery` persists), Esc dismisses. Purely
  // client-side over the loaded rows; the toolbar filter covers full history.
  // (State hooks live above the no-repo early return.)
  const showQuickOverlay = (text: string) => {
    setQuickOverlay(text);
    if (quickTimerRef.current) clearTimeout(quickTimerRef.current);
    quickTimerRef.current = setTimeout(() => {
      quickBufferRef.current = "";
      setQuickOverlay(null);
    }, 1200);
  };

  const quickJump = (anchor: number, direction: 1 | -1, query: string) => {
    const idx = quickSearchMatch(rowsRef.current, query, anchor, direction);
    if (idx === null) return;
    selectSingle(rowsRef.current[idx].id);
    if (shouldCenterScroll(idx, virtualizerRef.current.range)) {
      virtualizerRef.current.scrollToIndex(idx, { align: "center" });
    }
  };

  const handleQuickSearchKey = (e: React.KeyboardEvent) => {
    // Never intercept typing meant for an inline editor or the toolbar.
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable=true]")) return;
    const selectedIdx = rowsRef.current.findIndex((c) => c.id === selectedId);

    if (e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp") && lastQuickQueryRef.current) {
      e.preventDefault();
      const dir = e.key === "ArrowDown" ? 1 : -1;
      quickJump(selectedIdx + dir, dir, lastQuickQueryRef.current);
      showQuickOverlay(lastQuickQueryRef.current);
      return;
    }
    if (e.key === "Escape") {
      // Consumed only while the overlay is visibly up - dismissing it must
      // not also trigger other Escape actions (e.g. exiting a maximized
      // panel). Clearing the invisible leftover query is a free side effect
      // that shouldn't swallow anyone's Esc.
      if (quickOverlay !== null) e.stopPropagation();
      quickBufferRef.current = "";
      lastQuickQueryRef.current = "";
      if (quickTimerRef.current) clearTimeout(quickTimerRef.current);
      setQuickOverlay(null);
      return;
    }
    if (e.key === "Backspace" && quickBufferRef.current) {
      e.preventDefault();
      const next = quickBufferRef.current.slice(0, -1);
      quickBufferRef.current = next;
      lastQuickQueryRef.current = next;
      if (next) {
        quickJump(Math.max(selectedIdx, 0), 1, next);
        showQuickOverlay(next);
      } else {
        setQuickOverlay(null);
      }
      return;
    }
    if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    const next = quickBufferRef.current + e.key;
    quickBufferRef.current = next;
    lastQuickQueryRef.current = next;
    // Anchor inclusively on the current row so refining the query stays put.
    quickJump(Math.max(selectedIdx, 0), 1, next);
    showQuickOverlay(next);
  };

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

  const clearSearch = () => {
    setSearch(null);
    setSearchDraft("");
    setSearchHit(0);
  };

  return (
    <PanelContextMenuProvider baseline={baseline}>
      {({ openMenu, closeMenu }) => (
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
              gap: 6,
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
                    padding: "0 4px",
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
          padding: "3px 12px",
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
        style={{ flex: 1, overflow: "auto", position: "relative", paddingTop: 4, outline: "none" }}
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
                margin: "2px 12px 0 0",
                padding: "2px 8px",
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
            const rowIndex = vItem.index;
            const commit = rows[rowIndex];
            const isSelected = commit.id === selectedId || selectedIds.has(commit.id);
            const isWorkingDir = commit.id === WORKING_DIR_ID;
            const commitLane = assignments.get(commit.id) ?? 0;
            const edges = edgesByCommit.get(commit.id) ?? [];

            // Active lanes at this row: the commit's own lane plus every lane
            // that has a live edge spanning this row (strictly between its two
            // commit rows). Pass-through lines are drawn only for these lanes.
            // A span on the commit's *own* lane is suppressed as a pass-through
            // (to avoid double-drawing) but must still render the own-lane
            // vertical full height — flagged via `ownLanePassThrough`.
            const activeLanes = new Set<LaneIndex>([commitLane]);
            let ownLanePassThrough = false;
            for (const span of edgeSpans) {
              if (span.fromRow < rowIndex && rowIndex < span.toRow) {
                activeLanes.add(span.lane);
                if (span.lane === commitLane) ownLanePassThrough = true;
              }
            }
            return (
              <div
                key={vItem.key}
                data-index={vItem.index}
                ref={rowVirtualizer.measureElement}
                // Hover + selection backgrounds live in global.css (classes,
                // because :hover can't be expressed in inline styles).
                className={`legit-commit-row${isSelected ? " legit-commit-row--selected" : ""}`}
                onClick={(e) => handleRowClick(commit, e)}
                // Shift+click extends the selection - keep the browser from
                // also sweeping a text selection across the rows.
                onMouseDown={(e) => {
                  if (e.shiftKey) e.preventDefault();
                }}
                onContextMenu={(e) => {
                  // Right-click on a row inside a 2+ multi-selection: the
                  // bulk menu for the whole set. Any other row falls through
                  // to its normal single-row menu.
                  if (selectedIds.size >= 2 && selectedIds.has(commit.id) && isMultiSelectable(commit.id)) {
                    const plan = bulkActionPlan(
                      selectedIds,
                      rows.map((r) => ({ id: r.id, isMerge: (r.parents?.length ?? 0) > 1 })),
                    );
                    const comparePair = plan.compare;
                    if (plan.count >= 2) {
                      openMenu(
                        e,
                        <>
                          <SectionLabel>{plan.count} commits selected</SectionLabel>
                          {/* Sequencer ops hidden while one is in progress,
                              like the single-row menu. */}
                          {!opInProgress && (
                            <>
                              <MenuItem
                                disabled={plan.containsMerge}
                                onClick={() => { closeMenu(); handleCherryPick(plan.cherryPickShas); }}
                              >
                                Cherry-pick {plan.count} commits
                              </MenuItem>
                              <MenuItem
                                disabled={plan.containsMerge}
                                onClick={() => { closeMenu(); handleRevert(plan.revertShas); }}
                              >
                                Revert {plan.count} commits
                              </MenuItem>
                              {plan.containsMerge && (
                                <div
                                  style={{
                                    padding: "4px 14px 6px",
                                    fontSize: "var(--fz-sm)",
                                    color: "var(--subtle-fg)",
                                    maxWidth: 280,
                                    whiteSpace: "normal",
                                    cursor: "default",
                                  }}
                                >
                                  The selection contains a merge commit - cherry-pick
                                  or revert it on its own to choose a mainline parent.
                                </div>
                              )}
                            </>
                          )}
                          {comparePair && (
                            <MenuItem
                              onClick={() => {
                                closeMenu();
                                useSummonStore.getState().summon("compare", comparePair);
                              }}
                            >
                              Compare selected commits
                            </MenuItem>
                          )}
                        </>,
                      );
                      return;
                    }
                  }
                  if (commit.id === WORKING_DIR_ID) {
                    openMenu(
                      e,
                      <>
                        <SectionLabel>Uncommitted changes</SectionLabel>
                        <MenuItem onClick={() => { closeMenu(); handleCreateStash(false); }}>
                          Stash changes
                        </MenuItem>
                        <MenuItem onClick={() => { closeMenu(); handleCreateStash(true); }}>
                          Stash changes (incl. untracked)
                        </MenuItem>
                      </>,
                    );
                    return;
                  }
                  const stashSelector = stashSelectorById.get(commit.id);
                  // Author-specific entries only when the click landed in the
                  // Author cell (keeps the row menu uncluttered).
                  const inAuthorCell =
                    (e.target as HTMLElement).closest('[data-col="author"]') !== null;
                  // Branch sections for every branch decorating this row —
                  // the same shared sections the ref chips use, so the
                  // actions (and the delete Confirm step) stay in parity.
                  const rowBranches = branchesAt(commit.decorations ?? []);
                  const rowTags = (commit.decorations ?? [])
                    .filter((d) => d.type === "tag")
                    .map((d) => (d as { value: string }).value.replace(/^refs\/tags\//, ""));
                  const hasRefSections =
                    rowBranches.local.length > 0 || rowBranches.remote.length > 0 || rowTags.length > 0;
                  // Merge commits need a mainline parent for cherry-pick /
                  // revert (-m N); null = regular commit, run directly.
                  const mainline = mainlineChoices(commit, (id) =>
                    commitMessageById.get(id) ?? null,
                  );
                  const undoPlan = undoLastCommitPlan({
                    isHeadRow: commit.id === headSha,
                    hasParent: (commit.parents?.length ?? 0) > 0,
                    opInProgress,
                    hasUpstream: !!currentBranch?.upstream,
                    ahead: tracking?.ahead ?? null,
                  });
                  openMenu(
                    e,
                    stashSelector ? (
                      // Same shared section as the stash chip's menu — keeps
                      // the two in parity, including the Drop confirm step.
                      <StashMenuSection
                        selector={stashSelector}
                        onViewDiff={() => { closeMenu(); openStashDiff(commit.id); }}
                        onApply={() => { closeMenu(); handleStashApply(commit.id); }}
                        onPop={() => { closeMenu(); handleStashPop(commit.id); }}
                        onBranch={() => { closeMenu(); handleStashBranchStart(commit.id); }}
                        onRename={() => { closeMenu(); handleStashRename(commit.id); }}
                        onDrop={() => { closeMenu(); handleStashDrop(commit.id); }}
                      />
                    ) : (
                      <>
                        <SectionLabel>{commit.id.slice(0, 8)}</SectionLabel>
                        <MenuItem onClick={() => { closeMenu(); handleCommitCheckout(commit.id); }}>
                          Checkout commit
                        </MenuItem>
                        <MenuItem onClick={() => { closeMenu(); handleCreateBranchStart(commit.id); }}>
                          Create branch here…
                        </MenuItem>
                        <MenuItem onClick={() => { closeMenu(); handleCreateTagStart(commit.id); }}>
                          Create tag here…
                        </MenuItem>
                        <MenuItem
                          onClick={() => {
                            closeMenu();
                            useSummonStore.getState().summon("files", { rev: commit.id });
                          }}
                        >
                          Browse files at this commit
                        </MenuItem>
                        {inAuthorCell && (
                          <MenuItem
                            onClick={() => {
                              closeMenu();
                              setAuthorFilter({ name: commit.author.name, email: commit.author.email });
                              // A search's hits may not be by this author -
                              // cycling would only toast. Same as branch filter.
                              clearSearch();
                            }}
                          >
                            Show only commits by '{commit.author.name}'
                          </MenuItem>
                        )}
                        {commit.id === headSha && headIsRewordable && (
                          <MenuItem onClick={() => { closeMenu(); handleRewordStart(commit); }}>
                            Reword message…
                          </MenuItem>
                        )}
                        {undoPlan !== "hidden" && (
                          <UndoLastCommitMenuItem
                            pushed={undoPlan === "warn_pushed"}
                            onUndo={() => { closeMenu(); handleUndoLastCommit(commit.id); }}
                          />
                        )}
                        {/* Sequencer ops are hidden while a merge/rebase/
                            cherry-pick/revert is already in progress. */}
                        {!opInProgress && (
                          <>
                            <Separator />
                            {mainline ? (
                              // A merge's "change" is ambiguous - ask which
                              // parent to measure against instead of surfacing
                              // git's raw "-m required" error.
                              <>
                                <Submenu label="Cherry-pick commit">
                                  <SectionLabel>Apply changes relative to…</SectionLabel>
                                  {mainline.map((c) => (
                                    <MenuItem
                                      key={c.mainline}
                                      onClick={() => { closeMenu(); handleCherryPick([commit.id], c.mainline); }}
                                    >
                                      {c.label}
                                    </MenuItem>
                                  ))}
                                </Submenu>
                                <Submenu label="Revert commit">
                                  <SectionLabel>Undo changes relative to…</SectionLabel>
                                  {mainline.map((c) => (
                                    <MenuItem
                                      key={c.mainline}
                                      onClick={() => { closeMenu(); handleRevert([commit.id], c.mainline); }}
                                    >
                                      {c.label}
                                    </MenuItem>
                                  ))}
                                  {/* The classic merge-revert caveat: history
                                      still records the merge. */}
                                  <div
                                    style={{
                                      padding: "4px 14px 6px",
                                      fontSize: "var(--fz-sm)",
                                      color: "var(--subtle-fg)",
                                      maxWidth: 280,
                                      whiteSpace: "normal",
                                      cursor: "default",
                                    }}
                                  >
                                    History keeps the merge: re-merging the branch
                                    later restores nothing.
                                  </div>
                                </Submenu>
                              </>
                            ) : (
                              <>
                                <MenuItem onClick={() => { closeMenu(); handleCherryPick([commit.id]); }}>
                                  Cherry-pick commit
                                </MenuItem>
                                <MenuItem onClick={() => { closeMenu(); handleRevert([commit.id]); }}>
                                  Revert commit
                                </MenuItem>
                              </>
                            )}
                            <MenuItem
                              onClick={() => {
                                closeMenu();
                                useSummonStore.getState().summon("interactive-rebase", commit.id);
                              }}
                            >
                              Interactive rebase from here…
                            </MenuItem>
                            <MenuItem
                              onClick={() => {
                                closeMenu();
                                useSummonStore.getState().summon("compare", { from: commit.id, to: "HEAD" });
                              }}
                            >
                              Compare with HEAD
                            </MenuItem>
                            <ResetMenuItems
                              branch={currentBranchName}
                              onReset={(mode) => { closeMenu(); handleReset(commit.id, mode); }}
                            />
                          </>
                        )}
                        {/* One submenu entry per decorating ref: keeps the row
                            menu O(refs) long while the flyouts reuse the same
                            shared sections as the ref chips (action parity,
                            incl. the delete Confirm takeover). */}
                        {hasRefSections && <Separator />}
                        {rowBranches.local.map((b) => (
                          <Submenu
                            key={`local-${b.name}`}
                            label={<><BranchIcon /> {b.isCurrent ? `${b.name} (current)` : b.name}</>}
                          >
                            <BranchMenuSection
                              name={b.name}
                              isCurrent={b.isCurrent}
                              currentBranch={currentBranchName}
                              opInProgress={opInProgress}
                              upstream={branches.find((x) => !x.is_remote && x.name === b.name)?.upstream ?? null}
                              upstreamCandidates={upstreamCandidatesFor(b.name)}
                              remotes={remoteNames}
                              onCheckout={() => { closeMenu(); handleBranchCheckout(b.name); }}
                              onRename={() => { closeMenu(); handleBranchRename(b.name); }}
                              onPush={(remote, setUpstream) => { closeMenu(); handleBranchPush(b.name, remote, setUpstream); }}
                              onSetUpstream={(up) => { closeMenu(); handleSetUpstream(b.name, up); }}
                              onDelete={(force) => { closeMenu(); handleBranchDelete(b.name, force); }}
                              onMerge={(options) => { closeMenu(); handleMerge(b.name, options); }}
                              onRebaseOnto={() => { closeMenu(); handleRebaseOnto(b.name); }}
                            />
                          </Submenu>
                        ))}
                        {rowBranches.remote.map((name) => (
                          <Submenu key={`remote-${name}`} label={<><RemoteIcon /> {name}</>}>
                            <RemoteBranchMenuSection
                              remoteName={name}
                              currentBranch={currentBranchName}
                              opInProgress={opInProgress}
                              onCheckout={() => { closeMenu(); handleRemoteCheckout(name); }}
                              onMerge={(options) => { closeMenu(); handleMerge(name, options); }}
                              onRebaseOnto={() => { closeMenu(); handleRebaseOnto(name); }}
                              onDeleteRemote={() => { closeMenu(); void handleRemoteBranchDelete(name); }}
                            />
                          </Submenu>
                        ))}
                        {rowTags.map((name) => (
                          <Submenu key={`tag-${name}`} label={<><TagIcon /> {name}</>}>
                            <TagMenuSection
                              name={name}
                              pushed={pushedTags.has(name)}
                              targetOnRemote={tagTargetsOnRemote.has(name)}
                              remote={tagRemote}
                              remotes={remoteNames}
                              onPush={(remote) => { closeMenu(); handleTagPush(name, remote); }}
                              onDelete={() => { closeMenu(); handleTagDelete(name); }}
                              onDeleteRemote={(remote) => { closeMenu(); handleTagDeleteRemote(name, remote); }}
                            />
                          </Submenu>
                        ))}
                      </>
                    ),
                  );
                }}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${vItem.start}px)`,
                  paddingLeft: 12,
                  paddingRight: 12,
                  cursor: "pointer",
                  display: "grid",
                  gridTemplateColumns: GRID_COLUMNS,
                  gap: `0 ${COLUMN_GAP}px`,
                  alignItems: "center",
                  height: ROW_HEIGHT,
                }}
              >
                {visibleColumns.map((colId) => {
                  switch (colId) {
                    case "refs":
                      return (
                        <div key="refs" style={{ overflow: "hidden" }}>
                          <RefsCell
                            decorations={commit.decorations ?? []}
                            locks={rawLocks}
                            repoId={repo.id}
                            upstreamMap={upstreamMap}
                            textSize={TEXT_SIZE}
                            renamingBranch={renamingBranch}
                            onBranchRenameSave={handleBranchRenameSave}
                            onBranchRenameCancel={handleBranchRenameCancel}
                            creatingBranch={branchCreation?.rowId === commit.id}
                            onCreateBranchSave={handleCreateBranchSave}
                            onCreateBranchCancel={handleCreateBranchCancel}
                            creatingTag={tagCreation?.rowId === commit.id}
                            onCreateTagSave={handleCreateTagSave}
                            onCreateTagCancel={handleCreateTagCancel}
                            pushedTags={pushedTags}
                            tagTargetsOnRemote={tagTargetsOnRemote}
                            tagRemote={tagRemote}
                            remotes={remoteNames}
                            onTagPush={handleTagPush}
                            onTagDelete={handleTagDelete}
                            onTagDeleteRemote={handleTagDeleteRemote}
                            onBranchCheckout={handleBranchCheckout}
                            onBranchRename={handleBranchRename}
                            onBranchPush={handleBranchPush}
                            onBranchSetUpstream={handleSetUpstream}
                            upstreamCandidatesFor={upstreamCandidatesFor}
                            onBranchDelete={handleBranchDelete}
                            onRemoteCheckout={handleRemoteCheckout}
                            onRemoteBranchDelete={handleRemoteBranchDelete}
                            currentBranch={currentBranchName}
                            opInProgress={opInProgress}
                            onBranchMerge={handleMerge}
                            onBranchRebaseOnto={handleRebaseOnto}
                          />
                        </div>
                      );
                    case "graph":
                      return (
                        <div
                          key="graph"
                          style={{
                            overflow: "visible",
                            alignSelf: "stretch",
                            display: "flex",
                            alignItems: "stretch",
                          }}
                        >
                          <GraphCellWithAvatar
                            commitId={commit.id}
                            commitLane={commitLane}
                            totalLanes={maxVisibleLane + 1}
                            activeLanes={activeLanes}
                            edges={edges}
                            incomingEdges={incomingEdgesByCommit.get(commit.id) ?? []}
                            rowHeight={ROW_HEIGHT}
                            laneSpacing={LANE_SPACING}
                            dotRadius={DOT_RADIUS}
                            lineWidth={LINE_WIDTH}
                            ownLanePassThrough={ownLanePassThrough}
                            hollow={isWorkingDir}
                            isStash={stashSelectorById.has(commit.id)}
                            avatarEmail={
                              // Only regular commit dots carry an avatar — not
                              // the working-dir ring or stash squares.
                              AVATARS_ENABLED &&
                              !isWorkingDir &&
                              !stashSelectorById.has(commit.id) &&
                              commit.author.email
                                ? commit.author.email
                                : null
                            }
                          />
                        </div>
                      );
                    case "signed":
                      // Icon-only column: presence chip, upgraded to the
                      // verified verdict once the commit has been inspected
                      // in Commit Details (session signature cache).
                      return (
                        <div
                          key="signed"
                          style={{ overflow: "hidden", display: "flex", alignItems: "center" }}
                        >
                          {!isWorkingDir && (
                            <SignatureBadge
                              signature={verifiedSignatures?.[commit.id] ?? null}
                              hasSignature={signedSet.has(commit.id)}
                              size={TEXT_SIZE}
                            />
                          )}
                        </div>
                      );
                    case "subject": {
                      // The checked-out commit's subject renders bold — the
                      // row-level counterpart of the dot on the current
                      // branch's chip.
                      const isHeadRow = (commit.decorations ?? []).some(
                        (d) => d.type === "head" || d.type === "headOf",
                      );
                      // In-place edit: reword (subject line; a body is kept
                      // verbatim) or stash rename (the whole reflog subject).
                      if (subjectEdit?.id === commit.id) {
                        return (
                          <InlineRenameInput
                            key="subject"
                            initialValue={
                              subjectEdit.kind === "reword"
                                ? subjectOf(commit.message)
                                : commit.message
                            }
                            disabled={subjectBusy}
                            onSave={(value) => void handleSubjectEditSave(commit, value)}
                            onCancel={handleSubjectEditCancel}
                            title="Enter to save · Esc to cancel"
                            style={{
                              width: "100%",
                              fontSize: TEXT_SIZE,
                              padding: "0 4px",
                            }}
                          />
                        );
                      }
                      return (
                        <span
                          key="subject"
                          data-testid="commit-subject"
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 5,
                            fontSize: TEXT_SIZE,
                            fontStyle: isWorkingDir ? "italic" : undefined,
                            fontWeight: isHeadRow ? 700 : undefined,
                            overflow: "hidden",
                          }}
                        >
                          <span
                            style={{
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {subjectOf(commit.message)}
                          </span>
                        </span>
                      );
                    }
                    case "date":
                      return (
                        <span
                          key="date"
                          // Hover complements the cell: the exact author
                          // datetime (author's timezone) when the cell is
                          // relative, plus the relative form when the cell
                          // shows the absolute date.
                          title={
                            isWorkingDir
                              ? undefined
                              : DATE_ABSOLUTE
                                ? `${formatFull(commit.timestamp, commit.author.tz_offset_minutes)} (${formatRelative(commit.timestamp)})`
                                : formatFull(commit.timestamp, commit.author.tz_offset_minutes)
                          }
                          style={{
                            fontSize: TEXT_SIZE,
                            color: "var(--subtle-fg)",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {isWorkingDir
                            ? ""
                            : DATE_ABSOLUTE
                              ? formatAbsolute(commit.timestamp, commit.author.tz_offset_minutes, DATE_FORMAT, DATE_SHOW_TIME)
                              : formatRelative(commit.timestamp)}
                        </span>
                      );
                    case "author":
                      return (
                        <span
                          key="author"
                          // Marks the cell for the row menu's author-scoped
                          // entries (right-click here offers the author filter).
                          data-col="author"
                          style={{
                            fontSize: TEXT_SIZE,
                            color: "var(--subtle-fg)",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {isWorkingDir ? "" : commit.author.name}
                        </span>
                      );
                    case "sha":
                      return (
                        <span
                          key="sha"
                          style={{
                            fontSize: TEXT_SIZE,
                            color: "var(--subtle-fg)",
                            fontFamily: "monospace",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {isWorkingDir ? "" : commit.id.slice(0, 8)}
                        </span>
                      );
                    default:
                      return null;
                  }
                })}
              </div>
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
            gap: 8,
            padding: "8px 12px",
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
      )}
    </PanelContextMenuProvider>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function subjectOf(message: string): string {
  return message.split("\n")[0] ?? "";
}

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
        gap: 4,
        fontSize: "var(--fz-sm)",
        fontFamily: "monospace",
        border: "1px solid var(--panel-border)",
        borderRadius: 3,
        padding: "0 4px",
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

// ---------------------------------------------------------------------------
// Remote sync toolbar
// ---------------------------------------------------------------------------

type SyncOp = "fetch" | "pull" | "push";

/**
 * Fetch / Pull / Push controls plus an ahead/behind indicator for the current
 * branch. Auth is driven entirely by the repo's local git config (the active
 * git profile's SSH command + credential helper) — these calls add nothing
 * auth-specific; failures are classified by the backend and surfaced as toasts.
 *
 * Long-running ops are cancellable: the frontend mints the `op_id`, passes it
 * into the sync command, and cancels via `consoleCancel` (the same shared
 * GitRunner). A user-cancelled op suppresses its error toast.
 */
const PULL_STRATEGY_LABELS: Record<PullStrategy, string> = {
  Default: "Repo default",
  Rebase: "Rebase",
  Merge: "Merge",
  FfOnly: "Fast-forward only",
};

/** Stash-button modes: whether `git stash push` includes untracked files.
 *  Ordered for the caret menu; keys mirror `stash_include_untracked`. */
const STASH_MODES: { includeUntracked: boolean; label: string }[] = [
  { includeUntracked: false, label: "Tracked changes only" },
  { includeUntracked: true, label: "Include untracked files" },
];

function RemoteSyncToolbar({
  repoId,
  branches,
  onCreateBranch,
  onStash,
  hasUncommittedChanges,
  trailing,
}: {
  repoId: string;
  branches: Branch[];
  /** Opens the create-new-branch input on the HEAD row (see CommitsPanel). */
  onCreateBranch: () => void;
  /** Stashes the working tree (same action as the uncommitted-changes row's menu). */
  onStash: (includeUntracked: boolean) => void;
  /** Whether the working tree has anything to stash (drives the disabled state). */
  hasUncommittedChanges: boolean;
  /** Extra controls rendered right of the git buttons (the search/filter bar). */
  trailing?: React.ReactNode;
}) {
  const queryClient = useQueryClient();

  const { data: tracking } = useQuery<TrackingStatus | null>({
    queryKey: [repoId, "tracking"],
    queryFn: () => repoTrackingStatus(repoId),
    enabled: !!repoId,
    staleTime: 5_000,
  });

  // Configured remotes (not just fetched ones) — so Publish works the moment a
  // remote is added, before any fetch creates remote-tracking branches.
  const { data: remotes = [] } = useQuery<Remote[]>({
    queryKey: [repoId, "remotes"],
    queryFn: () => repoListRemotes(repoId),
    enabled: !!repoId,
    staleTime: 5_000,
  });

  const [busyOp, setBusyOp] = useState<SyncOp | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pullMenuOpen, setPullMenuOpen] = useState(false);
  const [stashMenuOpen, setStashMenuOpen] = useState(false);
  const opIdRef = useRef<string | null>(null);
  const cancelRequestedRef = useRef(false);

  // Persisted pull integration strategy ("Default" = the repo's pull.rebase
  // config decides). Picking one in the caret menu changes the default for
  // every future pull, not just the next one.
  const pullStrategy = useSettingsStore((s) => s.settings?.pull_strategy ?? "Default");
  const pushRecurseSubmodules = useSettingsStore(
    (st) => st.settings?.push_recurse_submodules ?? null,
  );
  const setPullStrategy = useSettingsStore((s) => s.setPullStrategy);

  // Persisted default for the Stash button (pull-strategy style): whether
  // stashing includes untracked files. Picking a mode in the caret menu
  // changes the default for every future stash, not just the next one.
  const stashIncludeUntracked = useSettingsStore(
    (s) => s.settings?.stash_include_untracked ?? false,
  );
  const setStashIncludeUntracked = useSettingsStore((s) => s.setStashIncludeUntracked);

  // Latest --progress update for the in-flight op (cleared when it settles).
  const progress = useRemoteProgressStore((s) =>
    opIdRef.current ? s.byOp[opIdRef.current] : undefined,
  );

  // The checked-out local branch (none when detached / unborn).
  const currentBranch = useMemo(
    () => branches.find((b) => b.is_current && !b.is_remote) ?? null,
    [branches],
  );
  const hasUpstream = !!currentBranch?.upstream;

  // The remote to push/publish to: the upstream's remote when set, else a
  // configured remote (prefer "origin", else the first). Null only when the repo
  // has no remotes configured at all.
  const remoteName = useMemo((): string | null => {
    const up = currentBranch?.upstream; // e.g. "refs/remotes/origin/main"
    if (up) {
      const parts = up.split("/");
      if (parts[0] === "refs" && parts[1] === "remotes" && parts.length >= 4) return parts[2];
    }
    if (remotes.length === 0) return null;
    const names = remotes.map((r) => r.name);
    return names.includes("origin") ? "origin" : names[0];
  }, [remotes, currentBranch]);

  const runSync = useCallback(
    async (kind: SyncOp, fn: (opId: string) => Promise<unknown>, successMsg: string) => {
      const opId = crypto.randomUUID();
      opIdRef.current = opId;
      cancelRequestedRef.current = false;
      setBusyOp(kind);
      try {
        await fn(opId);
        notify.success(successMsg);
        // "tags" because push/pull/fetch move remote-tracking refs, which the
        // tag list's per-tag `target_on_remote` flag is computed against.
        invalidateRepoDomains(queryClient, repoId, ["log", "branches", "status", "tracking", "tags"]);
      } catch (e) {
        if (cancelRequestedRef.current) {
          // User cancelled — the failure is expected, no toast.
        } else {
          // Classified wording shared with the branch menus' push action.
          notify.error(remoteOpErrorMessage(e));
        }
      } finally {
        useRemoteProgressStore.getState().clear(opId);
        setBusyOp(null);
        opIdRef.current = null;
      }
    },
    [queryClient, repoId],
  );

  const cancelSync = useCallback(() => {
    if (opIdRef.current) {
      cancelRequestedRef.current = true;
      void consoleCancel(repoId, opIdRef.current);
    }
  }, [repoId]);

  const doFetch = () =>
    runSync("fetch", (opId) => repoFetch(repoId, { all: true, prune: true, remote: null }, opId), "Fetched");

  const doPull = () =>
    runSync(
      "pull",
      (opId) =>
        repoPull(repoId, { strategy: pullStrategy }, opId).then((r) => {
          // A pull can move submodule pointers exactly like a switch does.
          void autoUpdateSubmodules(queryClient, repoId);
          return r;
        }),
      "Pulled",
    );

  const doPush = (forceWithLease: boolean, remoteOverride?: string) => {
    setMenuOpen(false);
    const remote = remoteOverride ?? remoteName;
    if (!currentBranch || !remote) return;
    const opts: PushOptions = {
      remote,
      branch: currentBranch.name,
      set_upstream: !hasUpstream,
      force_with_lease: forceWithLease,
      recurse_submodules: pushRecurseSubmodules,
    };
    return runSync(
      "push",
      // Auto-push-tags follow-up rides inside the op (gated on the setting);
      // its failures toast separately and never fail the push.
      (opId) => pushWithTagFollowUp(queryClient, repoId, opts, opId),
      hasUpstream ? `Pushed to ${remote}` : "Published branch",
    );
  };

  const busy = busyOp !== null;
  const pushLabel = hasUpstream ? "Push" : "Publish";

  return (
    <div
      className="legit-panel__toolbar"
      // Wraps when the panel is narrow: the search controls (trailing) move
      // to their own line instead of crushing the git buttons. Vertical
      // padding stays the class default (6px): with the 2em controls that
      // lands exactly on the toolbar min-height, so the spacing around the
      // controls is identical whether or not the row wraps.
      style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6 }}
    >
      {/* While an op runs, ITS button becomes the Cancel button (spinner +
          "Cancel", still enabled) — the cancel affordance sits exactly where
          the user just clicked. The other buttons disable as before. */}
      <ToolbarButton
        title={busyOp === "fetch" ? "Cancel fetch" : "Fetch all remotes (prune)"}
        disabled={busyOp === "fetch" ? false : busy || !remoteName}
        loading={busyOp === "fetch"}
        icon={<FetchIcon />}
        label={busyOp === "fetch" ? "Cancel" : "Fetch"}
        onClick={busyOp === "fetch" ? cancelSync : doFetch}
      />
      {/* Pull with a caret menu picking the integration strategy. */}
      <div style={{ position: "relative", display: "flex" }}>
        <ToolbarButton
          title={
            busyOp === "pull"
              ? "Cancel pull"
              : hasUpstream
                ? `Pull from ${tracking?.upstream ?? "upstream"}` +
                  (pullStrategy !== "Default" ? ` (${PULL_STRATEGY_LABELS[pullStrategy]})` : "")
                : "No upstream for the current branch"
          }
          disabled={busyOp === "pull" ? false : busy || !hasUpstream}
          loading={busyOp === "pull"}
          icon={<PullIcon />}
          label={busyOp === "pull" ? "Cancel" : "Pull"}
          onClick={busyOp === "pull" ? cancelSync : doPull}
          rounded="left"
        />
        <Button
          variant="ghost"
          rounded="right"
          title="Pull strategy"
          disabled={busy || !hasUpstream}
          onClick={() => setPullMenuOpen((o) => !o)}
          style={{ padding: "2px 4px", marginLeft: -1 }}
        >
          <ChevronDownIcon />
        </Button>
        {pullMenuOpen && (
          <CaretDropdown onClose={() => setPullMenuOpen(false)}>
            {(Object.keys(PULL_STRATEGY_LABELS) as PullStrategy[]).map((s) => (
              <MenuItem
                key={s}
                onClick={() => {
                  void setPullStrategy(s);
                  setPullMenuOpen(false);
                }}
              >
                <span style={{ fontWeight: s === pullStrategy ? 600 : 400 }}>
                  {s === pullStrategy ? "✓ " : " "}
                  {PULL_STRATEGY_LABELS[s]}
                </span>
              </MenuItem>
            ))}
          </CaretDropdown>
        )}
      </div>

      {/* Push / Publish with a caret menu for force-push (with lease). */}
      <div style={{ position: "relative", display: "flex" }}>
        <ToolbarButton
          title={
            busyOp === "push"
              ? "Cancel push"
              : !currentBranch
              ? "Detached HEAD — no branch to push"
              : !remoteName
              ? "No remote configured"
              : hasUpstream
              ? `Push to ${remoteName}`
              : `Publish branch to ${remoteName} (sets upstream)`
          }
          disabled={busyOp === "push" ? false : busy || !currentBranch || !remoteName}
          loading={busyOp === "push"}
          icon={<PushIcon />}
          label={busyOp === "push" ? "Cancel" : pushLabel}
          onClick={busyOp === "push" ? cancelSync : () => doPush(false)}
          rounded="left"
        />
        <Button
          variant="ghost"
          rounded="right"
          title="More push options"
          disabled={busy || !currentBranch || !remoteName}
          onClick={() => setMenuOpen((o) => !o)}
          style={{ padding: "2px 4px", marginLeft: -1 }}
        >
          <ChevronDownIcon />
        </Button>
        {menuOpen && (
          <CaretDropdown onClose={() => setMenuOpen(false)}>
            <MenuItem onClick={() => doPush(true)}>Force-push (with lease)</MenuItem>
            {/* With several remotes, offer a one-off push to each other one
                (the button itself targets the upstream's / default remote). */}
            {remotes.length > 1 && (
              <>
                <Separator />
                {remotes
                  .filter((r) => r.name !== remoteName)
                  .map((r) => (
                    <MenuItem key={r.name} onClick={() => doPush(false, r.name)}>
                      Push to {r.name}
                    </MenuItem>
                  ))}
              </>
            )}
          </CaretDropdown>
        )}
      </div>

      {/* Create a new branch at HEAD — opens an inline name input on the
          HEAD row's ref chips (local op; independent of the sync busy state). */}
      <ToolbarButton
        title="Create a new branch at HEAD"
        disabled={false}
        loading={false}
        icon={<BranchPlusIcon />}
        label="Branch"
        // Explicitly argument-free: the DOM click event must not leak into
        // the handler's optional startPoint parameter.
        onClick={() => onCreateBranch()}
      />

      {/* Stash the working tree - same action as the uncommitted-changes
          row's context menu. The caret picks the persisted default mode
          (tracked only / incl. untracked), pull-strategy style: selecting a
          mode configures the button, it does not stash. Local op; independent
          of the sync busy state. */}
      <div style={{ position: "relative", display: "flex" }}>
        <ToolbarButton
          title={
            hasUncommittedChanges
              ? "Stash uncommitted changes" +
                (stashIncludeUntracked ? " (incl. untracked)" : "")
              : "No uncommitted changes to stash"
          }
          disabled={!hasUncommittedChanges}
          loading={false}
          icon={<StashIcon />}
          label="Stash"
          onClick={() => onStash(stashIncludeUntracked)}
          rounded="left"
        />
        <Button
          variant="ghost"
          rounded="right"
          title="Stash mode"
          disabled={!hasUncommittedChanges}
          onClick={() => setStashMenuOpen((o) => !o)}
          style={{ padding: "2px 4px", marginLeft: -1 }}
        >
          <ChevronDownIcon />
        </Button>
        {stashMenuOpen && (
          <CaretDropdown onClose={() => setStashMenuOpen(false)}>
            {STASH_MODES.map((mode) => (
              <MenuItem
                key={mode.label}
                onClick={() => {
                  void setStashIncludeUntracked(mode.includeUntracked);
                  setStashMenuOpen(false);
                }}
              >
                <span
                  style={{
                    fontWeight:
                      mode.includeUntracked === stashIncludeUntracked ? 600 : 400,
                  }}
                >
                  {mode.includeUntracked === stashIncludeUntracked ? "✓ " : " "}
                  {mode.label}
                </span>
              </MenuItem>
            ))}
          </CaretDropdown>
        )}
      </div>

      {/* Ahead/behind indicator for the current branch, right of the buttons. */}
      {tracking && (
        <span
          title={`${tracking.ahead} ahead, ${tracking.behind} behind ${tracking.upstream}`}
          style={{
            fontSize: "var(--fz-sm)",
            color: "var(--subtle-fg)",
            fontFamily: "monospace",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          {tracking.ahead === 0 && tracking.behind === 0 ? (
            <span>in sync</span>
          ) : (
            <>
              <span>↑{tracking.ahead}</span>
              <span>↓{tracking.behind}</span>
            </>
          )}
        </span>
      )}

      {/* Live transfer progress for the in-flight op (fed by the
          legit://remote-progress event; cleared when the op settles). */}
      {busy && progress && (
        <span
          title={`${progress.phase}${progress.percent != null ? ` ${progress.percent}%` : ""}`}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: "var(--fz-sm)",
            color: "var(--subtle-fg)",
            minWidth: 0,
          }}
        >
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {progress.phase}
            {progress.percent != null ? ` ${progress.percent}%` : "…"}
          </span>
          {progress.percent != null && (
            <span
              aria-hidden
              style={{
                width: "6em",
                height: "0.4em",
                borderRadius: 2,
                background: "var(--panel-border)",
                overflow: "hidden",
                display: "inline-block",
                flexShrink: 0,
              }}
            >
              <span
                style={{
                  display: "block",
                  height: "100%",
                  width: `${progress.percent}%`,
                  background: "var(--progress-bar-bg)",
                }}
              />
            </span>
          )}
        </span>
      )}

      {/* Search controls (owned by CommitsPanel): float right of the flexible
          gap after the buttons + indicators, capped in width. */}
      {trailing}
    </div>
  );
}

