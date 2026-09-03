import { create } from "zustand";
import { cancelClone } from "../lib/commands";
import type { CloneOptions } from "../lib/commands";
import { lfsDownloadErrorMessage } from "../lib/lfsFeedback";
import { cloneCancelCleanupFailure, formatAppError, gitErrorKind } from "../lib/types";
import { notify } from "./notifications";
import { useRemoteProgressStore } from "./remoteProgress";
import { useRepoStore } from "./repos";

/** One clone running in the backend, keyed by the op id it was started with. */
export interface CloneJob {
  opId: string;
  url: string;
  /** Target folder name — what the tab and the progress view label the job with. */
  name: string;
  parentDir: string;
  startedAt: number;
  /** A cancel was requested; the kill is not instant, so the row says so. */
  cancelling: boolean;
}

export interface StartCloneArgs {
  url: string;
  parentDir: string;
  name: string;
  profileId: string | null;
  options: CloneOptions;
}

/**
 * In-flight clones. Module-level (like the console's per-repo sessions)
 * because the op id must OUTLIVE the form that started it: a clone dialog
 * can be dismissed while its clone runs, and that id is the only handle on
 * the backend's cancellable `TransientOp`. Each job is a "Cloning" tab in
 * the repo tab strip (`CloneTabs`), so a running clone stays visible and
 * cancellable; the focused job's progress fills the repo region
 * (`CloneProgressView`) the way an active repo's panels would.
 *
 * The outcome is reported from here as a toast: by the time a clone
 * finishes, the form that started it is usually gone, so an inline error
 * would be shown to nobody.
 */
interface CloneStore {
  jobs: Record<string, CloneJob>;
  /** The clone whose tab is selected (its progress view shows instead of the
   *  active repo's panels); null = a repo tab is selected. A new clone takes
   *  focus so its progress is seen at once; selecting a repo tab clears it. */
  focusedOpId: string | null;
  /** Bumped whenever a clone settles, so surfaces caching derived data (the
   *  Repositories panel's recents list) can refresh off it. */
  completedCount: number;
  /** Mint an op id, register the job, focus it, and run it. Never rejects. */
  start: (args: StartCloneArgs) => string;
  /** Ask the backend to kill the clone and clean up its partial target. */
  cancel: (opId: string) => void;
  focus: (opId: string | null) => void;
}

/** The clone's destination as shown to the user; joins with the separator
 *  style of `parentDir` so a Windows parent does not sprout a '/' tail. */
export function cloneTargetPath(job: Pick<CloneJob, "parentDir" | "name">): string {
  const parent = job.parentDir.replace(/[\\/]+$/, "");
  const sep = parent.includes("\\") && !parent.includes("/") ? "\\" : "/";
  return `${parent}${sep}${job.name}`;
}

export const useCloneStore = create<CloneStore>((set, get) => ({
  jobs: {},
  focusedOpId: null,
  completedCount: 0,

  start({ url, parentDir, name, profileId, options }) {
    const opId = crypto.randomUUID();
    // Registered BEFORE the await: the tab must be able to cancel this
    // clone from the very first frame, even if the caller unmounts at once.
    set((s) => ({
      jobs: {
        ...s.jobs,
        [opId]: { opId, url, name, parentDir, startedAt: Date.now(), cancelling: false },
      },
      focusedOpId: opId,
    }));

    void (async () => {
      try {
        await useRepoStore.getState().cloneRepo(url, parentDir, name, profileId, opId, options);
        notify.success(`Cloned ${name}`);
      } catch (e) {
        if (gitErrorKind(e) === "CloneCancelled") {
          // The expected outcome of Cancel: stay silent - unless the backend
          // could not remove the partial clone's files.
          const note = cloneCancelCleanupFailure(e);
          if (note) notify.error(note);
        } else if (get().jobs[opId]?.cancelling) {
          // A failure that raced the user's Cancel (git settled before the
          // kill landed, so it classified as its own error): the user asked
          // for this clone to end - no error toast.
        } else if (gitErrorKind(e) === "AuthFailed") {
          notify.error(
            `Could not clone ${name}: authentication failed. Pick a profile with the right credentials, or fix your global git credentials.`,
          );
        } else {
          notify.error(
            `Could not clone ${name}: ${lfsDownloadErrorMessage(e, "clone") ?? formatAppError(e)}`,
          );
        }
      } finally {
        useRemoteProgressStore.getState().clear(opId);
        set((s) => {
          const jobs = { ...s.jobs };
          delete jobs[opId];
          return {
            jobs,
            completedCount: s.completedCount + 1,
            focusedOpId: s.focusedOpId === opId ? null : s.focusedOpId,
          };
        });
      }
    })();

    return opId;
  },

  cancel(opId) {
    const job = get().jobs[opId];
    if (!job || job.cancelling) return;
    set((s) => {
      const current = s.jobs[opId];
      if (!current) return s;
      return { jobs: { ...s.jobs, [opId]: { ...current, cancelling: true } } };
    });
    // Fire-and-forget: the clone's own promise reports the outcome. A
    // rejection here only means the op had already finished.
    void cancelClone(opId).catch(() => {});
  },

  focus(opId) {
    set((s) => {
      const next = opId !== null && opId in s.jobs ? opId : null;
      return next === s.focusedOpId ? s : { focusedOpId: next };
    });
  },
}));

// Selecting (or being switched to) a repo — a tab click, a finished clone
// opening its repo, `legit .` from a shell — deselects the clone tab, so the
// repo's panels show instead of the progress view.
useRepoStore.subscribe((s, prev) => {
  if (s.activeRepoId !== prev.activeRepoId) useCloneStore.getState().focus(null);
});
