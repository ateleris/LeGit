import type { FileHistoryEntry } from "../lib/types";

/** Which history entry the window shows after a (re)load: the current one
 *  while it still exists (matched by sha + path, both shift on rewrites),
 *  else the newest. */
export function nextSelection(
  entries: FileHistoryEntry[],
  current: FileHistoryEntry | null,
): FileHistoryEntry | null {
  if (entries.length === 0) return null;
  if (current) {
    const still = entries.find(
      (x) => x.commit_id === current.commit_id && x.path === current.path,
    );
    if (still) return still;
  }
  return entries[0];
}
