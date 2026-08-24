import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRepoStore } from "../../store/repos";
import { useTagRemoteChoice } from "../../store/tagRemote";
import { keepPreviousDataForRepo } from "../../lib/repoScopedPlaceholder";
import {
  repoBranches,
  repoListRemotes,
  repoLog,
  repoRemoteTags,
  repoResolveCommit,
  repoSearchCommits,
  repoSignaturePresence,
  repoStatus,
  repoTags,
  repoTrackingStatus,
} from "../../lib/commands";
import { pushedTagNames, resolveTagRemote } from "../../lib/tags";
import { buildUpstreamMap } from "./commitRows";
import { mergeSearchResults } from "./commitSearch";
import type {
  Branch,
  Commit,
  CommitId,
  FileStatus,
  Remote,
  RemoteTag,
  RepoSummary,
  TagInfo,
  TrackingStatus,
} from "../../lib/types";

/** Full-history search result cap (matches the removed Search panel). */
export const SEARCH_MAX_RESULTS = 1000;

export interface CommitsQueryParams {
  /** Size of the log window (grows with infinite scroll / jump seeks). */
  totalToFetch: number;
  /** Restrict the walk to commits reachable from this ref (null = full). */
  branchFilter: string | null;
  /** Restrict the walk to one author (matched by email). */
  authorFilter: { name: string; email: string } | null;
  /** Submitted toolbar search (null = no active search). */
  search: { query: string } | null;
  /** The Signed column is visible (gates the signature-presence pass). */
  signedColumnVisible: boolean;
}

/**
 * Every react-query read the Commits panel makes, plus the memos derived
 * directly from that data. Extracted from CommitsPanel.tsx (2026-08-24
 * structural split); behavior-preserving - keys, staleTimes, and the
 * repo-scoped placeholders are unchanged.
 */
export function useCommitsQueries(
  repo: RepoSummary | null,
  { totalToFetch, branchFilter, authorFilter, search, signedColumnVisible }: CommitsQueryParams,
) {
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
    // Scoped to the repo: an unscoped keepPreviousData flashed the previously
    // selected repo's graph after a repo switch while the new walk loaded.
    placeholderData: keepPreviousDataForRepo<Commit[]>(repo?.id),
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
    placeholderData: keepPreviousDataForRepo<CommitId[]>(repo?.id),
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
  // `currentBranch` Branch object in the panel, which drives reword gating.)
  const currentBranchName = useMemo(
    () => branches.find((b) => !b.is_remote && b.is_current)?.name ?? null,
    [branches],
  );

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

  // Signature PRESENCE for the Signed column - pay-per-view: queried only
  // while the column is visible, as a second pass so the list itself renders
  // without waiting (and without the extra subprocess when hidden). Presence
  // is immutable per SHA, hence staleTime: Infinity and no watcher
  // invalidation; new commits change the key, and the backend's per-SHA cache
  // makes that refetch pay only for unseen SHAs. keepPreviousData stops the
  // chips from blinking out while the refetch runs.
  const commitIds = useMemo(() => commits.map((c) => c.id), [commits]);
  const { data: signedIds } = useQuery<CommitId[]>({
    queryKey: [repo?.id, "sig-presence", commitIds],
    queryFn: () => repoSignaturePresence(repo!.id, commitIds),
    enabled: !!repo && signedColumnVisible && commitIds.length > 0,
    staleTime: Infinity,
    placeholderData: keepPreviousDataForRepo<CommitId[]>(repo?.id),
  });
  const signedSet = useMemo(() => new Set(signedIds ?? []), [signedIds]);

  return {
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
    currentBranchName,
    tags,
    remotesList,
    tagRemote,
    remoteNames,
    pushedTags,
    tagTargetsOnRemote,
    signedSet,
  };
}
