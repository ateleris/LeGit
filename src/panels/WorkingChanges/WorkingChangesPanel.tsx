import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useActiveRepo, useRepoStore } from "../../store/repos";
import { useConfirmDestructive, useSettingsStore } from "../../store/settings";
import { usePanelActiveEffect, usePanelFocusEffect } from "../PanelApiContext";
import { repoCommit, repoConflictEntries, repoConflictReopen, repoCreateStashPaths, repoDiscard, repoLog, repoResolvedIdentity, repoResolveTakeSide, repoResolveUndoPaths, repoStage, repoStagedMarkerPaths, repoStatus, repoTrackingStatus, repoUnstage, repoUnstagedMarkerPaths } from "../../lib/commands";
import type { Commit, ConflictEntry, ConflictSide, DiffRequest, DiffSource, FileStatus, ResolvedIdentity, TrackingStatus } from "../../lib/types";
import { formatAppError } from "../../lib/types";
import { useSummonStore, useSummonTarget } from "../../store/summon";
import { useCommitDraftStore } from "../../store/commitDraft";
import { notify } from "../../store/notifications";
import { confirmDialog } from "../../store/confirm";
import { FileTree } from "../shared/FileTree/FileTree";
import { LineEndingRowBadge } from "../shared/LineEndingBadge";
import { useLineEndingStatusMap } from "../shared/lineEndingStatus";
import { ToolbarButton } from "../shared/ToolbarButton";
import { Button, IconButton } from "../shared/buttons";
import { useFileRowMetrics } from "../shared/FileTree/useFileRowMetrics";
import type { FileTreeEntry, ViewMode } from "../shared/FileTree/buildTree";
import { StageIcon, UnstageIcon, WarningIcon } from "../../icons";
import { PanelContextMenuProvider, useMenuConfirm, type BaselineEntry } from "../Commits/menu/PanelContextMenu";
import { MenuItem } from "../Commits/menu/primitives";
import { CopyPathMenuSection } from "../shared/CopyPathMenuSection";
import { OpenInEditorMenuItem } from "../shared/OpenInEditorMenuItem";
import { AddToGitignoreMenuItem } from "../shared/AddToGitignoreMenuItem";
import { PanelLoadingBar } from "../shared/PanelLoadingBar";
import { usePanelRunner } from "../shared/usePanelRunner";
import { invalidateRepoDomains } from "../../lib/repoInvalidation";
import { notifyResolutionInvisible } from "../../lib/mergeFeedback";
import { openSubmoduleRepo } from "../../lib/submodules";
import { summonGlobalPanel } from "../GlobalDock";
import { useOpState } from "../../lib/useOpState";
import { isDetachedHead } from "../../lib/detachedHead";
import { takeSideLabels } from "./conflictLabels";
import { formatEolChanges, stagedEolChanges } from "./lineEndingWarning";
import {
  orderedWorkingChangesSections,
  type WorkingChangesSection,
} from "./sectionOrder";

/**
 * "Reopen conflict" entry for a row (staged or unstaged again) that was a
 * conflict resolution: restores the conflicted state, discarding the current
 * resolution. Destructive, so it inline-confirms per the global
 * destructive-confirmation setting (a hook-using component because the menu
 * content is built inline).
 */
function ReopenConflictMenuItem({ onReopen }: { onReopen: () => void }) {
  const confirmDestructive = useConfirmDestructive();
  const menuConfirm = useMenuConfirm();
  const request = () => {
    if (!confirmDestructive) {
      onReopen();
      return;
    }
    menuConfirm("Reopen conflict? The current resolution will be discarded.", onReopen);
  };
  return (
    <MenuItem onClick={request}>
      {confirmDestructive ? "Reopen conflict…" : "Reopen conflict"}
    </MenuItem>
  );
}

/** Persisted unstaged/staged height split (fraction of the first file
 *  section in render order) + its clamp, so neither list can be squeezed
 *  away entirely. */
const SPLIT_KEY = "legit.workingChanges.split";
const SPLIT_MIN = 0.15;
const SPLIT_MAX = 0.85;

const toEntry = (s: FileStatus): FileTreeEntry => ({
  path: s.path,
  change: s.state,
  additions: s.additions ?? undefined,
  deletions: s.deletions ?? undefined,
  binary: s.binary,
});

/** Sum a section's per-file line counts (entries without counts add 0). */
const sumCounts = (files: FileTreeEntry[]) => {
  let add = 0;
  let del = 0;
  for (const f of files) {
    add += f.additions ?? 0;
    del += f.deletions ?? 0;
  }
  return { add, del };
};

/** "+A −D" in the status colours; renders nothing when both are zero. */
function CountsSummary({ add, del }: { add: number; del: number }) {
  if (add === 0 && del === 0) return null;
  return (
    <span style={{ textTransform: "none", letterSpacing: 0 }}>
      {add > 0 && <span style={{ color: "var(--status-added)" }}>+{add}</span>}
      {add > 0 && del > 0 && " "}
      {del > 0 && <span style={{ color: "var(--status-deleted)" }}>−{del}</span>}
    </span>
  );
}

/** "1 file" / "3 files" for menu labels. */
const fileCountLabel = (n: number): string => `${n} ${n === 1 ? "file" : "files"}`;

/**
 * Selection follow-through when `paths` move from one section to another (e.g.
 * staging). Generalises the single-select rule to a set: if none of the
 * selection moved, leave it; if all of it moved, follow it into `to`; if only
 * some moved, keep the not-moved paths in `from` (selection lives in one list).
 */
function moveSelection(
  sel: Selection | null,
  from: Section,
  to: Section,
  paths: string[],
): Selection | null {
  if (sel?.section !== from) return sel;
  const remaining = sel.paths.filter((p) => !paths.includes(p));
  if (remaining.length === sel.paths.length) return sel;
  if (remaining.length === 0) return { section: to, paths: sel.paths };
  return { section: from, paths: remaining };
}

/** Drop discarded `paths` from an unstaged selection; empty clears it. */
function dropSelection(sel: Selection | null, paths: string[]): Selection | null {
  if (sel?.section !== "unstaged") return sel;
  const remaining = sel.paths.filter((p) => !paths.includes(p));
  return remaining.length ? { section: "unstaged", paths: remaining } : null;
}

