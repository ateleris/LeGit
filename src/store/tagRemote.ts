// Per-repo tag-remote choice, shared by every consumer of the "pushed" tag
// indicator (the Tags section's selector sets it; the Commits panel reads it
// too). Keeping the choice in one store means both panels resolve the SAME
// effective remote (via `resolveTagRemote`) and share one `remote-tags`
// query. Persisted best-effort in localStorage (same pattern as the Branches
// panel's collapsed-remotes set) so the choice survives restarts.

import { create } from "zustand";
import type { RepoId } from "../lib/types";

const STORAGE_KEY = "legit.tag-remote-choice";

function loadChoices(): Record<RepoId, string> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

interface TagRemoteStore {
  /** Per-repo chosen remote name, keyed by RepoId. Absent = no explicit
   *  choice (resolveTagRemote falls back to the default). A stale name
   *  (remote removed) is kept but ignored by the resolver. */
  choices: Record<RepoId, string>;
  setChoice: (repoId: RepoId, remote: string) => void;
}

export const useTagRemoteStore = create<TagRemoteStore>((set) => ({
  choices: loadChoices(),
  setChoice: (repoId, remote) =>
    set((s) => {
      const next = { ...s.choices, [repoId]: remote };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // best-effort persistence only
      }
      return { choices: next };
    }),
}));

/** The user's tag-remote choice for a repo, or null when none was made.
 *  Feed this into `resolveTagRemote` together with the live remote list. */
export function useTagRemoteChoice(repoId: RepoId | undefined): string | null {
  return useTagRemoteStore((s) => (repoId ? s.choices[repoId] ?? null : null));
}
