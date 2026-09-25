import { useQuery, type QueryClient } from "@tanstack/react-query";
import { api } from "./commands";
import type { GitProfile } from "./types";
import { STALE } from "./queryTiming";

/**
 * Single shared cache entry for the global profile list. Every consumer
 * (Global Settings, Repo Settings, clone/init forms) reads this query, and
 * every profile mutation calls `invalidateGitProfiles`, so no panel can hold
 * a stale copy. Repo-scoped keys are `[repoId, domain]` with UUID repo ids,
 * so the literal "global" cannot collide.
 */
export const GIT_PROFILES_KEY = ["global", "profiles"];

export function useGitProfiles() {
  return useQuery<GitProfile[]>({
    queryKey: GIT_PROFILES_KEY,
    queryFn: api.listGitProfiles,
    staleTime: STALE.live,
  });
}

/** Call after any mutation that changes the profile set (create/update/delete,
 *  create-from-repo). Refetches the list in every mounted consumer. */
export function invalidateGitProfiles(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: GIT_PROFILES_KEY });
}
