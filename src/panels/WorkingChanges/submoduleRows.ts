// Decision logic for the working-changes submodule icon override: a status
// row addressing a submodule renders the fork glyph instead of its per-state
// file icon, so a to-be-added submodule never reads as a plain new file.

import type { SubmoduleInfo } from "../../lib/types";

/** Paths of all known submodules: gitlinked, or declared in .gitmodules but
 * never added (recorded_sha null). */
export function submodulePathSet(subs: SubmoduleInfo[]): Set<string> {
  return new Set(subs.map((s) => s.path));
}

/** Whether a status row addresses a submodule. Git reports an untracked
 * submodule directory in collapsed form with a trailing slash. */
export function isSubmodulePath(path: string, submodulePaths: ReadonlySet<string>): boolean {
  return submodulePaths.has(path.endsWith("/") ? path.slice(0, -1) : path);
}
