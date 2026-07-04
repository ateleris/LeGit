import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useActiveRepo } from "../../store/repos";
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
import { usePanelFocusEffect } from "../PanelApiContext";
import { useSummonStore } from "../../store/summon";
import { PanelLoadingBar } from "../shared/PanelLoadingBar";
import { ToolbarButton, toolbarBtnStyle } from "../shared/ToolbarButton";
import { invalidateRepoDomains } from "../../lib/repoInvalidation";
import {
  consoleCancel,
  repoBranches,
  repoCheckoutCommit,
  repoCheckoutRemoteBranch,
  repoCreateBranch,
  repoDeleteBranch,
  repoFetch,
  repoListRemotes,
  repoLog,
  repoPull,
  repoPush,
  repoRenameBranch,
  repoRewordCommit,
  repoStatus,
  repoMerge,
  repoRebase,
  repoSwitchBranch,
  repoTrackingStatus,
  repoCreateStash,
  repoApplyStash,
  repoPopStash,
  repoDropStash,
  repoRenameStash,
  repoTags,
  repoCreateTag,
  repoDeleteTag,
  repoPushTag,
  repoDeleteRemoteTag,
  repoRemoteTags,
} from "../../lib/commands";
import { pushedTagNames, pickTagRemote } from "../../lib/tags";
import { openStashDiff } from "../Stashes/StashesPanel";
import { notifySwitchOutcome, notifySwitchError } from "../../lib/switchFeedback";
import { notifyMergeOutcome, notifyOpError, notifyRebaseOutcome } from "../../lib/mergeFeedback";
import { OP_DOMAINS, useOpState } from "../../lib/useOpState";
import type { Branch, Commit, CommitId, FileStatus, MergeOptions, PushOptions, Remote, RemoteTag, Signature, TagInfo, TrackingStatus } from "../../lib/types";
import { formatAppError, gitErrorKind } from "../../lib/types";
import { notify } from "../../store/notifications";
import { BranchPlusIcon, FetchIcon, PullIcon, PushIcon, ChevronDownIcon } from "../../icons";
import { formatFull, formatRelative } from "../../lib/time";
import { RefsCell } from "./cells/RefsCell";
import { InlineRenameInput } from "./cells/InlineRenameInput";
import { SignatureBadge } from "./cells/SignatureBadge";
import { GraphCellWithAvatar, laneColor } from "./cells/GraphCell";
import { computeLanes } from "./graph/lanes";
import { computeEdgeSpans } from "./graph/spans";
import { pickHeadCommitId } from "./headId";
import type { LaneEdge, LaneIndex, LaneResult, LockMap, RefsAtCommit } from "./graph/types";
import { useColumnState } from "./columns/useColumnState";
import { ColumnHeader } from "./columns/ColumnHeader";
import { LaneLockIndicator } from "./LaneLockIndicator";
import { PanelContextMenuProvider, type BaselineEntry } from "./menu/PanelContextMenu";
import { MenuItem, SectionLabel, Separator } from "./menu/primitives";
import { StashMenuSection } from "./menu/StashMenuSection";
import { BranchMenuSection, RemoteBranchMenuSection } from "./menu/BranchMenuSection";
import { TagMenuSection } from "./menu/TagMenuSection";
import { branchesAt } from "./cells/refChips";
import {
  COLUMN_GAP,
  DEFAULT_WIDTHS,
  NON_HIDEABLE,
  NON_RESIZABLE,
} from "./columns/types";
import type { ColumnId } from "./columns/types";

