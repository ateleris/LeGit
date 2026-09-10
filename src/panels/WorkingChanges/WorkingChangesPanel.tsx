import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useActiveRepo, useRepoStore } from "../../store/repos";
import { useSettingsStore } from "../../store/settings";
import { usePanelActiveEffect, usePanelFocusEffect } from "../PanelApiContext";
import { repoCaseDrift, repoConflictEntries, repoConflictReopen, repoCreateStashPaths, repoDiscard, repoDiscardCaseRename, repoResolveTakeSide, repoResolveUndoPaths, repoStage, repoStageCaseRename, repoStagedMarkerPaths, repoStatus, repoSubmodules, repoUnstage, repoUnstagedMarkerPaths } from "../../lib/commands";
import type { CaseDriftEntry, ConflictEntry, ConflictSide, DiffRequest, DiffSource, FileStatus, SubmoduleInfo } from "../../lib/types";
import { formatAppError } from "../../lib/types";
import { useSummonStore, useSummonTarget } from "../../store/summon";
import { notify } from "../../store/notifications";
import { confirmDialog } from "../../store/confirm";
import { segStyle } from "../shared/segmented";
import { FileTree, STATUS_META } from "../shared/FileTree/FileTree";
import { GitFork } from "lucide-react";
import { LineEndingRowBadge } from "../shared/LineEndingBadge";
import { useLineEndingStatusMap } from "../shared/lineEndingStatus";
import { ToolbarButton } from "../shared/ToolbarButton";
import { IconButton } from "../shared/buttons";
import { useFileRowMetrics } from "../shared/FileTree/useFileRowMetrics";
import type { FileTreeEntry, ViewMode } from "../shared/FileTree/buildTree";
import { StageIcon, UnstageIcon, WarningIcon } from "../../icons";
import { PanelContextMenuProvider, type BaselineEntry } from "../Commits/menu/PanelContextMenu";
import { MenuItem } from "../Commits/menu/primitives";
import { PanelLoadingBar } from "../shared/PanelLoadingBar";
import { usePanelRunner } from "../shared/usePanelRunner";
import { invalidateRepoDomains } from "../../lib/repoInvalidation";
import { notifyResolutionInvisible } from "../../lib/mergeFeedback";
import { openSubmoduleRepo } from "../../lib/submodules";
import { useOpState } from "../../lib/useOpState";
import { isSubmodulePath, submodulePathSet } from "./submoduleRows";
import { stagedEolChanges } from "./lineEndingWarning";
import {
  orderedWorkingChangesSections,
  type WorkingChangesSection,
} from "./sectionOrder";
import { CopyPathMenuSection } from "../shared/CopyPathMenuSection";
import { OpenInEditorMenuItem } from "../shared/OpenInEditorMenuItem";
import {
  caseDriftByPath,
  caseDriftTitle,
  selectionDiffAction,
  splitDriftTargets,
  withCaseDriftRows,
} from "./caseDrift";
import { CommitComposer } from "./CommitComposer";
import { FileRowMenu } from "./FileRowMenu";
import {
  dropSelection,
  moveSelection,
  type Section as ListSection,
  type Selection,
} from "./selection";
import { expandUnstagePaths } from "./unstagePaths";

/** Persisted unstaged/staged height split (fraction of the first file
 *  section in render order) + its clamp, so neither list can be squeezed
 *  away entirely. */
const SPLIT_KEY = "legit.workingChanges.split";
const SPLIT_MIN = 0.15;
const SPLIT_MAX = 0.85;

