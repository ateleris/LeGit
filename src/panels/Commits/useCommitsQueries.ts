import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRepoStore } from "../../store/repos";
import { useTagRemoteChoice } from "../../store/tagRemote";
import { keepPreviousDataForRepo } from "../../lib/repoScopedPlaceholder";
import { repoLog, api } from "../../lib/commands";
import { pushedTagNames, resolveTagRemote } from "../../lib/tags";
import { appendLogPage, countRealCommits } from "./logPaging";
import { buildUpstreamMap } from "./commitRows";
import { branchWorktreeMap, detachedWorktreeHeads } from "../Worktrees/worktreeRows";
import { mergeSearchResults } from "./commitSearch";
import type {
  Branch,
  Commit,
  CommitId,
  RepoSummary,
} from "../../lib/types";
import { STALE } from "../../lib/queryTiming";
import {
  useBranches,
  useRemoteTags,
  useRemotes,
  useStatus,
  useTags,
  useTracking,
  useWorktrees,
} from "../../lib/queries/useRepoQueries";

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

  // The window size is NOT part of the key: growing it appends only the
  // missing tail (the load-more effect below) instead of refetching the
  // whole window from offset 0 - O(n) instead of O(n^2) total work when
  // scrolling deep into history.
  const queryKey = useMemo(
    () => [repo?.id, "log", showRemoteBranches, branchFilter, authorFilter?.email],
    [repo?.id, showRemoteBranches, branchFilter, authorFilter?.email],
  );
  const queryClient = useQueryClient();

  const fetchLog = useCallback(
    (maxCount: number, skip: number) =>
      repoLog(
        repo!.id,
        maxCount,
        skip,
        branchFilter ?? undefined,
        showRemoteBranches,
        authorFilter?.email,
        // Branch filter: still show stashes BASED ON commits in the walk
        // (they hang off their base like in the full graph).
        branchFilter !== null ? true : undefined,
      ),
    [repo?.id, branchFilter, showRemoteBranches, authorFilter?.email],
  );

  // The queryFn reads the CURRENT window size through a ref: a watcher or
  // manual invalidation must reload everything the user has scrolled to, in
  // one request (refs may have moved, so offsets into the old walk are void).
  const totalRef = useRef(totalToFetch);
  totalRef.current = totalToFetch;

  // False until a fetch returns fewer real commits than it asked for - then
  // the walk is exhausted and growing the window cannot load more (until a
  // full fetch replaces the data and re-decides).
  const [exhausted, setExhausted] = useState(false);

  const {
    data: commits = [],
    isFetching: logFetching,
    isError,
    error,
    dataUpdatedAt,
  } = useQuery<Commit[]>({
    queryKey,
    queryFn: async () => {
      const requested = totalRef.current;
      const page = await fetchLog(requested, 0);
      setExhausted(countRealCommits(page) < requested);
      return page;
    },
    enabled: !!repo,
    staleTime: STALE.live,
    // Keep the previous rows rendered while a filter/setting change (new
    // query key) fetches. Without this the new key has no cached data, the
    // list collapses to zero height, and the scroll position jumps back to
    // the top. Scoped to the repo: an unscoped keepPreviousData flashed the
    // previously selected repo's graph after a repo switch while the new
    // walk loaded.
    placeholderData: keepPreviousDataForRepo<Commit[]>(repo?.id),
  });

  // Grow the window by appending: when the panel raises totalToFetch beyond
  // what is loaded, fetch ONLY the missing tail at its offset and merge it
  // into the cached window (`appendLogPage` reconciles the injected stash
  // nodes at the seam). A full refetch that lands while the page is in
  // flight wins - its dataUpdatedAt changes and the stale append is dropped.
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);
  useEffect(() => {
    if (!repo || logFetching || loadingMoreRef.current || exhausted) return;
    const loaded = countRealCommits(commits);
    if (loaded === 0 || totalToFetch <= loaded) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    const need = totalToFetch - loaded;
    void (async () => {
      try {
        const page = await fetchLog(need, loaded);
        if (queryClient.getQueryState(queryKey)?.dataUpdatedAt !== dataUpdatedAt) return;
        if (countRealCommits(page) < need) setExhausted(true);
        queryClient.setQueryData<Commit[]>(queryKey, (old = []) => appendLogPage(old, page));
      } catch {
        // Growth is best-effort: fall back to a full refetch, which heals a
        // transient failure or surfaces a persistent one as the query error.
        void queryClient.invalidateQueries({ queryKey });
      } finally {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    })();
  }, [
    repo,
    logFetching,
    exhausted,
    commits,
    totalToFetch,
    fetchLog,
    queryClient,
    queryKey,
    dataUpdatedAt,
  ]);

  const isFetching = logFetching || loadingMore;
  // More commits may exist until some fetch came back short; the injected
  // stash nodes never count toward a page (only real commits are capped by
  // `--max-count`).
  const hasMore = !exhausted;

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
        api.repoResolveCommit(repo!.id, query).catch(() => null),
        api.repoSearchCommits(repo!.id, query, "message", SEARCH_MAX_RESULTS),
        api.repoSearchCommits(repo!.id, query, "author", SEARCH_MAX_RESULTS),
      ]);
      const ids = mergeSearchResults(byMessage, byAuthor)
        .map((c) => c.id)
        .filter((id) => id !== resolved);
      return resolved ? [resolved, ...ids] : ids;
    },
    enabled: !!repo && search !== null,
    staleTime: STALE.appDefault,
    placeholderData: keepPreviousDataForRepo<CommitId[]>(repo?.id),
  });

  // Branch list (for upstream tracking). Drives chip fusion: a local branch
  // and its configured upstream remote collapse into one chip when both sit on
  // the same commit.
  const { data: branches = [] } = useBranches(repo?.id);

  // Ahead/behind vs upstream — used to gate "Reword message…" (the tip commit
  // is only rewordable while it is local / not yet pushed). `null` when HEAD is
  // detached or the branch has no upstream.
  const { data: tracking } = useTracking(repo?.id);

  // Working-tree status — drives the synthetic "uncommitted changes" row.
  const { data: status = [] } = useStatus(repo?.id);

  // Unpushed set (all-remotes semantics): gates the bulk drop/squash menu
  // entries - history rewrites must only ever see unpublished commits.
  const { data: unpushedIds = [] } = useQuery<CommitId[]>({
    queryKey: [repo?.id, "unpushed"],
    queryFn: () => api.repoUnpushedCommits(repo!.id, 1000),
    enabled: !!repo,
    staleTime: STALE.live,
  });
  const unpushedSet = useMemo(() => new Set<CommitId>(unpushedIds), [unpushedIds]);

  // Partial-push eligibility (first-parent chain of `@{upstream}..HEAD`):
  // gates the "Push up to this commit" menu entry - every member fast-forwards
  // the upstream branch.
  const { data: pushableIds = [] } = useQuery<CommitId[]>({
    queryKey: [repo?.id, "pushable"],
    queryFn: () => api.repoPushableCommits(repo!.id),
    enabled: !!repo,
    staleTime: STALE.live,
  });
  const pushableSet = useMemo(() => new Set<CommitId>(pushableIds), [pushableIds]);

  // Worktree list — drives the branch chips' "checked out in another
  // worktree" indicator (kept fresh by the watcher's worktrees domain).
  const { data: worktrees = [] } = useWorktrees(repo?.id);
  const worktreeBranches = useMemo(
    () => branchWorktreeMap(worktrees, repo?.path ?? null),
    [worktrees, repo?.path],
  );
  // HEAD sha -> other worktrees sitting detached there (their only visible
  // trace in the graph - a branch checkout shows on the branch chip).
  const worktreeHeadsBySha = useMemo(
    () => detachedWorktreeHeads(worktrees, repo?.path ?? null),
    [worktrees, repo?.path],
  );

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
  const { data: tags = [] } = useTags(repo?.id);
  const { data: remotesList = [] } = useRemotes(repo?.id);
  // Same per-repo choice + resolver as the Tags section, so the "pushed"
  // indicators agree across panels and the remote-tags query is shared.
  const tagRemoteChoice = useTagRemoteChoice(repo?.id);
  const tagRemote = useMemo(
    () => resolveTagRemote(tagRemoteChoice, remotesList),
    [tagRemoteChoice, remotesList],
  );
  const remoteNames = useMemo(() => remotesList.map((r) => r.name), [remotesList]);

  const { data: remoteTags = [] } = useRemoteTags(repo?.id, tagRemote);
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
  // is immutable per SHA, hence staleTime: STALE.immutable and no watcher
  // invalidation; new commits change the key, and the backend's per-SHA cache
  // makes that refetch pay only for unseen SHAs. keepPreviousData stops the
  // chips from blinking out while the refetch runs.
  const commitIds = useMemo(() => commits.map((c) => c.id), [commits]);
  const { data: signedIds } = useQuery<CommitId[]>({
    queryKey: [repo?.id, "sig-presence", commitIds],
    queryFn: () => api.repoSignaturePresence(repo!.id, commitIds),
    enabled: !!repo && signedColumnVisible && commitIds.length > 0,
    staleTime: STALE.immutable,
    placeholderData: keepPreviousDataForRepo<CommitId[]>(repo?.id),
  });
  const signedSet = useMemo(() => new Set(signedIds ?? []), [signedIds]);

  return {
    commits,
    isFetching,
    isError,
    error,
    hasMore,
    searchHits,
    searchFetching,
    branches,
    tracking,
    status,
    upstreamMap,
    worktreeBranches,
    worktreeHeadsBySha,
    unpushedSet,
    pushableSet,
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
