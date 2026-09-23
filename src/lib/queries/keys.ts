import type { QueryDomain } from "./domains";

type RepoId = string | undefined | null;

/** Repo-scoped query keys `[repoId, domain, ...]`. `invalidateRepoDomains`
 *  matches on the first two elements, so every key must start that way. */
export const repoKeys = {
  domain: (repoId: RepoId, domain: QueryDomain) => [repoId, domain] as const,
  status: (repoId: RepoId) => [repoId, "status"] as const,
  branches: (repoId: RepoId) => [repoId, "branches"] as const,
  remotes: (repoId: RepoId) => [repoId, "remotes"] as const,
  tags: (repoId: RepoId) => [repoId, "tags"] as const,
  remoteTags: (repoId: RepoId, remote: string | null) => [repoId, "remote-tags", remote] as const,
  tracking: (repoId: RepoId) => [repoId, "tracking"] as const,
  stashes: (repoId: RepoId) => [repoId, "stashes"] as const,
  worktrees: (repoId: RepoId) => [repoId, "worktrees"] as const,
  submodules: (repoId: RepoId) => [repoId, "submodules"] as const,
  lfs: (repoId: RepoId) => [repoId, "lfs"] as const,
  opState: (repoId: RepoId) => [repoId, "op_state"] as const,
};
