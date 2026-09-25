// The Working Changes panel's data layer: every query and pure derivation
// over the repo's status, so the panel component holds only view state and
// action handlers.

import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/commands";
import type { CaseDriftEntry, ConflictEntry, FileStatus } from "../../lib/types";
import { useOpState } from "../../lib/useOpState";
import { STALE } from "../../lib/queryTiming";
import { useStatus, useSubmodules } from "../../lib/queries/useRepoQueries";
import { useLineEndingStatusMap } from "../shared/lineEndingStatus";
import type { FileTreeEntry } from "../shared/FileTree/buildTree";
import { isSubmodulePath, submodulePathSet } from "./submoduleRows";
import { stagedEolChanges } from "./lineEndingWarning";
import { caseDriftByPath, withCaseDriftRows } from "./caseDrift";
import type { Section as ListSection } from "./selection";

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

export function useWorkingChangesData(args: {
  repoId: string | undefined;
  /** Line-ending summary wanted (chips or the commit warning enabled). */
  eolEnabled: boolean;
  detectCaseRenames: boolean;
}) {
  const { repoId, eolEnabled, detectCaseRenames } = args;

  const {
    data: status = [],
    isFetching,
    isError,
    error,
    refetch,
  } = useStatus(repoId);

  // Known submodule paths (gitlinked, or declared in .gitmodules but never
  // added) drive the fork-glyph icon override, so a to-be-added submodule
  // never reads as a plain new file.
  const { data: submodules = [] } = useSubmodules(repoId);
  const submodulePaths = useMemo(() => submodulePathSet(submodules), [submodules]);

  // Batch line-ending summary - drives the row chips and the commit
  // warning. Disabled entirely when both features are off.
  const eolMap = useLineEndingStatusMap(repoId, eolEnabled);

  const staged = useMemo(() => status.filter((s) => s.staged).map(toEntry), [status]);
  const unstaged = useMemo(() => status.filter((s) => !s.staged).map(toEntry), [status]);

  // Case-only rename drift: renames git status cannot see (case-insensitive
  // filesystems). Surfaced as synthetic rename rows in the Unstaged list with
  // a "Stage rename" action; the backend returns [] on case-sensitive
  // filesystems without scanning. Invalidated via the derived "case_drift"
  // domain, so the repo-open catch-up refresh also covers renames made while
  // the app was closed.
  const { data: caseDrift = [] } = useQuery<CaseDriftEntry[]>({
    queryKey: [repoId, "case_drift"],
    queryFn: () => api.repoCaseDrift(repoId!),
    enabled: !!repoId && detectCaseRenames,
    staleTime: STALE.live,
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
  // The panel-wide file count is unique paths - a partially staged file has an
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
  // merge/rebase banner itself is app chrome (OpStateStrip in AppLayout).
  const conflictCount = useMemo(
    () => status.filter((s) => s.state === "Conflicted").length,
    [status],
  );

  // An in-progress op gates the resolution-safety features below: that's the
  // window where staged conflict markers are accidents and git's resolve-undo
  // record exists. All three queries are idle otherwise.
  const opState = useOpState(repoId);
  const opActive = !!opState && opState.kind !== "none";

  // Files whose content still holds leftover conflict markers - the
  // "accidentally marked resolved" warning. Checked on both sides so the
  // warning follows the file when it is unstaged again; on the unstaged side
  // it only decorates non-Conflicted rows (conflicts already show as such).
  const { data: stagedMarkerPaths = [] } = useQuery<string[]>({
    queryKey: [repoId, "status", "staged-markers"],
    queryFn: () => api.repoStagedMarkerPaths(repoId!),
    enabled: !!repoId && opActive,
    staleTime: STALE.live,
  });
  const stagedMarkerSet = useMemo(() => new Set(stagedMarkerPaths), [stagedMarkerPaths]);
  const { data: unstagedMarkerPaths = [] } = useQuery<string[]>({
    queryKey: [repoId, "status", "unstaged-markers"],
    queryFn: () => api.repoUnstagedMarkerPaths(repoId!),
    enabled: !!repoId && opActive,
    staleTime: STALE.live,
  });
  const unstagedMarkerSet = useMemo(() => new Set(unstagedMarkerPaths), [unstagedMarkerPaths]);

  // Paths whose conflict was resolved & staged during this op (git's
  // resolve-undo record) - eligible for "Reopen conflict".
  const { data: undoPaths = [] } = useQuery<string[]>({
    queryKey: [repoId, "op_state", "resolve-undo"],
    queryFn: () => api.repoResolveUndoPaths(repoId!),
    enabled: !!repoId && opActive,
    staleTime: STALE.live,
  });
  const reopenable = useMemo(() => new Set(undoPaths), [undoPaths]);

  // Conflict kinds for delete-aware Take-ours/theirs labels; only fetched
  // while conflicts exist (the cheap ls-files -u otherwise never runs).
  const { data: conflictEntries = [] } = useQuery<ConflictEntry[]>({
    queryKey: [repoId, "op_state", "conflicts"],
    queryFn: () => api.repoConflictEntries(repoId!),
    enabled: !!repoId && conflictCount > 0,
    staleTime: STALE.live,
  });
  const conflictKinds = useMemo(
    () => new Map(conflictEntries.map((e) => [e.path, e.kind])),
    [conflictEntries],
  );

  // The entry backing a row, preferring the clicked section's side (a
  // partially-staged file has one entry per section under the same path).
  const entryFor = useCallback(
    (section: ListSection, path: string): FileStatus | undefined =>
      status.find((s) => s.path === path && s.staged === (section === "staged")) ??
      status.find((s) => s.path === path),
    [status],
  );

  return {
    status,
    isFetching,
    isError,
    error,
    refetch,
    submodulePaths,
    eolMap,
    staged,
    unstaged,
    caseDrift,
    driftByPath,
    unstagedWithDrift,
    stagedPathSet,
    eolChanges,
    stagedTotals,
    unstagedTotals,
    totals,
    conflictCount,
    opActive,
    stagedMarkerSet,
    unstagedMarkerSet,
    reopenable,
    conflictKinds,
    entryFor,
  };
}
