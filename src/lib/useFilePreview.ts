import { useQuery } from "@tanstack/react-query";
import { repoFilePreview } from "./commands";
import type { FilePreview } from "./types";

/** Preview query for one side. Mutable specs (worktree, index) live under
 * the "status" domain so the watcher refreshes them; committed revs are
 * immutable and live under "log". */
export function useFilePreview(
  repoId: string | undefined,
  rev: string | null,
  path: string | undefined,
  enabled: boolean,
) {
  const mutable = rev === null || rev === ":" || rev === ":0";
  return useQuery<FilePreview>({
    queryKey: [repoId, mutable ? "status" : "log", "preview", rev ?? "worktree", path],
    queryFn: () => repoFilePreview(repoId!, rev, path!),
    enabled: enabled && !!repoId && !!path,
    staleTime: mutable ? 5_000 : 60_000,
  });
}
