// Wording for the .gitmodules consistency warning (composer banner). Pure so
// the guidance is pinned by unit tests, like the switch/merge feedback.

import type { GitmodulesFinding } from "../../lib/types";

/** One banner line per finding - names the broken half and its path so the
 *  fix is obvious. */
export function gitmodulesFindingLabel(f: GitmodulesFinding): string {
  if (f.kind === "entry_without_gitlink") {
    if (f.path === "") {
      return `.gitmodules section '${f.name}' has no path setting`;
    }
    return `.gitmodules section '${f.name}' points at '${f.path}', but no submodule is staged there`;
  }
  return `submodule '${f.path}' has no .gitmodules entry (clones and recursive pushes will fail on it)`;
}
