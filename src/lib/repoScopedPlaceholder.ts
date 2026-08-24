import type { RepoId } from "./types";

/**
 * `placeholderData` for repo-keyed queries (key shape `[repoId, ...]`):
 * keep the previous query's data across a key change ONLY while it belongs
 * to the same repo.
 *
 * Plain `keepPreviousData` carries data across ANY key change, including the
 * repo-id slot - switching repos briefly rendered the previously selected
 * repo's commit graph whenever the new repo's data wasn't cached yet
 * (regression pinned in repoScopedPlaceholder.test.ts). Scoping to the repo
 * keeps the intended benefit (a grown page size or flipped filter does not
 * collapse the list to empty) without ever showing another repo's data.
 */
export function keepPreviousDataForRepo<T>(repoId: RepoId | undefined) {
  return (
    prev: T | undefined,
    prevQuery: { queryKey: readonly unknown[] } | undefined,
  ): T | undefined =>
    repoId !== undefined && prevQuery?.queryKey[0] === repoId ? prev : undefined;
}
