import type { Branch } from "./types";

export interface RemoteBranchGroup {
  remote: string;
  branches: Branch[];
}

/**
 * Group remote-tracking branches by remote for the Branches panel.
 *
 * Remote names are matched by longest prefix against the known remotes
 * (a remote name can itself contain "/", so splitting the branch name on the
 * first slash is not enough). Branches whose prefix matches no known remote
 * fall back to their first path segment so nothing drops out of the list
 * (e.g. a branch left behind by a since-removed remote).
 *
 * Group order follows the given remotes order (git's own listing order);
 * fallback-derived groups are appended alphabetically.
 */
export function groupRemoteBranches(
  remoteBranches: Branch[],
  remotes: readonly string[],
): RemoteBranchGroup[] {
  const longestFirst = [...remotes].sort((a, b) => b.length - a.length);
  const byRemote = new Map<string, Branch[]>();
  for (const branch of remoteBranches) {
    const remote =
      longestFirst.find((r) => branch.name.startsWith(`${r}/`)) ??
      branch.name.split("/", 1)[0];
    const group = byRemote.get(remote);
    if (group) group.push(branch);
    else byRemote.set(remote, [branch]);
  }

  const groups: RemoteBranchGroup[] = [];
  for (const remote of remotes) {
    const branches = byRemote.get(remote);
    if (branches) {
      groups.push({ remote, branches });
      byRemote.delete(remote);
    }
  }
  const leftovers = [...byRemote.keys()].sort((a, b) => a.localeCompare(b));
  for (const remote of leftovers) {
    groups.push({ remote, branches: byRemote.get(remote)! });
  }
  return groups;
}

/** Branch name without its remote prefix ("origin/feat/x" → "feat/x"). */
export function shortRemoteBranchName(name: string, remote: string): string {
  return name.startsWith(`${remote}/`) ? name.slice(remote.length + 1) : name;
}