const toEntry = (s: FileStatus): FileTreeEntry => ({
  path: s.path,
  change: s.state,
  old_path: s.old_path ?? undefined,
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
  // Case-only rename detection (global setting, default on). Off = the scan
  // query never runs.
  const detectCaseRenames = useSettingsStore((s) => s.settings?.detect_case_renames ?? true);
  // Line-ending features: repo override else global (both default on).
  const chipsGlobal = useSettingsStore((s) => s.settings?.line_ending_chips_in_changes ?? true);
  const warnEolGlobal = useSettingsStore((s) => s.settings?.warn_on_line_ending_commit ?? true);
  const repoSettings = useRepoStore((s) => (repo ? s.repoSettings[repo.id] : undefined));
  const loadRepoSettings = useRepoStore((s) => s.loadRepoSettings);
  const chipsEnabled = repoSettings?.line_ending_chips_in_changes ?? chipsGlobal;
  const warnEolCommit = repoSettings?.warn_on_line_ending_commit ?? warnEolGlobal;
  // Belt and braces: the cache is normally filled by setActive, but the commit
  // button's caret menu persists through it, so make sure it is actually loaded.
  useEffect(() => {
    if (repo && !repoSettings) void loadRepoSettings(repo.id);
  }, [repo?.id, repoSettings, loadRepoSettings]);
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

  // The selected files, scoped to one section so the two lists never highlight
  // at once (a partially-staged file shares its path across both). Drives both
  // row highlighting and the bulk context-menu actions.
  const [selected, setSelected] = useState<Selection | null>(null);

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

  // Known submodule paths (gitlinked, or declared in .gitmodules but never
  // added) drive the fork-glyph icon override below, so a to-be-added
  // submodule never reads as a plain new file.
  const { data: submodules = [] } = useQuery<SubmoduleInfo[]>({
    queryKey: [repo?.id, "submodules"],
    queryFn: () => repoSubmodules(repo!.id),
    enabled: !!repo,
    staleTime: 5_000,
  });
  const submodulePaths = useMemo(() => submodulePathSet(submodules), [submodules]);
  const submoduleFileIcon = useCallback(
    (file: FileTreeEntry): ReactNode => {
      // Conflicted keeps its warning triangle - the conflict cue outranks
      // the submodule one.
      if (!file.change || file.change === "Conflicted") return null;
      if (!isSubmodulePath(file.path, submodulePaths)) return null;
      // Titled span: the innermost title wins on hover, making the
      // submodule distinction visible as a tooltip.
      return (
        <span title="submodule" aria-label="submodule" style={{ display: "inline-flex" }}>
          <GitFork size={iconSize} color={STATUS_META[file.change].color} />
        </span>
      );
    },
    [submodulePaths, iconSize],
  );

  // Batch line-ending summary - drives the row chips and the commit
  // warning. Disabled entirely when both features are off.
  const eolMap = useLineEndingStatusMap(repo?.id, chipsEnabled || warnEolCommit);

  // Refresh whenever the panel is focused or swapped/summoned into view, so the
  // working tree is re-read after edits made while it wasn't the shown panel.
  const reload = useCallback(() => { refetch(); }, [refetch]);
  usePanelFocusEffect(reload);
  usePanelActiveEffect(reload);

  const staged = useMemo(() => status.filter((s) => s.staged).map(toEntry), [status]);
  const unstaged = useMemo(() => status.filter((s) => !s.staged).map(toEntry), [status]);

  // Case-only rename drift: renames git status cannot see (case-insensitive
  // filesystems). Surfaced as synthetic rename rows in the Unstaged list with
  // a "Stage rename" action; the backend returns [] on case-sensitive
  // filesystems without scanning. Invalidated via the derived "case_drift"
  // domain, so the repo-open catch-up refresh also covers renames made while
  // the app was closed.
  const { data: caseDrift = [] } = useQuery<CaseDriftEntry[]>({
    queryKey: [repo?.id, "case_drift"],
    queryFn: () => repoCaseDrift(repo!.id),
    enabled: !!repo && detectCaseRenames,
    staleTime: 5_000,
  });
  // Only entries that actually became synthetic rows get row overrides - a
  // path collision with a real status row must not restyle that row.
  const driftByPath = useMemo(() => {
    const statusPaths = new Set(unstaged.map((f) => f.path));
    return caseDriftByPath(caseDrift.filter((d) => !statusPaths.has(d.disk_path)));
  }, [unstaged, caseDrift]);
  const unstagedWithDrift = useMemo(
    () => withCaseDriftRows(unstaged, caseDrift),
    [unstaged, caseDrift],
  );

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
  // The entry backing a row, preferring the clicked section's side (a
  // partially-staged file has one entry per section under the same path).
  const entryFor = useCallback(
    (section: ListSection, path: string): FileStatus | undefined =>
      status.find((s) => s.path === path && s.staged === (section === "staged")) ??
      status.find((s) => s.path === path),
    [status],
  );

  const openDiff = useCallback(
    (section: ListSection, path: string) => {
      if (!repo) return;
      const source: DiffSource =
        section === "staged" ? { kind: "working_staged" } : { kind: "working_unstaged" };
      const entry = entryFor(section, path);
      const change = entry?.state;
      // Conflicted files open the dedicated Merge panel; everything else the
      // Diff panel. The two share one dock slot (swapSummon closes the other).
      if (change === "Conflicted") {
        useSummonStore.getState().swapSummon("merge", "diff", { repoId: repo.id, path });
      } else {
        useSummonStore.getState().swapSummon("diff", "merge", {
          repoId: repo.id,
          path,
          source,
          change,
          // Lets the diff pair a rename's sides; without it a staged rename
          // reads as a whole-file add.
          oldPath: entry?.old_path ?? null,
        } satisfies DiffRequest);
      }
    },
    [repo, entryFor],
  );

  // A case-drift row's diff request: the rename pair, whose diff is empty
  // (git sees a clean tree), so the Diff panel renders the "Renamed from
  // old → new (no content changes)" notice - mirroring the staged side.
  const driftDiffRequest = useCallback(
    (d: CaseDriftEntry): DiffRequest => ({
      repoId: repo!.id,
      path: d.disk_path,
      source: { kind: "working_unstaged" },
      change: "Renamed",
      oldPath: d.index_path,
    }),
    [repo],
  );

  // Track the selection and, when exactly one file is selected, show its diff.
  const onSelectSection = useCallback(
    (section: ListSection, paths: string[]) => {
      setSelected({ section, paths });
      switch (selectionDiffAction(section, paths, driftByPath)) {
        case "open":
          openDiff(section, paths[0]);
          break;
        case "open_drift": {
          const d = driftByPath.get(paths[0])!;
          useSummonStore.getState().swapSummon("diff", "merge", driftDiffRequest(d));
          break;
        }
        case "keep":
          break;
      }
    },
    [openDiff, driftByPath, driftDiffRequest],
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
        const entry = entryFor(next.section, next.paths[0]);
        if (entry?.state === "Conflicted") {
          store.notifyIfOpen("merge", { repoId: repo.id, path: next.paths[0] });
          store.notifyIfOpen("diff", null);
        } else {
          store.notifyIfOpen("diff", {
            repoId: repo.id,
            path: next.paths[0],
            source,
            change: entry?.state,
            oldPath: entry?.old_path ?? null,
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
    [repo, entryFor],
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
  const selectForMenu = (section: ListSection, path: string): string[] => {
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
      // Drift rows route through the rename command - `git add` on a path
      // git considers clean would silently do nothing.
      const { drift, rest } = splitDriftTargets(paths, driftByPath);
      if (rest.length > 0) await repoStage(repo!.id, rest);
      for (const d of drift) {
        await repoStageCaseRename(repo!.id, d.index_path, d.disk_path);
      }
      if (drift.length > 0) {
        invalidateRepoDomains(queryClient, repo!.id, ["case_drift"]);
      }
      const next = moveSelection(selected, "unstaged", "staged", paths);
      setSelected(next);
      syncOpenDiff(selected, next);
    });
  const unstage = (paths: string[]) =>
    run(async () => {
      // A rename must restore BOTH its paths, or the source's deletion
      // stays staged (see expandUnstagePaths).
      await repoUnstage(repo!.id, expandUnstagePaths(paths, staged));
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
    void openSubmoduleRepo(repo!.id, repo!.locator ?? repo!.path, path, source).catch(
      (err: unknown) => notify.error(formatAppError(err)),
    );
  };

  const doDiscard = (paths: string[]) =>
    run(async () => {
      // Drift rows route through the rename-back command - a plain discard
      // pathspec would not match anything git considers changed.
      const { drift, rest } = splitDriftTargets(paths, driftByPath);
      if (rest.length > 0) await repoDiscard(repo!.id, rest);
      for (const d of drift) {
        await repoDiscardCaseRename(repo!.id, d.index_path, d.disk_path);
      }
      if (drift.length > 0) {
        invalidateRepoDomains(queryClient, repo!.id, ["case_drift"]);
      }
      const next = dropSelection(selected, paths);
      setSelected(next);
      syncOpenDiff(selected, next);
    });

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

  // Discard confirm for a lone drift row, with wording that doesn't overstate:
  // renaming back loses nothing (unlike a content discard).
  const requestDiscardCaseRename = async (d: CaseDriftEntry) => {
    if (confirmDiscardEnabled) {
      const ok = await confirmDialog({
        title: "Discard rename",
        message: `Renames the ${d.is_dir ? "folder" : "file"} back to its tracked spelling.`,
        detail: `${d.disk_path} → ${d.index_path}`,
        confirmLabel: "Discard",
      });
      if (!ok) return;
    }
    doDiscard([d.disk_path]);
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
            count={unstagedWithDrift.length}
            additions={unstagedTotals.add}
            deletions={unstagedTotals.del}
            actions={
              unstagedWithDrift.length > 0 && (
                <>
                  <ToolbarButton
                    label="Discard all"
                    disabled={busy}
                    onClick={() =>
                      requestDiscard(
                        unstagedWithDrift
                          .filter((f) => f.change !== "SubmoduleDirty")
                          .map((f) => f.path),
                        "all unstaged files",
                      )
                    }
                  />
                  <ToolbarButton
                    label="Stage all"
                    disabled={busy}
                    onClick={() =>
                      stage(
                        unstagedWithDrift
                          .filter((f) => f.change !== "SubmoduleDirty")
                          .map((f) => f.path),
                      )
                    }
                  />
                </>
              )
            }
          >
            <FileTree
              files={unstagedWithDrift}
              viewMode={viewMode}
              selectedPath={null}
              multiSelect
              selectedPaths={unstagedSelected}
              onSelectionChange={(paths) => onSelectSection("unstaged", paths)}
              rowHeight={rowHeight}
              iconSize={iconSize}
              onContextMenu={(f, e) => {
                const d = driftByPath.get(f.path);
                if (d) {
                  // A synthetic case-drift row: stage/discard route through
                  // the rename commands; blame and history exist under the
                  // TRACKED spelling, the editor opens the on-disk file.
                  openMenu(
                    e,
                    <>
                      <MenuItem onClick={() => { void stage([d.disk_path]); closeMenu(); }}>
                        Stage rename
                      </MenuItem>
                      <MenuItem onClick={() => { void requestDiscardCaseRename(d); closeMenu(); }}>
                        Discard rename
                      </MenuItem>
                      {!d.is_dir && (
                        <MenuItem
                          onClick={() => {
                            closeMenu();
                            useSummonStore.getState().summon("blame", d.index_path);
                          }}
                        >
                          Blame file
                        </MenuItem>
                      )}
                      {!d.is_dir && (
                        <MenuItem
                          onClick={() => {
                            closeMenu();
                            useSummonStore.getState().summon("file-history", d.index_path);
                          }}
                        >
                          File history
                        </MenuItem>
                      )}
                      <CopyPathMenuSection path={f.path} onClose={closeMenu} />
                      {!d.is_dir && <OpenInEditorMenuItem path={d.disk_path} onClose={closeMenu} />}
                    </>,
                  );
                  return;
                }
                const targets = selectForMenu("unstaged", f.path);
                openMenu(
                  e,
                  <FileRowMenu
                    section="unstaged"
                    file={f}
                    targets={targets}
                    opActive={opActive}
                    reopenable={reopenable}
                    conflictKinds={conflictKinds}
                    stashable={opActive ? [] : stashablePaths(unstaged, targets)}
                    onPrimary={stage}
                    onDiscard={(paths) => void requestDiscard(paths)}
                    onStash={(paths) => void stashFiles(paths)}
                    onTakeSide={(path, side) => void takeSide(path, side)}
                    onMarkResolved={(path) => stage([path])}
                    onReopenConflict={(path) => void reopenConflict(path)}
                    onOpenSubmodule={openSubmodule}
                    closeMenu={closeMenu}
                  />,
                );
              }}
              // An unstaged (formerly staged) resolution that still holds
              // markers keeps the conflict triangle; genuinely Conflicted
              // rows already derive it from their status. Submodule rows
              // fall back to the fork glyph.
              renderFileIcon={(f) =>
                opActive && f.change !== "Conflicted" && unstagedMarkerSet.has(f.path) ? (
                  <span
                    title="File content still contains conflict markers"
                    style={{ display: "inline-flex", color: "var(--status-conflicted)" }}
                  >
                    <WarningIcon size={iconSize} />
                  </span>
                ) : (
                  submoduleFileIcon(f)
                )
              }
              renderBadge={(f) => {
                const d = driftByPath.get(f.path);
                if (d) {
                  return (
                    <span
                      className="legit-subtle"
                      title={caseDriftTitle(d)}
                      style={{
                        fontSize: "var(--fz-xs)",
                        border: "1px solid var(--panel-border)",
                        borderRadius: 3,
                        padding: "0 0.35em",
                        whiteSpace: "nowrap",
                      }}
                    >
                      case
                    </span>
                  );
                }
                if (!chipsEnabled) return null;
                const entry = eolMap.get(f.path);
                return entry ? (
                  <LineEndingRowBadge repoId={repo.id} entry={entry} side="unstaged" disabled={busy} />
                ) : null;
              }}
              renderActions={(f) => {
                const d = driftByPath.get(f.path);
                if (d) {
                  return (
                    <IconButton title="Stage rename" disabled={busy} onClick={() => stage([d.disk_path])}>
                      <StageIcon />
                    </IconButton>
                  );
                }
                // A dirty-inside submodule has nothing stageable (the pointer
                // is unmoved) - no stage button, the row is informational.
                return f.change === "SubmoduleDirty" ? null : (
                  <IconButton title="Stage" disabled={busy} onClick={() => stage([f.path])}>
                    <StageIcon />
                  </IconButton>
                );
              }}
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
                  <FileRowMenu
                    section="staged"
                    file={f}
                    targets={targets}
                    opActive={opActive}
                    reopenable={reopenable}
                    conflictKinds={conflictKinds}
                    stashable={opActive ? [] : stashablePaths(staged, targets)}
                    onPrimary={unstage}
                    onDiscard={() => {}}
                    onStash={(paths) => void stashFiles(paths)}
                    onTakeSide={() => {}}
                    onMarkResolved={() => {}}
                    onReopenConflict={(path) => void reopenConflict(path)}
                    onOpenSubmodule={openSubmodule}
                    closeMenu={closeMenu}
                  />,
                );
              }}
              // A staged resolution that still holds conflict markers keeps
              // reading as conflicted: the warning triangle replaces the
              // status icon, same position and colour as during the conflict.
              // Submodule rows fall back to the fork glyph.
              renderFileIcon={(f) =>
                opActive && stagedMarkerSet.has(f.path) ? (
                  <span
                    title="Staged content still contains conflict markers"
                    style={{ display: "inline-flex", color: "var(--status-conflicted)" }}
                  >
                    <WarningIcon size={iconSize} />
                  </span>
                ) : (
                  submoduleFileIcon(f)
                )
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
          const blocks: Record<WorkingChangesSection, ReactNode> = {
            unstaged: unstagedSection,
            staged: stagedSection,
            commit: (
              <CommitComposer
                key="commit"
                repo={repo}
                stagedCount={staged.length}
                busy={busy}
                run={run}
                eolChanges={eolChanges}
                warnEolCommit={warnEolCommit}
              />
            ),
          };
          // Render sections top-to-bottom in the user's order. When there are
          // no changes, the two file lists collapse into a single "No changes"
          // filler shown in the first list slot; the commit composer keeps its
          // ordered position. Synthetic case-drift rows count as changes: they
          // are actionable even on an otherwise clean tree.
          const hasRows = status.length > 0 || driftByPath.size > 0;
          let emptyShown = false;
          return sectionOrder.map((id) => {
            if (id !== "commit" && !hasRows) {
              if (emptyShown) return null;
              emptyShown = true;
              return (
                <div key="empty" className="legit-panel__body" style={{ flex: 1 }}>
                  <span className="legit-subtle">No changes.</span>
                </div>
              );
            }
            if (id === sashBeforeId && hasRows) {
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
