import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { repoLog } from "../../lib/commands";
import { STALE } from "../../lib/queryTiming";
import { useActiveRepo, useRepoStore } from "../../store/repos";
import { useSummonStore } from "../../store/summon";
import { shouldYieldSlotToWorkingChanges } from "../shared/repoSlotSync";
import type { Commit, CommitId } from "../../lib/types";

/**
 * While Changed Files is open with nothing delivered, probe whether the active
 * repo has any commit at all; a verifiably commit-less repo (unborn HEAD)
 * yields the shared slot to Working Changes - the panel a fresh init needs -
 * since the log offers nothing to select. Covers every way the panel can be
 * on screen: startup layout restore, a repo tab switch, and a View menu open.
 *
 * Returns the yield decision so the caller can adapt its empty state while
 * the swap is suppressed ("Auto-open panels" opt-out leaves the panel open).
 */
export function useYieldSlotWhenNoCommits(selectedId: CommitId | null): boolean {
  const repo = useActiveRepo();
  // Mirrors the Commits panel's walk: with remote branches hidden, a log that
  // shows no commits offers nothing to select even if remotes have some.
  const showRemoteBranches =
    useRepoStore((s) => (repo ? s.repoSettings[repo.id]?.show_remote_branches : null)) ?? true;

  const { data, isSuccess, isFetching } = useQuery<Commit[]>({
    // The [repoId, "log", ...] prefix keeps the probe fresh through the
    // watcher's log-domain invalidations (the first commit re-probes).
    queryKey: [repo?.id, "log", "head-probe", showRemoteBranches],
    queryFn: () => repoLog(repo!.id, 1, 0, undefined, showRemoteBranches),
    enabled: !!repo && selectedId === null,
    staleTime: STALE.live,
  });

  const yieldSlot = shouldYieldSlotToWorkingChanges({
    logLoaded: isSuccess,
    fetching: isFetching,
    commitShown: selectedId !== null,
    hasCommits: (data?.length ?? 0) > 0,
  });

  useEffect(() => {
    if (!yieldSlot) return;
    useSummonStore.getState().swapSummon("working-changes", "changed-files", null);
  }, [yieldSlot]);

  return yieldSlot;
}
