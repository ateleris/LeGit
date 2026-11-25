// One write at a time per repository. A command that rewrites the working
// tree, the index or HEAD must not overlap another one on the same repo: at
// best git refuses the second with a lock error, at worst they interleave.
// Reads are never held back, and other repositories are unaffected.

import { create } from "zustand";
import { OP_LABELS, opLabel } from "./opLabels";

/** Labelled commands that touch only refs or the remote, never the working
 * tree or index: they need no lock. */
const NOT_LOCKING = new Set<string>([
  "repoRenameBranch",
  "repoDeleteBranch",
  "repoDeleteRemoteBranch",
  "repoCreateTag",
  "repoDeleteTag",
  "repoPushTag",
  "repoDeleteRemoteTag",
]);

/** Long-running writes that report progress in their own surface (so they
 * have no entry in `OP_LABELS`) but still hold the lock. */
const SELF_REPORTING_WRITES: Record<string, string> = {
  repoPull: "Pulling…",
  repoSubmoduleUpdate: "Updating submodules…",
  repoSubmoduleUpdateRemote: "Updating submodules…",
};

/** Quick index and working-tree writes: they take turns with each other and
 * are refused only while a long-running write holds the repository. */
const QUICK_WRITES = new Set<string>([
  "repoStage",
  "repoUnstage",
  "repoStageHunk",
  "repoUnstageHunk",
  "repoDiscardHunk",
  "repoStageLines",
  "repoUnstageLines",
  "repoDiscardLines",
  "repoStageCaseRename",
  "repoDiscardCaseRename",
  "repoConflictReopen",
  "repoWriteWorktreeFile",
  "repoRevertLineEndings",
  "repoUntrackPath",
]);

export type RepoWriteClass = { kind: "long"; label: string } | { kind: "quick" };

export function repoWriteClass(name: string, args: readonly unknown[]): RepoWriteClass | null {
  if (name in SELF_REPORTING_WRITES) return { kind: "long", label: SELF_REPORTING_WRITES[name] };
  if (name in OP_LABELS && !NOT_LOCKING.has(name)) {
    return { kind: "long", label: opLabel(name, args) ?? name };
  }
  return QUICK_WRITES.has(name) ? { kind: "quick" } : null;
}

/** Thrown instead of starting a write while a long-running one holds the
 * repository. A plain `Error`, so `formatAppError` shows the message as is. */
export class RepoBusyError extends Error {
  constructor(public readonly running: string) {
    super(`Another operation is still running on this repository (${running.replace(/…$/, "")}). Try again when it has finished.`);
    this.name = "RepoBusyError";
  }
}

interface RepoWriteStore {
  /** The long-running write holding each repository, by its label. */
  running: Record<string, string>;
}

export const useRepoWriteStore = create<RepoWriteStore>(() => ({ running: {} }));

/** The long-running write holding `repoId`, for disabling write controls. */
export const useRepoWriteBusy = (repoId: string | undefined | null): string | null =>
  useRepoWriteStore((s) => (repoId ? (s.running[repoId] ?? null) : null));

const tails = new Map<string, Promise<void>>();

/**
 * Run one write on `repoId`. Refused with `RepoBusyError` while a
 * long-running write holds the repository; otherwise it waits its turn
 * behind writes already queued, so two quick writes never overlap either.
 */
export async function runRepoWrite<T>(
  repoId: string,
  cls: RepoWriteClass,
  body: () => Promise<T>,
): Promise<T> {
  const holder = useRepoWriteStore.getState().running[repoId];
  if (holder) throw new RepoBusyError(holder);

  const previous = tails.get(repoId) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => (release = resolve));
  const tail = previous.then(() => mine);
  tails.set(repoId, tail);
  if (cls.kind === "long") {
    useRepoWriteStore.setState((s) => ({ running: { ...s.running, [repoId]: cls.label } }));
  }
  await previous;
  try {
    return await body();
  } finally {
    if (cls.kind === "long") {
      useRepoWriteStore.setState((s) => {
        const running = { ...s.running };
        delete running[repoId];
        return { running };
      });
    }
    release();
    if (tails.get(repoId) === tail) tails.delete(repoId);
  }
}
