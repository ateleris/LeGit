import { shortRemoteBranchName, type RemoteBranchGroup } from "./branchGroups";

export function matchesRefFilter(text: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return text.toLowerCase().includes(q);
}

/** Filters each group's branches by their short name; empty groups drop out. */
export function filterRemoteGroups(
  groups: RemoteBranchGroup[],
  query: string,
): RemoteBranchGroup[] {
  if (!query.trim()) return groups;
  return groups
    .map((g) => ({
      remote: g.remote,
      branches: g.branches.filter((b) =>
        matchesRefFilter(shortRemoteBranchName(b.name, g.remote), query),
      ),
    }))
    .filter((g) => g.branches.length > 0);
}
