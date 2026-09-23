import type { ChangeDomain } from "../types";

const CHANGE_DOMAIN_TABLE: Record<ChangeDomain, true> = {
  status: true,
  log: true,
  branches: true,
  stashes: true,
  tags: true,
  diff: true,
  op_state: true,
  submodules: true,
  worktrees: true,
};

/** Every domain the filesystem watcher can emit. */
export const CHANGE_DOMAINS = Object.keys(CHANGE_DOMAIN_TABLE) as readonly ChangeDomain[];

/** Query-key domains the watcher never emits: refreshed by in-app actions,
 *  derived from watcher domains (`withDerivedDomains`), or keyed only. */
export const FRONTEND_DOMAINS = [
  "remotes",
  "tracking",
  "unpushed",
  "identity",
  "remote-tags",
  "lfs",
  "case_drift",
  "commit-files",
  "commit-details",
  "sig-presence",
  "files-at",
  "superproject",
  "submodule-log",
] as const;

/** The second element of every repo-scoped query key `[repoId, domain, ...]`. */
export type QueryDomain = ChangeDomain | (typeof FRONTEND_DOMAINS)[number];

export const QUERY_DOMAINS: readonly QueryDomain[] = [...CHANGE_DOMAINS, ...FRONTEND_DOMAINS];

export function isQueryDomain(value: string): value is QueryDomain {
  return (QUERY_DOMAINS as readonly string[]).includes(value);
}

/** Every merge/rebase mutation. */
export const OP_DOMAINS = ["status", "log", "branches", "diff", "op_state"] as const satisfies readonly QueryDomain[];

/** Anything that moves HEAD (reflog restore, interactive rebase): the op
 *  domains plus tracking, and stashes for the rebase's --autostash. */
export const HEAD_MOVE_DOMAINS = [...OP_DOMAINS, "tracking", "stashes"] as const satisfies readonly QueryDomain[];

/** Branch create/switch/rename/delete; switching can create or consume an
 *  auto-stash, so "stashes" is included. */
export const BRANCH_DOMAINS = ["branches", "log", "status", "tracking", "stashes"] as const satisfies readonly QueryDomain[];

/** Push/pull/fetch move remote-tracking refs; "tags" because each tag's
 *  `target_on_remote` flag is computed against them. */
export const SYNC_DOMAINS = ["log", "branches", "status", "tracking", "tags"] as const satisfies readonly QueryDomain[];

/** A stash mutation touches the working tree, the stash list, and the graph. */
export const STASH_DOMAINS = ["stashes", "log", "status"] as const satisfies readonly QueryDomain[];

/** A tag mutation touches the tag list and the graph decorations. */
export const TAG_DOMAINS = ["tags", "log"] as const satisfies readonly QueryDomain[];

/** Submodule ops touch the list, the status view, and (after an update moves
 *  pointers) the log decorations. */
export const SUBMODULE_DOMAINS = ["submodules", "status", "log"] as const satisfies readonly QueryDomain[];

/** Remote add/edit/remove: the list itself plus what the sync toolbar
 *  derives from it (branches, ahead/behind, log decorations). */
export const REMOTE_DOMAINS = ["remotes", "branches", "tracking", "log"] as const satisfies readonly QueryDomain[];

export const NAMED_DOMAIN_SETS = {
  OP_DOMAINS,
  HEAD_MOVE_DOMAINS,
  BRANCH_DOMAINS,
  SYNC_DOMAINS,
  STASH_DOMAINS,
  TAG_DOMAINS,
  SUBMODULE_DOMAINS,
  REMOTE_DOMAINS,
} as const;
