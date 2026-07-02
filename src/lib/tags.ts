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
