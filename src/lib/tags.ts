// Pure tag helpers shared by the Commits panel (chip indicators) and the
// Tags section of the Refs panel.

import type { Remote, RemoteTag, TagInfo } from "./types";

/**
 * The set of local tag names that exist on the remote *with the same target
 * commit*. A same-named remote tag pointing elsewhere is NOT "pushed" — the
 * indicator would misleadingly suggest the remote has this tag's content.
 */
export function pushedTagNames(local: TagInfo[], remote: RemoteTag[]): Set<string> {
  const remoteByName = new Map(remote.map((t) => [t.name, t.target_sha]));
  const pushed = new Set<string>();
  for (const tag of local) {
    if (remoteByName.get(tag.name) === tag.target_sha) pushed.add(tag.name);
  }
  return pushed;
}

/** The remote tags are pushed to / checked against: `origin` if configured,
 *  else the first remote, else null (no remotes — tag push unavailable). */
export function pickTagRemote(remotes: Remote[]): string | null {
  if (remotes.length === 0) return null;
  return remotes.some((r) => r.name === "origin") ? "origin" : remotes[0].name;
}

/**
 * The effective tag remote given the user's per-repo choice: the choice if it
 * still names an existing remote, else the `pickTagRemote` default. A stale
 * choice (remote removed/renamed) falls back rather than erroring. Shared by
 * the Commits panel and the Tags section so their "pushed" indicators (and
 * the `remote-tags` query key) always agree.
 */
export function resolveTagRemote(
  choice: string | null | undefined,
  remotes: Remote[],
): string | null {
  if (choice && remotes.some((r) => r.name === choice)) return choice;
  return pickTagRemote(remotes);
}
