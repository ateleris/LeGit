import { create } from "zustand";
import type { GitInvocation, RepoChangedPayload } from "../lib/types";

interface EntryBase {
  id: number;
  at: number;
}

/** A logged git invocation with a client-assigned id + receipt time. */
export type CommandLogEntry = EntryBase & { kind: "command" } & GitInvocation;

/** A filesystem-watcher batch that triggered query invalidation: which repo,
 *  which domains, and the paths that classified. Interleaved with the command
 *  entries so a refetch's cause is visible next to the git calls it caused. */
export type WatcherLogEntry = EntryBase & {
  kind: "watcher";
  repo_id: string;
  domains: string[];
  trigger_paths: string[];
  trigger_count: number;
};

export type GitLogEntry = CommandLogEntry | WatcherLogEntry;

const MAX_ENTRIES = 500; // ring buffer — git is chatty (status/log/diff per action)
let nextId = 1;

interface GitLogStore {
  entries: GitLogEntry[];
  add: (inv: GitInvocation) => void;
  addWatcherBatch: (payload: RepoChangedPayload) => void;
  clear: () => void;
}

function push(entries: GitLogEntry[], entry: GitLogEntry): GitLogEntry[] {
  const next = [...entries, entry];
  if (next.length > MAX_ENTRIES) next.splice(0, next.length - MAX_ENTRIES);
  return next;
}

/** Live log of every git command the app runs (fed by the `git_invocation`
 *  backend event) plus every watcher-triggered invalidation (fed by
 *  `legit://repo-changed`). Powers the Git Log panel. */
export const useGitLogStore = create<GitLogStore>((set) => ({
  entries: [],
  add: (inv) =>
    set((s) => ({
      entries: push(s.entries, { ...inv, kind: "command", id: nextId++, at: Date.now() }),
    })),
  addWatcherBatch: (payload) =>
    set((s) => ({
      entries: push(s.entries, {
        kind: "watcher",
        id: nextId++,
        at: Date.now(),
        repo_id: payload.repo_id,
        domains: payload.domains,
        trigger_paths: payload.trigger_paths,
        trigger_count: payload.trigger_count,
      }),
    })),
  clear: () => set({ entries: [] }),
}));
