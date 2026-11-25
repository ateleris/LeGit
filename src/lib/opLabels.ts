import type { commands } from "./bindings";

type CommandName = keyof typeof commands;
type Label = string | ((args: readonly unknown[]) => string);

const short = (rev: unknown) => String(rev).slice(0, 8);
const count = (shas: unknown, noun: string) => {
  const n = Array.isArray(shas) ? shas.length : 1;
  return n === 1 ? `1 ${noun}` : `${n} ${noun}s`;
};

/**
 * Busy-notice text for every command that changes the repository and can
 * take noticeable time. `api` shows it while such a command runs, so no call
 * site can forget the indicator. Fetch, pull, push to the tracked branch and
 * clone are absent on purpose: they report progress in their own surfaces.
 */
export const OP_LABELS: Partial<Record<CommandName, Label>> = {
  repoMerge: (a) => `Merging ${a[1]}…`,
  repoMergeContinue: "Continuing the merge…",
  repoMergeAbort: "Aborting the merge…",
  repoRebase: (a) => `Rebasing onto ${a[1]}…`,
  repoRebaseInteractive: "Rebasing…",
  repoRebaseContinue: "Continuing the rebase…",
  repoRebaseSkip: "Skipping the rebase step…",
  repoRebaseAbort: "Aborting the rebase…",
  repoCherryPick: (a) => `Cherry-picking ${count(a[1], "commit")}…`,
  repoCherryPickContinue: "Continuing the cherry-pick…",
  repoCherryPickSkip: "Skipping the cherry-pick step…",
  repoCherryPickAbort: "Aborting the cherry-pick…",
  repoRevert: (a) => `Reverting ${count(a[1], "commit")}…`,
  repoRevertContinue: "Continuing the revert…",
  repoRevertSkip: "Skipping the revert step…",
  repoRevertAbort: "Aborting the revert…",
  repoReset: "Resetting…",
  repoSwitchBranch: (a) => `Switching to ${a[1]}…`,
  repoCheckoutRemoteBranch: (a) => `Checking out ${String(a[1]).replace(/^refs\/remotes\//, "")}…`,
  repoCheckoutCommit: (a) => `Checking out ${short(a[1])}…`,
  repoCreateStash: "Stashing changes…",
  repoCreateStashPaths: "Stashing changes…",
  repoApplyStash: "Applying the stash…",
  repoApplyStashFile: "Applying the stashed file…",
  repoPopStash: "Popping the stash…",
  repoDropStash: "Dropping the stash…",
  repoRenameStash: "Renaming the stash…",
  repoStashBranch: (a) => `Creating branch ${a[2]} from the stash…`,
  repoDiscard: "Discarding changes…",
  repoRestoreFileAtRevision: (a) => `Restoring ${a[2]}…`,
  repoResolveTakeSide: "Resolving conflicts…",
  repoCommit: "Committing…",
  repoRewordCommit: "Rewording the commit…",
  repoRenormalize: "Normalizing line endings…",
  repoRenameBranch: (a) => `Renaming ${a[1]}…`,
  repoDeleteBranch: (a) => `Deleting branch ${a[1]}…`,
  repoDeleteRemoteBranch: (a) => `Deleting ${a[2]} on ${a[1]}…`,
  repoCreateTag: (a) => `Creating tag ${a[1]}…`,
  repoDeleteTag: (a) => `Deleting tag ${a[1]}…`,
  repoPushTag: (a) => `Pushing tag ${a[2]} to ${a[1]}…`,
  repoDeleteRemoteTag: (a) => `Deleting tag ${a[2]} on ${a[1]}…`,
};

/** Operations the activity bar offers Stop for: the ones git itself records
 * as "in progress" once started, so an interrupted run can be recovered
 * with the operation banner's Abort. Checkout, reset, stash, discard and
 * commit have no such recovery and are deliberately absent. */
const STOPPABLE = new Set<string>([
  "repoMerge",
  "repoMergeContinue",
  "repoRebase",
  "repoRebaseInteractive",
  "repoRebaseContinue",
  "repoRebaseSkip",
  "repoCherryPick",
  "repoCherryPickContinue",
  "repoCherryPickSkip",
  "repoRevert",
  "repoRevertContinue",
  "repoRevertSkip",
] satisfies CommandName[]);

export const isStoppable = (name: string): boolean => STOPPABLE.has(name);

export function opLabel(name: string, args: readonly unknown[]): string | null {
  const label = (OP_LABELS as Record<string, Label | undefined>)[name];
  if (label == null) return null;
  return typeof label === "string" ? label : label(args);
}
