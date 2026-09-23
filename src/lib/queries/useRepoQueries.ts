import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import {
  repoBranches,
  repoLfsStatus,
  repoListRemotes,
  repoRemoteTags,
  repoStashes,
  repoStatus,
  repoSubmodules,
  repoTags,
  repoTrackingStatus,
  repoWorktreeList,
} from "../commands";
import type {
  Branch,
  FileStatus,
  LfsStatus,
  Remote,
  RemoteTag,
  StashEntry,
  SubmoduleInfo,
  TagInfo,
  TrackingStatus,
  WorktreeInfo,
} from "../types";
import { STALE } from "../queryTiming";
import { repoKeys } from "./keys";

type RepoId = string | undefined | null;

export interface RepoQueryOptions {
  /** ANDed with "a repo id is present". */
  enabled?: boolean;
}

function useRepoQuery<T>(
  queryKey: readonly unknown[],
  repoId: RepoId,
  fetch: (repoId: string) => Promise<T>,
  staleTime: (typeof STALE)[keyof typeof STALE],
  opts: RepoQueryOptions | undefined,
): UseQueryResult<T> {
  return useQuery<T>({
    queryKey,
    queryFn: () => fetch(repoId!),
    enabled: !!repoId && (opts?.enabled ?? true),
    staleTime,
  });
}

export const useStatus = (repoId: RepoId, opts?: RepoQueryOptions) =>
  useRepoQuery<FileStatus[]>(repoKeys.status(repoId), repoId, repoStatus, STALE.live, opts);

export const useBranches = (repoId: RepoId, opts?: RepoQueryOptions) =>
  useRepoQuery<Branch[]>(repoKeys.branches(repoId), repoId, repoBranches, STALE.live, opts);

export const useRemotes = (repoId: RepoId, opts?: RepoQueryOptions) =>
  useRepoQuery<Remote[]>(repoKeys.remotes(repoId), repoId, repoListRemotes, STALE.live, opts);

export const useTags = (repoId: RepoId, opts?: RepoQueryOptions) =>
  useRepoQuery<TagInfo[]>(repoKeys.tags(repoId), repoId, repoTags, STALE.live, opts);

export const useTracking = (repoId: RepoId, opts?: RepoQueryOptions) =>
  useRepoQuery<TrackingStatus | null>(repoKeys.tracking(repoId), repoId, repoTrackingStatus, STALE.live, opts);

export const useStashes = (repoId: RepoId, opts?: RepoQueryOptions) =>
  useRepoQuery<StashEntry[]>(repoKeys.stashes(repoId), repoId, repoStashes, STALE.live, opts);

export const useWorktrees = (repoId: RepoId, opts?: RepoQueryOptions) =>
  useRepoQuery<WorktreeInfo[]>(repoKeys.worktrees(repoId), repoId, repoWorktreeList, STALE.live, opts);

export const useSubmodules = (repoId: RepoId, opts?: RepoQueryOptions) =>
  useRepoQuery<SubmoduleInfo[]>(repoKeys.submodules(repoId), repoId, repoSubmodules, STALE.live, opts);

/** Rare-change data (.gitattributes edits, LFS installs): deliberately not
 *  watcher-invalidated; callers offer an explicit re-check. */
export const useLfsStatus = (repoId: RepoId, opts?: RepoQueryOptions) =>
  useRepoQuery<LfsStatus>(repoKeys.lfs(repoId), repoId, repoLfsStatus, STALE.rare, opts);

/** `git ls-remote --tags`: a network call, so long staleTime and no retry. */
export function useRemoteTags(repoId: RepoId, remote: string | null): UseQueryResult<RemoteTag[]> {
  return useQuery<RemoteTag[]>({
    queryKey: repoKeys.remoteTags(repoId, remote),
    queryFn: () => repoRemoteTags(repoId!, remote!, crypto.randomUUID()),
    enabled: !!repoId && remote !== null,
    staleTime: STALE.rare,
    retry: false,
  });
}