/**
 * Which list the selection lives in, plus the set of selected paths within it.
 * A partially-staged file appears in BOTH sections under the same path, so a
 * path alone can't identify an entry — the selection is scoped to one section.
 * Multi-select (Ctrl/Shift) is confined to a single list: selecting in one
 * section replaces any selection in the other, so the two lists never highlight
 * simultaneously.
 */
type Section = "staged" | "unstaged";
interface Selection {
  section: Section;
  paths: string[];
}

/**
 * Working Changes panel — Staged / Unstaged sections over the working tree,
 * with per-file and bulk stage/unstage/discard and a commit box. Summoned into
 * the shared side region when the uncommitted-changes row is selected.
 */
export function WorkingChangesPanel() {
  const repo = useActiveRepo();
  const queryClient = useQueryClient();

  const viewMode: ViewMode =
    useSettingsStore((s) => s.settings?.changed_files_view_mode) === "tree" ? "tree" : "flat";
  // User-chosen top-to-bottom order of the three sections (Global Settings).
  const sectionOrder = orderedWorkingChangesSections(
    useSettingsStore((s) => s.settings?.working_changes_section_order),
  );
  // Whether discard actions prompt first (global setting, default on).
  const confirmDiscardEnabled = useSettingsStore((s) => s.settings?.confirm_discard ?? true);
  // Line-ending features: repo override else global (both default on).
  const chipsGlobal = useSettingsStore((s) => s.settings?.line_ending_chips_in_changes ?? true);
  const warnEolGlobal = useSettingsStore((s) => s.settings?.warn_on_line_ending_commit ?? true);
  const repoEolSettings = useRepoStore((s) => (repo ? s.repoSettings[repo.id] : undefined));
  const chipsEnabled = repoEolSettings?.line_ending_chips_in_changes ?? chipsGlobal;
  const warnEolCommit = repoEolSettings?.warn_on_line_ending_commit ?? warnEolGlobal;
  const setViewMode = useSettingsStore((s) => s.setChangedFilesViewMode);
  const { rowHeight, iconSize } = useFileRowMetrics();

  // Height split between the two file sections (fraction taken by the FIRST
  // one in the render order), draggable via the sash between them and
  // persisted. The commit composer keeps its natural height. During a drag
  // the flex weights are set directly on the DOM (no re-render per
  // mousemove); state + storage are committed once on release.
  const [splitFrac, setSplitFrac] = useState(() => {
    const v = Number(localStorage.getItem(SPLIT_KEY));
    return Number.isFinite(v) && v >= SPLIT_MIN && v <= SPLIT_MAX ? v : 0.5;
  });
  const firstFileRef = useRef<HTMLDivElement | null>(null);
  const secondFileRef = useRef<HTMLDivElement | null>(null);
  const onSplitMouseDown = useCallback((e: React.MouseEvent) => {
    const first = firstFileRef.current;
    const second = secondFileRef.current;
    if (!first || !second) return;
    e.preventDefault();
    // Fraction of the COMBINED flexible height (the two file sections); the
    // commit composer between them is fixed, so the first section's top and
    // the combined height are both constant for the whole drag.
    const top = first.getBoundingClientRect().top;
    const total =
      first.getBoundingClientRect().height + second.getBoundingClientRect().height;
    if (total < 1) return;
    let frac = 0.5;
    const onMove = (ev: MouseEvent) => {
      frac = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, (ev.clientY - top) / total));
      first.style.flexGrow = String(frac);
      second.style.flexGrow = String(1 - frac);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      setSplitFrac(frac);
      try {
        localStorage.setItem(SPLIT_KEY, String(frac));
      } catch {
        /* quota */
      }
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, []);
  const resetSplit = useCallback(() => {
    setSplitFrac(0.5);
    try {
      localStorage.removeItem(SPLIT_KEY);
    } catch {
      /* quota */
    }
  }, []);

  // The draft commit message lives in a per-repo store, not component state:
  // this panel shares a dock slot and unmounts whenever the user opens e.g. a
  // commit, and a typed draft must survive that round-trip.
  const message = useCommitDraftStore((s) => (repo ? (s.drafts[repo.id] ?? "") : ""));
  const setDraft = useCommitDraftStore((s) => s.setDraft);
  const clearDraft = useCommitDraftStore((s) => s.clearDraft);
  const setMessage = (m: string) => {
    if (!repo) return;
    if (m.length === 0) clearDraft(repo.id);
    else setDraft(repo.id, m);
  };
  // When set, the commit rewrites HEAD (`git commit --amend`) instead of
  // creating a new commit. Reset after each successful commit.
  const [amend, setAmend] = useState(false);
  // The selected files, scoped to one section so the two lists never highlight
  // at once (a partially-staged file shares its path across both). Drives both
  // row highlighting and the bulk context-menu actions.
  const [selected, setSelected] = useState<Selection | null>(null);
  const [confirmDetachedCommit, setConfirmDetachedCommit] = useState(false);
  const [confirmAmendPushed, setConfirmAmendPushed] = useState(false);
  const [confirmEolCommit, setConfirmEolCommit] = useState(false);

  // Clear the selection when the repo changes — a stale path from the previous
  // repo must not leak into actions or a diff summon for the new repo.
  const prevRepoId = useRef(repo?.id);
  useEffect(() => {
    if (prevRepoId.current === repo?.id) return;
    prevRepoId.current = repo?.id;
    setSelected(null);
  }, [repo?.id]);

  const {
    data: status = [],
    isFetching,
    isError,
    error,
    refetch,
  } = useQuery<FileStatus[]>({
    queryKey: [repo?.id, "status"],
    queryFn: () => repoStatus(repo!.id),
    enabled: !!repo,
    staleTime: 5_000,
  });

  // Batch line-ending summary - drives the row chips and the commit
  // warning. Disabled entirely when both features are off.
  const eolMap = useLineEndingStatusMap(repo?.id, chipsEnabled || warnEolCommit);

  // The latest commit — drives amend message prefill and the "has commits"
  // guard (amend is impossible on an unborn branch). Kept fresh because
  // refresh() invalidates the [repo.id, "log"] key after each commit.
  const { data: headLog = [] } = useQuery<Commit[]>({
    queryKey: [repo?.id, "log", "head1"],
    queryFn: () => repoLog(repo!.id, 1),
    enabled: !!repo,
    staleTime: 5_000,
  });
  const head = headLog[0] ?? null;

  // Tracking status — to warn before amending a commit that's already pushed.
  // Shares React Query's cache with the Commits panel (same key).
  const { data: tracking } = useQuery<TrackingStatus | null>({
    queryKey: [repo?.id, "tracking"],
    queryFn: () => repoTrackingStatus(repo!.id),
    enabled: !!repo,
    staleTime: 5_000,
  });
  // HEAD is already published when it has an upstream and no local-only commits
  // ahead of it (ahead === 0 → the tip is on the remote). Amending then rewrites
  // pushed history and needs a force-push.
  const amendingPushed = amend && !!tracking && tracking.ahead === 0;

  // Commit identity resolved across all config scopes: when name or email is
  // missing everywhere, a commit fails with git's "Please tell me who you are";
  // the composer warns BEFORE that and links to the profile settings. Identity
  // changes rarely and ~/.gitconfig isn't watched, so a moderate staleTime plus
  // the panel-focus refetch keeps it honest after the user sets one.
  const { data: identity } = useQuery<ResolvedIdentity>({
    queryKey: [repo?.id, "identity"],
    queryFn: () => repoResolvedIdentity(repo!.id),
    enabled: !!repo,
    staleTime: 30_000,
  });
  const identityMissing = !!identity && (!identity.user_name || !identity.user_email);

  // Refresh whenever the panel is focused or swapped/summoned into view, so the
  // working tree is re-read after edits made while it wasn't the shown panel.
  const reload = useCallback(() => { refetch(); }, [refetch]);
  usePanelFocusEffect(reload);
  usePanelActiveEffect(reload);

  const staged = useMemo(() => status.filter((s) => s.staged).map(toEntry), [status]);
  const unstaged = useMemo(() => status.filter((s) => !s.staged).map(toEntry), [status]);

  // Line-count sums for the toolbar (whole panel) and the section headers.
  // The panel-wide file count is unique paths — a partially staged file has an
  // entry in both sections but is still one file.
  // Staged line-ending changes the next commit would record - the commit
  // warning's data (index vs HEAD, so repo policy can't false-positive).
  const stagedPathSet = useMemo(() => new Set(staged.map((f) => f.path)), [staged]);
  const eolChanges = useMemo(
    () => stagedEolChanges(eolMap.values(), stagedPathSet),
    [eolMap, stagedPathSet],
  );

  const stagedTotals = useMemo(() => sumCounts(staged), [staged]);
  const unstagedTotals = useMemo(() => sumCounts(unstaged), [unstaged]);
  const totals = useMemo(
    () => ({
      files: new Set(status.map((s) => s.path)).size,
      add: stagedTotals.add + unstagedTotals.add,
      del: stagedTotals.del + unstagedTotals.del,
    }),
    [status, stagedTotals, unstagedTotals],
  );

  // Conflict count drives the conflict-row menu labels; the in-progress
  // merge/rebase banner itself is app chrome now (OpStateStrip in AppLayout).
  const conflictCount = useMemo(
    () => status.filter((s) => s.state === "Conflicted").length,
    [status],
  );

  // An in-progress op gates the resolution-safety features below: that's the
  // window where staged conflict markers are accidents and git's resolve-undo
  // record exists. Both queries are idle otherwise.
  const opState = useOpState(repo?.id);
  const opActive = !!opState && opState.kind !== "none";

  // Files whose content still holds leftover conflict markers - the
  // "accidentally marked resolved" warning. Checked on both sides so the
  // warning follows the file when it is unstaged again; on the unstaged side
  // it only decorates non-Conflicted rows (conflicts already show as such).
  const { data: stagedMarkerPaths = [] } = useQuery<string[]>({
    queryKey: [repo?.id, "status", "staged-markers"],
    queryFn: () => repoStagedMarkerPaths(repo!.id),
    enabled: !!repo && opActive,
    staleTime: 5_000,
  });
  const stagedMarkerSet = useMemo(() => new Set(stagedMarkerPaths), [stagedMarkerPaths]);
  const { data: unstagedMarkerPaths = [] } = useQuery<string[]>({
    queryKey: [repo?.id, "status", "unstaged-markers"],
    queryFn: () => repoUnstagedMarkerPaths(repo!.id),
    enabled: !!repo && opActive,
    staleTime: 5_000,
  });
  const unstagedMarkerSet = useMemo(() => new Set(unstagedMarkerPaths), [unstagedMarkerPaths]);

  // Paths whose conflict was resolved & staged during this op (git's
  // resolve-undo record) - eligible for "Reopen conflict".
  const { data: undoPaths = [] } = useQuery<string[]>({
    queryKey: [repo?.id, "op_state", "resolve-undo"],
    queryFn: () => repoResolveUndoPaths(repo!.id),
    enabled: !!repo && opActive,
    staleTime: 5_000,
  });
  const reopenable = useMemo(() => new Set(undoPaths), [undoPaths]);

  // Conflict kinds for delete-aware Take-ours/theirs labels; only fetched
  // while conflicts exist (the cheap ls-files -u otherwise never runs).
  const { data: conflictEntries = [] } = useQuery<ConflictEntry[]>({
    queryKey: [repo?.id, "op_state", "conflicts"],
    queryFn: () => repoConflictEntries(repo!.id),
    enabled: !!repo && conflictCount > 0,
    staleTime: 5_000,
  });
  const conflictKinds = useMemo(
    () => new Map(conflictEntries.map((e) => [e.path, e.kind])),
    [conflictEntries],
  );

  // The highlighted set for each list — non-empty only for the active section.
  const unstagedSelected = useMemo(
    () => new Set(selected?.section === "unstaged" ? selected.paths : []),
    [selected],
  );
  const stagedSelected = useMemo(
    () => new Set(selected?.section === "staged" ? selected.paths : []),
    [selected],
  );

  // Resolve the targets for a right-click and align the selection like Windows
  // Explorer: right-clicking inside the current selection acts on the whole set
  // and leaves it intact; right-clicking outside it selects just that row
  // (deselecting the rest), then acts on it.
  // Open a file's diff in the Diff panel; the source side depends on which
  // section the row lives in.
  const openDiff = useCallback(
    (section: Section, path: string) => {
      if (!repo) return;
      const source: DiffSource =
        section === "staged" ? { kind: "working_staged" } : { kind: "working_unstaged" };
      const change = status.find((s) => s.path === path)?.state;
      // Conflicted files open the dedicated Merge panel; everything else the
      // Diff panel. The two share one dock slot (swapSummon closes the other).
      if (change === "Conflicted") {
        useSummonStore.getState().swapSummon("merge", "diff", { repoId: repo.id, path });
      } else {
        useSummonStore
          .getState()
          .swapSummon("diff", "merge", { repoId: repo.id, path, source, change } satisfies DiffRequest);
      }
    },
    [repo, status],
  );

  // Track the selection and, when exactly one file is selected, show its diff.
  const onSelectSection = useCallback(
    (section: Section, paths: string[]) => {
      setSelected({ section, paths });
      if (paths.length === 1) openDiff(section, paths[0]);
    },
    [openDiff],
  );

  // After a stage/unstage/discard, keep an ALREADY-OPEN diff viewer in sync with
  // the resulting selection (without forcing it open). If a single file is
  // selected after the op, show its diff in the new section (e.g. staging flips
  // it from the unstaged to the staged diff). If a previously single-selected
  // file is now gone (discarded), clear the viewer. Otherwise leave it alone.
  const syncOpenDiff = useCallback(
    (prev: Selection | null, next: Selection | null) => {
      if (!repo) return;
      const store = useSummonStore.getState();
      if (next && next.paths.length === 1) {
        const source: DiffSource =
          next.section === "staged" ? { kind: "working_staged" } : { kind: "working_unstaged" };
        const change = status.find((s) => s.path === next.paths[0])?.state;
        if (change === "Conflicted") {
          store.notifyIfOpen("merge", { repoId: repo.id, path: next.paths[0] });
          store.notifyIfOpen("diff", null);
        } else {
          store.notifyIfOpen("diff", {
            repoId: repo.id,
            path: next.paths[0],
            source,
            change,
          } satisfies DiffRequest);
          store.notifyIfOpen("merge", null);
        }
        return;
      }
      if (prev && prev.paths.length === 1 && !next?.paths.includes(prev.paths[0])) {
        store.notifyIfOpen("diff", null);
        store.notifyIfOpen("merge", null);
      }
    },
    [repo, status],
  );

  // Summoned from the log's working-dir row: the shared Diff/Merge slot may
  // still show a commit file from Changed Files. Sync it to THIS panel's
  // selection - show the single selected working file, otherwise clear it.
  const onSummoned = useCallback(() => {
    if (selected && selected.paths.length === 1) {
      syncOpenDiff(null, selected);
      return;
    }
    const store = useSummonStore.getState();
    store.notifyIfOpen("diff", null);
    store.notifyIfOpen("merge", null);
  }, [selected, syncOpenDiff]);
  useSummonTarget("working-changes", onSummoned);

  // Right-click targeting: if the row is outside the current selection, the
  // selection moves to it (so the menu's bulk actions hit what was clicked).
  // The selection is what the detail views show, so an already-open Diff or
  // Merge panel follows it - but a right-click never force-opens one
  // (syncOpenDiff uses notifyIfOpen).
  const selectForMenu = (section: Section, path: string): string[] => {
    if (selected?.section === section && selected.paths.includes(path)) return selected.paths;
    const next: Selection = { section, paths: [path] };
    setSelected(next);
    syncOpenDiff(selected, next);
    return [path];
  };

  const refresh = useCallback(() => {
    if (!repo) return;
    // Fires immediately (instant feedback) and records the time so the
    // filesystem watcher's redundant follow-up for the same action is dropped.
    // "diff" is included so an open Diff panel re-fetches: staging/unstaging a
    // file here changes which hunks appear in its working-tree diff.
    // "op_state" keeps the merge/rebase banner's conflict actions fresh.
    invalidateRepoDomains(queryClient, repo.id, ["status", "log", "branches", "diff", "op_state"]);
  }, [repo, queryClient]);

  const { busy, run } = usePanelRunner({
    enabled: !!repo,
    onSuccess: refresh,
    onError: (e) => notify.error(formatAppError(e)),
  });

  // Staging/unstaging moves files between the two lists; the selection follows
  // them (see moveSelection). Discarding removes them outright, so they're
  // dropped from the selection.
  const stage = (paths: string[]) =>
    run(async () => {
      await repoStage(repo!.id, paths);
      const next = moveSelection(selected, "unstaged", "staged", paths);
      setSelected(next);
      syncOpenDiff(selected, next);
    });
  const unstage = (paths: string[]) =>
    run(async () => {
      await repoUnstage(repo!.id, paths);
      const next = moveSelection(selected, "staged", "unstaged", paths);
      setSelected(next);
      syncOpenDiff(selected, next);
    });
  // Reopen a resolved-and-staged conflict (restores the unmerged stages and
  // regenerates the markers), then bring the Merge panel up for the file.
  const reopenConflict = (path: string) =>
    run(async () => {
      await repoConflictReopen(repo!.id, path);
      useSummonStore.getState().summon("merge", { repoId: repo!.id, path });
    });

  // Whole-file take from the conflict-row menu; a resolution identical to
  // HEAD vanishes from status entirely, so it carries the explanatory note.
  const takeSide = (path: string, side: ConflictSide) =>
    run(async () => {
      await repoResolveTakeSide(repo!.id, path, side);
      await notifyResolutionInvisible(repo!.id, path);
    });

  // Stash specific files - each file's FULL change (staged + unstaged
  // halves), untracked included. Not destructive (the changes live on in the
  // stash), so no confirm. Not offered while an op is in progress: git
  // refuses pathspec stashes over unmerged entries.
  const stashFiles = (paths: string[]) =>
    run(async () => {
      const outcome = await repoCreateStashPaths(repo!.id, undefined, paths);
      invalidateRepoDomains(queryClient, repo!.id, ["stashes"]);
      if (outcome.kind === "nothing_to_stash") {
        notify.info("Nothing to stash - the selected files have no local changes.");
      }
    });
  // Rows a pathspec stash can take: gitlinks have no stashable content and
  // conflicted rows are refused by git.
  const stashablePaths = (section: FileTreeEntry[], targets: string[]) => {
    const set = new Set(targets);
    return section
      .filter((e) => set.has(e.path))
      .filter(
        (e) =>
          e.change !== "SubmoduleDirty" &&
          e.change !== "SubmoduleChanged" &&
          e.change !== "Conflicted",
      )
      .map((e) => e.path);
  };

  // Open a submodule row's repo as a peer tab (sessions dedupe by toplevel).
  // A pointer-move row passes its diff source so the entry's new pointer is
  // selected in the submodule's log; a dirty-only row has no commit to jump
  // to and opens plain (source null).
  const openSubmodule = (path: string, source: DiffSource | null) => {
    void openSubmoduleRepo(repo!.id, repo!.path, path, source).catch(
      (err: unknown) => notify.error(formatAppError(err)),
    );
  };

  const doDiscard = (paths: string[]) =>
    run(async () => {
      await repoDiscard(repo!.id, paths);
      const next = dropSelection(selected, paths);
      setSelected(next);
      syncOpenDiff(selected, next);
    });
  const commit = () =>
    run(async () => {
      await repoCommit(repo!.id, message, amend);
      setMessage("");
      setAmend(false);
    });

  // A detached-HEAD commit is reachable only through the reflog once HEAD
  // moves on, so always ask first — this is a data-loss warning, not a
  // destructive-action confirm, so it is deliberately NOT gated by the
  // global confirmation setting. Judged from the HEAD commit's log
  // decorations: a bare `head` decoration = detached.
  const detached = isDetachedHead(head);
  // Final gate before the actual commit: the line-ending warning (per its
  // setting). Runs LAST so it also covers commits approved through the
  // detached-HEAD / amend-pushed confirms.
  const proceedCommit = () => {
    if (warnEolCommit && eolChanges.length > 0) {
      setConfirmEolCommit(true);
      return;
    }
    commit();
  };
  const requestCommit = () => {
    if (detached) {
      setConfirmDetachedCommit(true);
      return;
    }
    // Amending an already-pushed commit rewrites published history (force-push
    // needed, disrupts collaborators). Warn first — like the detached case, a
    // history-safety warning, deliberately NOT gated by the confirm setting.
    if (amendingPushed) {
      setConfirmAmendPushed(true);
      return;
    }
    proceedCommit();
  };

  // Drop a pending detached-HEAD confirmation once HEAD is back on a branch
  // (e.g. the user switched away with the prompt still open).
  useEffect(() => {
    if (!detached) setConfirmDetachedCommit(false);
  }, [detached]);

  // Drop a pending amend-pushed confirmation if it no longer applies (amend
  // toggled off, or new local commits mean the tip is no longer published).
  useEffect(() => {
    if (!amendingPushed) setConfirmAmendPushed(false);
  }, [amendingPushed]);

  // Drop a pending line-ending confirmation once it no longer applies
  // (files unstaged, endings reverted, or the setting turned off).
  useEffect(() => {
    if (!warnEolCommit || eolChanges.length === 0) setConfirmEolCommit(false);
  }, [warnEolCommit, eolChanges.length]);

  // Prefill HEAD's message when turning amend on, but only if the box is empty
  // so typed-but-uncommitted text is never clobbered.
  const toggleAmend = (next: boolean) => {
    setAmend(next);
    if (next && head && message.trim().length === 0) setMessage(head.message);
  };

  // Confirm before discarding (destructive) via the central dialog; then run
  // it. The label defaults to the lone path, or "N files" for a bulk
  // discard. When the confirmation setting is off, discard runs immediately.
  const requestDiscard = async (paths: string[], label?: string) => {
    if (confirmDiscardEnabled) {
      const ok = await confirmDialog({
        title: "Discard changes",
        message: "Discards the working-tree changes. This cannot be undone.",
        detail: label ?? (paths.length === 1 ? paths[0] : `${paths.length} files`),
        confirmLabel: "Discard",
      });
      if (!ok) return;
    }
    doDiscard(paths);
  };

  if (!repo) {
    return (
      <div className="legit-panel">
        <div className="legit-panel__body">
          <span className="legit-subtle">No repo open.</span>
        </div>
      </div>
    );
  }

  // Amend allows a message-only commit (no staged files required), but needs an
  // existing HEAD to rewrite.
  const canCommit = amend
    ? !!head && message.trim().length > 0 && !busy
    : staged.length > 0 && message.trim().length > 0 && !busy;

  const baseline: BaselineEntry[] = [{ label: "Refresh", onClick: refresh, disabled: busy }];

  return (
    <PanelContextMenuProvider baseline={baseline}>
      {({ openMenu, closeMenu }) => (
        <div
          className="legit-panel"
          style={{ display: "flex", flexDirection: "column" }}
          onContextMenu={(e) => openMenu(e)}
        >
      <PanelLoadingBar active={isFetching} />
      <div className="legit-panel__toolbar" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ display: "flex" }}>
          <button onClick={() => setViewMode("tree")} aria-pressed={viewMode === "tree"} style={segStyle(viewMode === "tree", "left")}>
            Tree
          </button>
          <button onClick={() => setViewMode("flat")} aria-pressed={viewMode === "flat"} style={segStyle(viewMode === "flat", "right")}>
            List
          </button>
        </div>
        <span
          className="legit-subtle"
          style={{ fontSize: "var(--fz-sm)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}
        >
          {totals.files} file{totals.files === 1 ? "" : "s"}
          {totals.add > 0 && (
            <> · <span style={{ color: "var(--status-added)" }}>+{totals.add}</span></>
          )}
          {totals.del > 0 && (
            <> <span style={{ color: "var(--status-deleted)" }}>−{totals.del}</span></>
          )}
          {" · Working changes"}
        </span>
      </div>

      {isError && (
        <pre className="legit-error" style={{ margin: "8px 12px", fontSize: "var(--fz-md)" }}>
          {formatAppError(error)}
        </pre>
      )}

      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {(() => {
          // The two file sections share the remaining height per the
          // draggable split. The sash sits on the FIRST file section's
          // bottom edge - with the commit composer ordered between the two,
          // dragging it still reallocates the file sections' shares (the
          // fixed-height composer just rides along).
          const fileIds = sectionOrder.filter(
            (id): id is "unstaged" | "staged" => id !== "commit",
          );
          const growOf = (id: "unstaged" | "staged") =>
            id === fileIds[0] ? splitFrac : 1 - splitFrac;
          const refOf = (id: "unstaged" | "staged") =>
            id === fileIds[0] ? firstFileRef : secondFileRef;
          const sashBeforeId = sectionOrder[sectionOrder.indexOf(fileIds[0]) + 1];
          const unstagedSection = (
          <Section
            key="unstaged"
            grow={growOf("unstaged")}
            sectionRef={refOf("unstaged")}
            testId="wc-unstaged"
            title="Unstaged"
            count={unstaged.length}
            additions={unstagedTotals.add}
            deletions={unstagedTotals.del}
            actions={
              unstaged.length > 0 && (
                <>
                  <ToolbarButton
                    label="Discard all"
                    disabled={busy}
                    onClick={() =>
                      requestDiscard(
                        unstaged.filter((f) => f.change !== "SubmoduleDirty").map((f) => f.path),
                        "all unstaged files",
                      )
                    }
                  />
                  <ToolbarButton
                    label="Stage all"
                    disabled={busy}
                    onClick={() =>
                      stage(unstaged.filter((f) => f.change !== "SubmoduleDirty").map((f) => f.path))
                    }
                  />
                </>
              )
            }
          >
            <FileTree
              files={unstaged}
              viewMode={viewMode}
              selectedPath={null}
              multiSelect
              selectedPaths={unstagedSelected}
              onSelectionChange={(paths) => onSelectSection("unstaged", paths)}
              rowHeight={rowHeight}
              iconSize={iconSize}
              onContextMenu={(f, e) => {
                const targets = selectForMenu("unstaged", f.path);
                const many = targets.length > 1;
                if (f.change === "SubmoduleDirty" && !many) {
                  openMenu(
                    e,
                    <>
                      <MenuItem onClick={() => { closeMenu(); openSubmodule(f.path, null); }}>
                        Open submodule
                      </MenuItem>
                      <MenuItem
                        onClick={() => {
                          closeMenu();
                          useSummonStore.getState().summon("file-history", f.path);
                        }}
                      >
                        File history
                      </MenuItem>
                    </>,
                  );
                  return;
                }
                openMenu(
                  e,
                  <>
                    {!many && f.change === "Conflicted" && (
                      <>
                        <MenuItem onClick={() => { void takeSide(f.path, "ours"); closeMenu(); }}>
                          {takeSideLabels(conflictKinds.get(f.path)).ours}
                        </MenuItem>
                        <MenuItem onClick={() => { void takeSide(f.path, "theirs"); closeMenu(); }}>
                          {takeSideLabels(conflictKinds.get(f.path)).theirs}
                        </MenuItem>
                        <MenuItem onClick={() => { stage([f.path]); closeMenu(); }}>
                          Mark resolved
                        </MenuItem>
                      </>
                    )}
                    {!many && f.change === "SubmoduleChanged" && (
                      <MenuItem
                        onClick={() => {
                          closeMenu();
                          openSubmodule(f.path, { kind: "working_unstaged" });
                        }}
                      >
                        Open submodule
                      </MenuItem>
                    )}
                    {!many && f.change !== "Conflicted" && opActive && reopenable.has(f.path) && (
                      <ReopenConflictMenuItem
                        onReopen={() => {
                          closeMenu();
                          void reopenConflict(f.path);
                        }}
                      />
                    )}
                    <MenuItem onClick={() => { stage(targets); closeMenu(); }}>
                      {many ? `Stage ${targets.length} selected` : "Stage"}
                    </MenuItem>
                    <MenuItem
                      onClick={() => { void requestDiscard(targets); closeMenu(); }}
                    >
                      {many
                        ? `Discard ${targets.length} selected`
                        : f.change === "Untracked"
                        ? "Delete file"
                        : "Discard changes"}
                    </MenuItem>
                    {!opActive && stashablePaths(unstaged, targets).length > 0 && (
                      <MenuItem
                        onClick={() => {
                          void stashFiles(stashablePaths(unstaged, targets));
                          closeMenu();
                        }}
                      >
                        {many
                          ? `Stash ${stashablePaths(unstaged, targets).length} selected`
                          : "Stash file"}
                      </MenuItem>
                    )}
                    {!many && f.change !== "Untracked" && f.change !== "SubmoduleChanged" && (
                      <MenuItem
                        onClick={() => {
                          closeMenu();
                          useSummonStore.getState().summon("blame", f.path);
                        }}
                      >
                        Blame file
                      </MenuItem>
                    )}
                    {!many && (
                      <MenuItem
                        onClick={() => {
                          closeMenu();
                          useSummonStore.getState().summon("file-history", f.path);
                        }}
                      >
                        File history
                      </MenuItem>
                    )}
                    {!many && <CopyPathMenuSection path={f.path} onClose={closeMenu} />}
                    {!many && f.change !== "Deleted" && f.change !== "SubmoduleChanged" && (
                      <OpenInEditorMenuItem path={f.path} onClose={closeMenu} />
                    )}
                    {!many && f.change === "Untracked" && (
                      <AddToGitignoreMenuItem path={f.path} onClose={closeMenu} />
                    )}
                  </>,
                );
              }}
              // An unstaged (formerly staged) resolution that still holds
              // markers keeps the conflict triangle; genuinely Conflicted
              // rows already derive it from their status.
              renderFileIcon={(f) =>
                opActive && f.change !== "Conflicted" && unstagedMarkerSet.has(f.path) ? (
                  <span
                    title="File content still contains conflict markers"
                    style={{ display: "inline-flex", color: "var(--status-conflicted)" }}
                  >
                    <WarningIcon size={iconSize} />
                  </span>
                ) : null
              }
              renderBadge={
                chipsEnabled
                  ? (f) => {
                      const entry = eolMap.get(f.path);
                      return entry ? (
                        <LineEndingRowBadge repoId={repo.id} entry={entry} side="unstaged" disabled={busy} />
                      ) : null;
                    }
                  : undefined
              }
              renderActions={(f) =>
                // A dirty-inside submodule has nothing stageable (the pointer
                // is unmoved) - no stage button, the row is informational.
                f.change === "SubmoduleDirty" ? null : (
                  <IconButton title="Stage" disabled={busy} onClick={() => stage([f.path])}>
                    <StageIcon />
                  </IconButton>
                )
              }
              renderDirActions={(paths) => (
                <IconButton title={`Stage folder (${fileCountLabel(paths.length)})`} disabled={busy} onClick={() => stage(paths)}>
                  <StageIcon />
                </IconButton>
              )}
              onDirContextMenu={(paths, dir, e) =>
                openMenu(
                  e,
                  <>
                    <MenuItem onClick={() => { stage(paths); closeMenu(); }}>
                      Stage folder ({fileCountLabel(paths.length)})
                    </MenuItem>
                    <MenuItem onClick={() => { void requestDiscard(paths, dir); closeMenu(); }}>
                      Discard folder ({fileCountLabel(paths.length)})
                    </MenuItem>
                  </>,
                )
              }
            />
          </Section>
          );
          const stagedSection = (
          <Section
            key="staged"
            grow={growOf("staged")}
            sectionRef={refOf("staged")}
            testId="wc-staged"
            title="Staged"
            count={staged.length}
            additions={stagedTotals.add}
            deletions={stagedTotals.del}
            actions={
              staged.length > 0 && (
                <ToolbarButton
                  label="Unstage all"
                  disabled={busy}
                  onClick={() => unstage(staged.map((f) => f.path))}
                />
              )
            }
          >
            <FileTree
              files={staged}
              viewMode={viewMode}
              selectedPath={null}
              multiSelect
              selectedPaths={stagedSelected}
              onSelectionChange={(paths) => onSelectSection("staged", paths)}
              rowHeight={rowHeight}
              iconSize={iconSize}
              onContextMenu={(f, e) => {
                const targets = selectForMenu("staged", f.path);
                openMenu(
                  e,
                  <>
                    {targets.length === 1 && f.change === "SubmoduleChanged" && (
                      <MenuItem
                        onClick={() => {
                          closeMenu();
                          openSubmodule(f.path, { kind: "working_staged" });
                        }}
                      >
                        Open submodule
                      </MenuItem>
                    )}
                    {targets.length === 1 && opActive && reopenable.has(f.path) && (
                      <ReopenConflictMenuItem
                        onReopen={() => {
                          closeMenu();
                          void reopenConflict(f.path);
                        }}
                      />
                    )}
                    <MenuItem onClick={() => { unstage(targets); closeMenu(); }}>
                      {targets.length > 1 ? `Unstage ${targets.length} selected` : "Unstage"}
                    </MenuItem>
                    {!opActive && stashablePaths(staged, targets).length > 0 && (
                      <MenuItem
                        onClick={() => {
                          void stashFiles(stashablePaths(staged, targets));
                          closeMenu();
                        }}
                      >
                        {targets.length > 1
                          ? `Stash ${stashablePaths(staged, targets).length} selected`
                          : "Stash file"}
                      </MenuItem>
                    )}
                    {targets.length === 1 && f.change !== "Added" && f.change !== "SubmoduleChanged" && (
                      <MenuItem
                        onClick={() => {
                          closeMenu();
                          useSummonStore.getState().summon("blame", f.path);
                        }}
                      >
                        Blame file
                      </MenuItem>
                    )}
                    {targets.length === 1 && (
                      <MenuItem
                        onClick={() => {
                          closeMenu();
                          useSummonStore.getState().summon("file-history", f.path);
                        }}
                      >
                        File history
                      </MenuItem>
                    )}
                    {targets.length === 1 && (
                      <CopyPathMenuSection path={f.path} onClose={closeMenu} />
                    )}
                    {targets.length === 1 && f.change !== "Deleted" && f.change !== "SubmoduleChanged" && (
                      <OpenInEditorMenuItem path={f.path} onClose={closeMenu} />
                    )}
                  </>,
                );
              }}
              // A staged resolution that still holds conflict markers keeps
              // reading as conflicted: the warning triangle replaces the
              // status icon, same position and colour as during the conflict.
              renderFileIcon={(f) =>
                opActive && stagedMarkerSet.has(f.path) ? (
                  <span
                    title="Staged content still contains conflict markers"
                    style={{ display: "inline-flex", color: "var(--status-conflicted)" }}
                  >
                    <WarningIcon size={iconSize} />
                  </span>
                ) : null
              }
              renderBadge={
                chipsEnabled
                  ? (f) => {
                      const entry = eolMap.get(f.path);
                      return entry ? (
                        <LineEndingRowBadge repoId={repo.id} entry={entry} side="staged" disabled={busy} />
                      ) : null;
                    }
                  : undefined
              }
              renderActions={(f) => (
                <IconButton title="Unstage" disabled={busy} onClick={() => unstage([f.path])}>
                  <UnstageIcon />
                </IconButton>
              )}
              renderDirActions={(paths) => (
                <IconButton title={`Unstage folder (${fileCountLabel(paths.length)})`} disabled={busy} onClick={() => unstage(paths)}>
                  <UnstageIcon />
                </IconButton>
              )}
              onDirContextMenu={(paths, _dir, e) =>
                openMenu(
                  e,
                  <MenuItem onClick={() => { unstage(paths); closeMenu(); }}>
                    Unstage folder ({fileCountLabel(paths.length)})
                  </MenuItem>,
                )
              }
            />
          </Section>
          );
          const commitComposer = (
          <div key="commit" style={{ flexShrink: 0, borderTop: "1px solid var(--panel-border)", padding: 8, display: "flex", flexDirection: "column", gap: 6 }}>
          {identityMissing && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "6px 8px",
                border: "1px solid var(--panel-border)",
                borderRadius: 4,
                background: "var(--button-hover-bg)",
                fontSize: "var(--fz-md)",
              }}
            >
              <span style={{ display: "inline-flex", color: "var(--warning-fg)" }}>
                <WarningIcon />
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>
                No git identity is set ({!identity?.user_name && <code>user.name</code>}
                {!identity?.user_name && !identity?.user_email && ", "}
                {!identity?.user_email && <code>user.email</code>}): committing will fail.
              </span>
              <button onClick={() => summonGlobalPanel("global-settings")}>
                Set identity…
              </button>
            </div>
          )}
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Commit message"
            rows={3}
            style={{ resize: "vertical", fontFamily: "inherit", fontSize: "var(--fz-md)" }}
          />
          {confirmDetachedCommit ? (
            <div
              style={{
                padding: "8px 10px",
                border: "1px solid var(--panel-border)",
                borderRadius: 4,
                background: "var(--button-hover-bg)",
              }}
            >
              <div style={{ marginBottom: 8, fontSize: "var(--fz-md)" }}>
                HEAD is <strong>detached</strong> — no branch points here, so once you
                switch away this commit is only reachable via the reflog. Commit anyway?
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() => {
                    setConfirmDetachedCommit(false);
                    proceedCommit();
                  }}
                >
                  Commit anyway
                </Button>
                <button disabled={busy} onClick={() => setConfirmDetachedCommit(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : confirmAmendPushed ? (
            <div
              style={{
                padding: "8px 10px",
                border: "1px solid var(--panel-border)",
                borderRadius: 4,
                background: "var(--button-hover-bg)",
              }}
            >
              <div style={{ marginBottom: 8, fontSize: "var(--fz-md)" }}>
                The last commit is <strong>already pushed</strong>
                {tracking?.upstream ? <> to <code>{tracking.upstream}</code></> : null}. Amending
                rewrites it, so you'll need to force-push and it may disrupt anyone who has pulled
                it. Amend anyway?
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <Button
                  variant="danger"
                  disabled={busy}
                  onClick={() => {
                    setConfirmAmendPushed(false);
                    proceedCommit();
                  }}
                >
                  Amend anyway
                </Button>
                <button disabled={busy} onClick={() => setConfirmAmendPushed(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : confirmEolCommit ? (
            <div
              style={{
                padding: "8px 10px",
                border: "1px solid var(--panel-border)",
                borderRadius: 4,
                background: "var(--button-hover-bg)",
              }}
            >
              <div style={{ marginBottom: 8, fontSize: "var(--fz-md)" }}>
                {eolChanges.length === 1 ? (
                  <>1 file changes <strong>line endings</strong>: </>
                ) : (
                  <>{eolChanges.length} files change <strong>line endings</strong>: </>
                )}
                <code>{formatEolChanges(eolChanges)}</code>. Commit anyway?
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() => {
                    setConfirmEolCommit(false);
                    commit();
                  }}
                >
                  Commit anyway
                </Button>
                <button disabled={busy} onClick={() => setConfirmEolCommit(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "var(--fz-sm)", color: "var(--subtle-fg)" }}>
                <input type="checkbox" checked={amend} disabled={!head || busy} onChange={(e) => toggleAmend(e.target.checked)} />
                Amend last commit
              </label>
              <Button variant="primary" data-testid="commit-button" disabled={!canCommit} onClick={requestCommit} style={{ marginLeft: "auto" }}>
                {amend ? "Amend" : "Commit"} {!amend && staged.length > 0 ? `(${staged.length})` : ""}
              </Button>
            </div>
          )}
        </div>
          );
          const blocks: Record<WorkingChangesSection, ReactNode> = {
            unstaged: unstagedSection,
            staged: stagedSection,
            commit: commitComposer,
          };
          // Render sections top-to-bottom in the user's order. When there are
          // no changes, the two file lists collapse into a single "No changes"
          // filler shown in the first list slot; the commit composer keeps its
          // ordered position.
          let emptyShown = false;
          return sectionOrder.map((id) => {
            if (id !== "commit" && status.length === 0) {
              if (emptyShown) return null;
              emptyShown = true;
              return (
                <div key="empty" className="legit-panel__body" style={{ flex: 1 }}>
                  <span className="legit-subtle">No changes.</span>
                </div>
              );
            }
            if (id === sashBeforeId && status.length > 0) {
              return (
                <Fragment key={id}>
                  <div
                    onMouseDown={onSplitMouseDown}
                    onDoubleClick={resetSplit}
                    title="Drag to resize, double-click to reset"
                    style={{
                      flexShrink: 0,
                      height: 5,
                      cursor: "row-resize",
                      background: "var(--panel-border)",
                    }}
                  />
                  {blocks[id]}
                </Fragment>
              );
            }
            return blocks[id];
          });
        })()}
      </div>
        </div>
      )}
    </PanelContextMenuProvider>
  );
}

function Section({
  title,
  count,
  additions = 0,
  deletions = 0,
  actions,
  children,
  grow = 1,
  sectionRef,
  testId,
}: {
  title: string;
  count: number;
  /** Section-wide line-count sums, shown next to the file count. */
  additions?: number;
  deletions?: number;
  actions?: React.ReactNode;
  children: React.ReactNode;
  /** Flex share of the panel height (the unstaged/staged split). */
  grow?: number;
  sectionRef?: React.Ref<HTMLDivElement>;
  /** Stable hook for the E2E suite (scopes file-row selectors per section). */
  testId?: string;
}) {
  return (
    <div
      ref={sectionRef}
      data-testid={testId}
      style={{ flex: `${grow} 1 0%`, minHeight: 0, display: "flex", flexDirection: "column" }}
    >
      <div
        style={{
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "4px 8px",
          fontSize: "var(--fz-sm)",
          textTransform: "uppercase",
          letterSpacing: 0.5,
          color: "var(--subtle-fg)",
          borderBottom: "1px solid var(--panel-border)",
        }}
      >
        <span>{title}</span>
        <span>{count}</span>
        <CountsSummary add={additions} del={deletions} />
        <span style={{ marginLeft: "auto", display: "flex", gap: 8, textTransform: "none", letterSpacing: 0 }}>
          {actions}
        </span>
      </div>
      {children}
    </div>
  );
}

function segStyle(active: boolean, side: "left" | "right"): React.CSSProperties {
  return {
    fontSize: "var(--fz-sm)",
    padding: "2px 8px",
    border: "1px solid var(--panel-border)",
    borderRadius: side === "left" ? "3px 0 0 3px" : "0 3px 3px 0",
    marginLeft: side === "right" ? -1 : 0,
    background: active ? "var(--button-active-bg, rgba(255,255,255,0.12))" : "transparent",
    color: "var(--panel-fg)",
    cursor: "pointer",
  };
}
