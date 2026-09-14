import { useQuery } from "@tanstack/react-query";
import { repoOpState } from "./commands";
import type { RepoOpState } from "./types";
import { STALE } from "./queryTiming";

/** Query domains every merge/rebase mutation must refresh. */
export const OP_DOMAINS = ["status", "log", "branches", "diff", "op_state"] as const;

/**
 * The repo's current multi-step operation state (merge/rebase/... in
 * progress). Watcher-driven via the "op_state" domain; `null` while loading
 * or without a repo.
 */
export function useOpState(repoId: string | undefined): RepoOpState | null {
  const { data } = useQuery<RepoOpState>({
    queryKey: [repoId, "op_state"],
    queryFn: () => repoOpState(repoId!),
    enabled: !!repoId,
    staleTime: STALE.live,
  });
  return data ?? null;
}