const COLUMN_LABELS: Record<ColumnId, string> = {
  refs: "Refs",
  graph: "Graph",
  subject: "Subject",
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

  // Render-time floors (the settings clamps only run on save): rows must
  // always clear a ref chip by 2px so chips on adjacent rows never touch —
  // even when the font size was raised *after* the values were saved. Lane
  // width shares the same font-derived floor (but not the row height itself;
  // the two are independent above it).
  const metricsFloor = minCommitsRowHeight(TEXT_SIZE);
  const ROW_HEIGHT = Math.max(storedRowHeight, metricsFloor);
  const LANE_SPACING = Math.max(storedLaneWidth, metricsFloor);

  const [selectedId, setSelectedId] = useState<CommitId | null>(null);
  const [extraPages, setExtraPages] = useState(0);
  const parentRef = useRef<HTMLDivElement>(null);

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
  // commit's SHA is the explicit start point.
  const [branchCreation, setBranchCreation] = useState<
    { rowId: CommitId; startPoint?: string } | null
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
  }, [repo?.id]);

  // Raw lock list from the store; used by the Refs context menu UI.
  const rawLocks = useLaneLocks(repo?.id ?? "");

  // Build a conflict-free LockMap for the lane algorithm. §H.5 says the
  // backend storage is permissive; if two locks claim the same lane (e.g.
  // from a hand-edited settings.json), the first one wins.
  const lockMap = useMemo((): LockMap => {
    const map: LockMap = {};
    const claimedLanes = new Set<number>();
    for (const lock of rawLocks) {
      if (claimedLanes.has(lock.laneIndex)) {
        console.warn(
          `[LeGit] Lane lock conflict: lane ${lock.laneIndex} claimed by "${lock.refName}" ` +
          `but already held by "${Object.entries(map).find(([, v]) => v === lock.laneIndex)?.[0]}". ` +
          `Ignoring this lock. Edit repo settings to resolve.`
        );
        continue;
      }
      map[lock.refName] = lock.laneIndex;
      claimedLanes.add(lock.laneIndex);
    }
    return map;
  }, [rawLocks]);

  const queryKey = [repo?.id, "log", totalToFetch];

  const { data: commits = [], isFetching, isError, error } = useQuery<Commit[]>({
    queryKey,
    queryFn: () => repoLog(repo!.id, totalToFetch, 0),
    enabled: !!repo,
    staleTime: 5_000,
    // Keep the current (smaller) page rendered while the larger page fetches.
    // Without this, the new totalToFetch query key has no cached data, the list
    // collapses to zero height, and the scroll position jumps back to the top.
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
  const upstreamMap = useMemo((): Map<string, string> => {
    const map = new Map<string, string>();
    for (const b of branches) {
      if (!b.is_remote && b.upstream) {
        map.set(`refs/heads/${b.name}`, b.upstream);
      }
    }
    return map;
  }, [branches]);

  // Switching can create/consume an auto-stash, so "stashes" is invalidated too.
  const BRANCH_DOMAINS = ["branches", "log", "status", "tracking", "stashes"] as const;

  // Merge/rebase entry points need the current branch NAME for labels and are
  // hidden while an operation is already in progress. (Distinct from the
  // `currentBranch` Branch object below, which drives reword gating.)
  const currentBranchName = useMemo(
    () => branches.find((b) => !b.is_remote && b.is_current)?.name ?? null,
    [branches],
  );
  const opState = useOpState(repo?.id);
  const opInProgress = !!opState && opState.kind !== "none";

  const handleMerge = useCallback(async (target: string, options: MergeOptions) => {
    if (!repo) return;
    try {
      const outcome = await repoMerge(repo.id, target, options);
      invalidateRepoDomains(queryClient, repo.id, OP_DOMAINS);
      notifyMergeOutcome(outcome, target);
    } catch (e) {
      // A failed merge can still leave state behind; refresh either way.
      invalidateRepoDomains(queryClient, repo.id, OP_DOMAINS);
      notifyOpError(e);
    }
  }, [repo, queryClient]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRebaseOnto = useCallback(async (onto: string) => {
    if (!repo) return;
    try {
      const outcome = await repoRebase(repo.id, onto);
      invalidateRepoDomains(queryClient, repo.id, OP_DOMAINS);
      notifyRebaseOutcome(outcome, onto);
    } catch (e) {
      invalidateRepoDomains(queryClient, repo.id, OP_DOMAINS);
      notifyOpError(e);
    }
  }, [repo, queryClient]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleBranchCheckout = useCallback(async (name: string) => {
    if (!repo) return;
    try {
      const outcome = await repoSwitchBranch(repo.id, name);
      invalidateRepoDomains(queryClient, repo.id, BRANCH_DOMAINS);
      notifySwitchOutcome(outcome, name);
    } catch (e) {
      notifySwitchError(e);
    }
  }, [repo, queryClient]); // eslint-disable-line react-hooks/exhaustive-deps

  // Branch rename happens in place, inside the branch's ref chip.
  const handleBranchRename = useCallback((name: string) => {
    setRenamingBranch(name);
  }, []);

  const handleBranchRenameSave = useCallback(async (oldName: string, newName: string) => {
    setRenamingBranch(null);
    if (!repo) return;
    try {
      await repoRenameBranch(repo.id, oldName, newName);
      invalidateRepoDomains(queryClient, repo.id, BRANCH_DOMAINS);
    } catch (e) {
      notify.error(formatAppError(e));
    }
  }, [repo, queryClient]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleBranchRenameCancel = useCallback(() => {
    setRenamingBranch(null);
  }, []);

  const handleBranchDelete = useCallback(async (name: string, force: boolean) => {
    if (!repo) return;
    try {
      await repoDeleteBranch(repo.id, name, force);
      invalidateRepoDomains(queryClient, repo.id, BRANCH_DOMAINS);
    } catch (e) {
      notify.error(formatAppError(e));
    }
  }, [repo, queryClient]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRemoteCheckout = useCallback(async (remoteRef: string) => {
    if (!repo) return;
    try {
      const outcome = await repoCheckoutRemoteBranch(repo.id, remoteRef);
      invalidateRepoDomains(queryClient, repo.id, BRANCH_DOMAINS);
      notifySwitchOutcome(outcome, remoteRef);
    } catch (e) {
      notifySwitchError(e);
    }
  }, [repo, queryClient]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCommitCheckout = useCallback(async (sha: string) => {
    if (!repo) return;
    try {
      const outcome = await repoCheckoutCommit(repo.id, sha);
      invalidateRepoDomains(queryClient, repo.id, BRANCH_DOMAINS);
      notifySwitchOutcome(outcome, sha.slice(0, 8));
    } catch (e) {
      notifySwitchError(e);
    }
  }, [repo, queryClient]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const handleSubjectEditSave = useCallback(async (commit: Commit, value: string) => {
    if (!repo || !subjectEdit) return;
    setSubjectBusy(true);
    try {
      if (subjectEdit.kind === "reword") {
        const lines = commit.message.split("\n");
        const body = lines.slice(1).join("\n");
        const newMessage = body.length > 0 ? `${value}\n${body}` : value;
        await repoRewordCommit(repo.id, commit.id, newMessage);
        invalidateRepoDomains(queryClient, repo.id, ["log", "branches", "tracking"]);
      } else {
        await repoRenameStash(repo.id, commit.id, value);
        invalidateRepoDomains(queryClient, repo.id, STASH_DOMAINS);
      }
      setSubjectEdit(null);
    } catch (e) {
      notify.error(formatAppError(e));
    } finally {
      setSubjectBusy(false);
    }
  }, [repo, subjectEdit, queryClient]); // eslint-disable-line react-hooks/exhaustive-deps

  // Tags: the local list (drives the row menus), the configured remotes (to
  // pick the tag-push target), and the remote's tags (drives the "pushed"
  // indicator). ls-remote is a network call — long staleTime, no retry.
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
  const tagRemote = useMemo(() => pickTagRemote(remotesList), [remotesList]);
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

  const TAG_DOMAINS = ["tags", "log"] as const;

  const handleTagPush = useCallback(async (name: string) => {
    if (!repo || !tagRemote) return;
    try {
      await repoPushTag(repo.id, tagRemote, name, crypto.randomUUID());
      notify.success(`Pushed tag '${name}' to ${tagRemote}`);
      invalidateRepoDomains(queryClient, repo.id, ["remote-tags"]);
    } catch (e) {
      notify.error(formatAppError(e));
    }
  }, [repo, tagRemote, queryClient]);

  const handleTagDelete = useCallback(async (name: string) => {
    if (!repo) return;
    try {
      await repoDeleteTag(repo.id, name);
      invalidateRepoDomains(queryClient, repo.id, TAG_DOMAINS);
    } catch (e) {
      notify.error(formatAppError(e));
    }
  }, [repo, queryClient]); // eslint-disable-line react-hooks/exhaustive-deps

  // Deletes the tag ON THE REMOTE only — local/remote deletion are separate,
  // deliberate actions (GitKraken-style).
  const handleTagDeleteRemote = useCallback(async (name: string) => {
    if (!repo || !tagRemote) return;
    try {
      await repoDeleteRemoteTag(repo.id, tagRemote, name, crypto.randomUUID());
      notify.success(`Deleted tag '${name}' from ${tagRemote}`);
      invalidateRepoDomains(queryClient, repo.id, ["remote-tags"]);
    } catch (e) {
      notify.error(formatAppError(e));
    }
  }, [repo, tagRemote, queryClient]);

  // Create-new-tag flow: the input shows on the clicked row; the (lightweight)
  // tag is only created when a name is confirmed.
  const handleCreateTagStart = useCallback((commitId: CommitId) => {
    setTagCreation({ rowId: commitId });
  }, []);

  const handleCreateTagSave = useCallback(async (name: string) => {
    const creation = tagCreation;
    setTagCreation(null);
    if (!repo || !creation) return;
    try {
      await repoCreateTag(repo.id, name, creation.rowId, undefined);
      invalidateRepoDomains(queryClient, repo.id, TAG_DOMAINS);
    } catch (e) {
      notify.error(formatAppError(e));
    }
  }, [repo, tagCreation, queryClient]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCreateTagCancel = useCallback(() => {
    setTagCreation(null);
  }, []);

  // Stash actions address the stash by its commit SHA (the injected node's id).
  // The SHA is stable; the backend resolves it to the current `stash@{N}` at
  // action time, so a stale list can never hit the wrong stash. Toasts use
  // generic wording — the rendered selector may already be outdated.
  const STASH_DOMAINS = ["stashes", "log", "status"] as const;

  const handleStashApply = useCallback(async (sha: string) => {
    if (!repo) return;
    try {
      const outcome = await repoApplyStash(repo.id, sha);
      invalidateRepoDomains(queryClient, repo.id, STASH_DOMAINS);
      if (outcome.kind === "conflicts") {
        notify.info("Applying the stash produced conflicts — resolve them in your working tree.");
      }
    } catch (e) {
      notify.error(formatAppError(e));
    }
  }, [repo, queryClient]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleStashPop = useCallback(async (sha: string) => {
    if (!repo) return;
    try {
      const outcome = await repoPopStash(repo.id, sha);
      invalidateRepoDomains(queryClient, repo.id, STASH_DOMAINS);
      if (outcome.kind === "conflicts") {
        notify.info("Popping the stash produced conflicts — the stash was kept; resolve them in your working tree.");
      }
    } catch (e) {
      notify.error(formatAppError(e));
    }
  }, [repo, queryClient]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleStashDrop = useCallback(async (sha: string) => {
    if (!repo) return;
    try {
      await repoDropStash(repo.id, sha);
      invalidateRepoDomains(queryClient, repo.id, STASH_DOMAINS);
    } catch (e) {
      notify.error(formatAppError(e));
    }
  }, [repo, queryClient]); // eslint-disable-line react-hooks/exhaustive-deps

  // Stash rename happens in place: the stash row's subject (which shows the
  // stash message) becomes an input.
  const handleStashRename = useCallback((sha: string) => {
    setSubjectEdit({ kind: "stashRename", id: sha });
    setSubjectBusy(false);
  }, []);

  const handleCreateStash = useCallback(async (includeUntracked: boolean) => {
    if (!repo) return;
    try {
      const outcome = await repoCreateStash(repo.id, undefined, includeUntracked);
      invalidateRepoDomains(queryClient, repo.id, STASH_DOMAINS);
      if (outcome.kind === "nothing_to_stash") {
        notify.info("Nothing to stash — the working tree is clean.");
      }
    } catch (e) {
      notify.error(formatAppError(e));
    }
  }, [repo, queryClient]); // eslint-disable-line react-hooks/exhaustive-deps

  const refetch = useCallback(() => {
    if (repo) {
      invalidateRepoDomains(queryClient, repo.id, ["log", "branches", "status", "tracking", "stashes", "tags"]);
    }
  }, [repo, queryClient]);

  usePanelFocusEffect(refetch);

  // Baseline context-menu entries — present on every right-click in the panel,
  // regardless of what was clicked.
  const baseline = useMemo<BaselineEntry[]>(
    () => [{ label: "Refresh", onClick: refetch, disabled: isFetching }],
    [refetch, isFetching],
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
      decorations: [],
    };
  }, [status.length, headId]);

  // Rows actually rendered: the synthetic row (when present) pinned at the top,
  // above all real commits. The graph edge connecting it to HEAD may span many
  // rows when HEAD is not the newest commit (e.g. detached HEAD, behind a
  // branch). Lane layout is computed on `commits` for stability, then augmented
  // with the synthetic node — so paging/recompute never see it.
  const rows = useMemo(
    () => (workingDirRow ? [workingDirRow, ...commits] : commits),
    [workingDirRow, commits],
  );

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

  // Create-new-branch flow: scroll the target row into view and show the
  // empty branch-name input there; the branch is only created when a name is
  // confirmed (Esc leaves no trace). No `startPoint` = branch at HEAD proper
  // (the toolbar button); a commit SHA = branch from that commit (row menu).
  const handleCreateBranchStart = useCallback((startPoint?: string) => {
    const rowId = startPoint ?? headId;
    if (rowId === null) return; // empty repo — nothing to branch from
    setBranchCreation({ rowId, startPoint });
    const idx = rows.findIndex((c) => c.id === rowId);
    if (idx >= 0) rowVirtualizer.scrollToIndex(idx);
  }, [headId, rows, rowVirtualizer]);

  const handleCreateBranchSave = useCallback(async (name: string) => {
    const creation = branchCreation;
    setBranchCreation(null);
    if (!repo || !creation) return;
    try {
      await repoCreateBranch(repo.id, name, creation.startPoint);
      invalidateRepoDomains(queryClient, repo.id, BRANCH_DOMAINS);
    } catch (e) {
      notify.error(formatAppError(e));
    }
  }, [repo, branchCreation, queryClient]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCreateBranchCancel = useCallback(() => {
    setBranchCreation(null);
  }, []);

  // Build the refsAt map (commitId -> [refName,...]) from log decorations.
  // Branch and tag refs feed the lane algorithm (via §H locks in Phase 6).
  const refsAt = useMemo((): RefsAtCommit => {
    const map = new Map<string, string[]>();
    for (const commit of commits) {
      const refs: string[] = [];
      for (const dec of commit.decorations ?? []) {
        // `headOf` carries the checked-out branch's ref — git folds it into
        // `HEAD -> refs/heads/x` and emits no separate `branch` decoration, so
        // include it here or a lock on the current branch reserves an empty lane.
        if (dec.type === "branch" || dec.type === "headOf") refs.push(dec.value);
        else if (dec.type === "tag") refs.push(dec.value);
      }
      if (refs.length > 0) map.set(commit.id, refs);
    }
    return map;
  }, [commits]);

  // Stash nodes (synthetic commits the backend injects into the log). Maps the
  // stash's commit id → its reflog selector (e.g. "stash@{0}"), driving the
  // distinct diamond dot and the stash context-menu actions.
  const stashSelectorById = useMemo((): Map<string, string> => {
    const map = new Map<string, string>();
    for (const commit of commits) {
      for (const dec of commit.decorations ?? []) {
        if (dec.type === "stash") map.set(commit.id, dec.value);
      }
    }
    return map;
  }, [commits]);

  // Stability refs for load-more. previousAssignments are reused ONLY when the
  // new rows are a pure bottom-append of the previous ones (pagination): i.e.
  // the previous row ids are still an exact prefix. Any other change — a stash
  // created/dropped, the working-dir row appearing/disappearing, a branch op —
  // fails the prefix test and triggers a full recompute. (A length-only check
  // would misread a synthetic-node insertion as load-more and corrupt the
  // walk: firstNewIndex would jump to the inserted node, skipping the commits
  // after it and dropping their edges.)
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
  // exactly as any childless commit would.
  const { assignments, edges: allEdges } = useMemo((): LaneResult => {
    const forGraph = rows.map((c) => ({ id: c.id, parentIds: c.parents }));
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
  }, [rows, lockMap, refsAt]);

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

  const handleRowClick = useCallback(
    (commit: Commit) => {
      setSelectedId(commit.id);
      const summon = useSummonStore.getState();
      if (commit.id === WORKING_DIR_ID) {
        // Working-dir row → show the staging/commit panel in the shared side
        // slot (swapping out Changed Files). No commit-details for the index.
        summon.swapSummon("working-changes", "changed-files");
        return;
      }
      summon.summon("commit-details", commit.id);
      // Show Changed Files in the shared slot (swapping out Working Changes).
      summon.swapSummon("changed-files", "working-changes", commit.id);
    },
    []
  );

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
  // always the elastic "1fr" filler. All others use the persisted px width
  // (or DEFAULT_WIDTHS if not yet set).
  const graphColWidth = (maxVisibleLane + 2) * LANE_SPACING;
  const visibleColumns = colState.order.filter(
    (id) => !colState.hidden.includes(id)
  );

  function colWidth(id: ColumnId): string {
    if (id === "graph") return `${graphColWidth}px`;
    if (id === "subject") return "1fr";
    const w = colState.widths[id] ?? DEFAULT_WIDTHS[id] ?? 100;
    return `${w}px`;
  }

  const GRID_COLUMNS = visibleColumns.map(colWidth).join(" ");

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
      <PanelLoadingBar active={isFetching} />

      {/* Remote sync toolbar — fetch / pull / push + ahead-behind for the
          current branch. Self-contained; reuses the already-fetched branches. */}
      <RemoteSyncToolbar
        repoId={repo.id}
        branches={branches}
        onCreateBranch={handleCreateBranchStart}
      />


      {isError && (
        <pre className="legit-error" style={{ margin: "8px 12px", fontSize: "var(--fz-md)" }}>
          {formatAppError(error)}
        </pre>
      )}

      {/* Column headers — sticky above the virtualised list */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: GRID_COLUMNS,
          gap: `0 ${COLUMN_GAP}px`,
          padding: "3px 12px",
          borderBottom: "1px solid var(--panel-border, rgba(255,255,255,0.10))",
          background: "var(--panel-bg, transparent)",
          position: "sticky",
          top: 0,
          zIndex: 1,
          minHeight: 22,
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
                order={colState.order}
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
              label={COLUMN_LABELS[colId]}
              width={colWidth(colId)}
              isDraggable={true}
              isResizable={!NON_RESIZABLE.includes(colId)}
              isHideable={!NON_HIDEABLE.includes(colId)}
              order={colState.order}
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

      {/* Virtualised rows. A little top padding keeps the first row clear of
          the header so a tall chip on the top commit isn't clipped against it;
          it scrolls away with the content. */}
      <div
        ref={parentRef}
        style={{ flex: 1, overflow: "auto", position: "relative", paddingTop: 4 }}
      >
        <div
          style={{
            height: rowVirtualizer.getTotalSize(),
            width: "100%",
            position: "relative",
          }}
        >
          {visibleItems.map((vItem) => {
            const rowIndex = vItem.index;
            const commit = rows[rowIndex];
            const isSelected = commit.id === selectedId;
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
                onClick={() => handleRowClick(commit)}
                onContextMenu={(e) => {
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
                  // Branch sections for every branch decorating this row —
                  // the same shared sections the ref chips use, so the
                  // actions (and the delete Confirm step) stay in parity.
                  const rowBranches = branchesAt(commit.decorations ?? []);
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
                        {commit.id === headSha && headIsRewordable && (
                          <MenuItem onClick={() => { closeMenu(); handleRewordStart(commit); }}>
                            Reword message…
                          </MenuItem>
                        )}
                        {rowBranches.local.map((b) => (
                          <Fragment key={`local-${b.name}`}>
                            <Separator />
                            <BranchMenuSection
                              name={b.name}
                              isCurrent={b.isCurrent}
                              currentBranch={currentBranchName}
                              opInProgress={opInProgress}
                              onCheckout={() => { closeMenu(); handleBranchCheckout(b.name); }}
                              onRename={() => { closeMenu(); handleBranchRename(b.name); }}
                              onDelete={(force) => { closeMenu(); handleBranchDelete(b.name, force); }}
                              onMerge={(options) => { closeMenu(); handleMerge(b.name, options); }}
                              onRebaseOnto={() => { closeMenu(); handleRebaseOnto(b.name); }}
                            />
                          </Fragment>
                        ))}
                        {rowBranches.remote.map((name) => (
                          <Fragment key={`remote-${name}`}>
                            <Separator />
                            <RemoteBranchMenuSection
                              remoteName={name}
                              currentBranch={currentBranchName}
                              opInProgress={opInProgress}
                              onCheckout={() => { closeMenu(); handleRemoteCheckout(name); }}
                              onMerge={(options) => { closeMenu(); handleMerge(name, options); }}
                              onRebaseOnto={() => { closeMenu(); handleRebaseOnto(name); }}
                            />
                          </Fragment>
                        ))}
                        {(commit.decorations ?? [])
                          .filter((d) => d.type === "tag")
                          .map((d) => (d as { value: string }).value.replace(/^refs\/tags\//, ""))
                          .map((name) => (
                            <Fragment key={`tag-${name}`}>
                              <Separator />
                              <TagMenuSection
                                name={name}
                                pushed={pushedTags.has(name)}
                                targetOnRemote={tagTargetsOnRemote.has(name)}
                                remote={tagRemote}
                                onPush={() => { closeMenu(); handleTagPush(name); }}
                                onDelete={() => { closeMenu(); handleTagDelete(name); }}
                                onDeleteRemote={() => { closeMenu(); handleTagDeleteRemote(name); }}
                              />
                            </Fragment>
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
                            onTagPush={handleTagPush}
                            onTagDelete={handleTagDelete}
                            onTagDeleteRemote={handleTagDeleteRemote}
                            onBranchCheckout={handleBranchCheckout}
                            onBranchRename={handleBranchRename}
                            onBranchDelete={handleBranchDelete}
                            onRemoteCheckout={handleRemoteCheckout}
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
                          {!isWorkingDir && (
                            <SignatureBadge signature={commit.signature} size={TEXT_SIZE} />
                          )}
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
                          // Exact author datetime (author's timezone) on hover;
                          // the cell itself keeps the compact relative form.
                          title={
                            isWorkingDir
                              ? undefined
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
                          {isWorkingDir ? "" : formatRelative(commit.timestamp)}
                        </span>
                      );
                    case "author":
                      return (
                        <span
                          key="author"
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
          spinner indicates that fetch is in flight. */}
      {hasMore && isFetching && (
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
function RemoteSyncToolbar({
  repoId,
  branches,
  onCreateBranch,
}: {
  repoId: string;
  branches: Branch[];
  /** Opens the create-new-branch input on the HEAD row (see CommitsPanel). */
  onCreateBranch: () => void;
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
  const opIdRef = useRef<string | null>(null);
  const cancelRequestedRef = useRef(false);

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
        invalidateRepoDomains(queryClient, repoId, ["log", "branches", "status", "tracking"]);
      } catch (e) {
        if (cancelRequestedRef.current) {
          // User cancelled — the failure is expected, no toast.
        } else {
          const kindErr = gitErrorKind(e);
          if (kindErr === "AuthFailed") {
            notify.error(
              "Authentication failed. Check this repo's git profile credentials " +
                "(SSH key / credential helper) — a profile may need to be applied.",
            );
          } else if (kindErr === "PushRejected") {
            notify.error(
              "Push rejected — the remote has commits you don't have. Pull first, " +
                "or use Force-push (with lease).",
            );
          } else {
            notify.error(formatAppError(e));
          }
        }
      } finally {
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
    runSync("pull", (opId) => repoPull(repoId, { strategy: "Default" }, opId), "Pulled");

  const doPush = (forceWithLease: boolean) => {
    setMenuOpen(false);
    if (!currentBranch || !remoteName) return;
    const opts: PushOptions = {
      remote: remoteName,
      branch: currentBranch.name,
      set_upstream: !hasUpstream,
      force_with_lease: forceWithLease,
    };
    return runSync(
      "push",
      (opId) => repoPush(repoId, opts, opId),
      hasUpstream ? "Pushed" : "Published branch",
    );
  };

  const busy = busyOp !== null;
  const pushLabel = hasUpstream ? "Push" : "Publish";

  return (
    <div
      className="legit-panel__toolbar"
      style={{ display: "flex", alignItems: "center", gap: 6, padding: "3px 8px" }}
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
      <ToolbarButton
        title={
          busyOp === "pull"
            ? "Cancel pull"
            : hasUpstream
              ? `Pull from ${tracking?.upstream ?? "upstream"}`
              : "No upstream for the current branch"
        }
        disabled={busyOp === "pull" ? false : busy || !hasUpstream}
        loading={busyOp === "pull"}
        icon={<PullIcon />}
        label={busyOp === "pull" ? "Cancel" : "Pull"}
        onClick={busyOp === "pull" ? cancelSync : doPull}
      />

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
        <button
          type="button"
          title="More push options"
          disabled={busy || !currentBranch || !remoteName}
          onClick={() => setMenuOpen((o) => !o)}
          style={{ ...toolbarBtnStyle(busy || !currentBranch || !remoteName), padding: "2px 4px", borderRadius: "0 3px 3px 0", marginLeft: -1 }}
        >
          <ChevronDownIcon />
        </button>
        {menuOpen && (
          <>
            {/* Click-away overlay. */}
            <div
              style={{ position: "fixed", inset: 0, zIndex: 10 }}
              onClick={() => setMenuOpen(false)}
            />
            <div
              style={{
                position: "absolute",
                top: "100%",
                right: 0,
                marginTop: 2,
                zIndex: 11,
                background: "var(--panel-bg, #222)",
                border: "1px solid var(--panel-border)",
                borderRadius: 4,
                boxShadow: "0 2px 8px var(--shadow-color)",
                whiteSpace: "nowrap",
              }}
            >
              <button
                type="button"
                onClick={() => doPush(true)}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  background: "transparent",
                  border: "none",
                  color: "var(--panel-fg)",
                  cursor: "pointer",
                  fontSize: "var(--fz-sm)",
                  padding: "6px 10px",
                }}
              >
                Force-push (with lease)
              </button>
            </div>
          </>
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

      {/* Ahead/behind indicator for the current branch. */}
      {tracking && (
        <span
          title={`${tracking.ahead} ahead, ${tracking.behind} behind ${tracking.upstream}`}
          style={{
            marginLeft: "auto",
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
    </div>
  );
}

