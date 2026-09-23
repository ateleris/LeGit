// Branch, tag and stash actions shared by every panel that offers them: each
// owns its command, feedback toast and query invalidation, never throws, and
// resolves whether it succeeded. Panels add only their own busy/guard runner
// and local UI state.

import type { QueryClient } from "@tanstack/react-query";
import {
  repoApplyStash,
  repoCheckoutCommit,
  repoCheckoutRemoteBranch,
  repoCreateBranch,
  repoCreateStash,
  repoCreateTag,
  repoDeleteBranch,
  repoDeleteRemoteBranch,
  repoDeleteRemoteTag,
  repoDeleteTag,
  repoDropStash,
  repoMerge,
  repoPopStash,
  repoPushTag,
  repoRebase,
  repoRenameBranch,
  repoRenameStash,
  repoSetUpstream,
  repoStashBranch,
  repoSwitchBranch,
} from "./commands";
import type { MergeOptions, RepoSummary } from "./types";
import { formatAppError } from "./errors";
import { deleteBranchGuided } from "./branchDelete";
import { splitRemoteRef } from "./branchGroups";
import { notifyLfsStubs } from "./lfsFeedback";
import { worktreeLocator } from "./locator";
import { notifyMergeOutcome, notifyOpError, notifyRebaseOutcome } from "./mergeFeedback";
import { remoteOpErrorMessage } from "./pushFeedback";
import { autoPushTagAfterCreate, pushWithTagFollowUp } from "./autoPushTags";
import { invalidateRepoDomains } from "./repoInvalidation";
import { autoUpdateSubmodules } from "./submodules";
import {
  notifyRemoteCheckoutOutcome,
  notifySwitchError,
  notifySwitchOutcome,
} from "./switchFeedback";
import {
  BRANCH_DOMAINS,
  OP_DOMAINS,
  STASH_DOMAINS,
  SYNC_DOMAINS,
  TAG_DOMAINS,
  type QueryDomain,
} from "./queries/domains";
import { notify } from "../store/notifications";
import { useRepoStore } from "../store/repos";
import { useSettingsStore } from "../store/settings";

export interface RefActionContext {
  queryClient: QueryClient;
  repo: RepoSummary;
  /** Needed to split `origin/feature`-style remote refs. */
  remoteNames?: readonly string[];
}

const invalidate = (ctx: RefActionContext, domains: readonly QueryDomain[]) =>
  invalidateRepoDomains(ctx.queryClient, ctx.repo.id, domains);

/** Run `body`; on failure report through `onError` and resolve false. */
async function attempt(body: () => Promise<void>, onError: (e: unknown) => void): Promise<boolean> {
  try {
    await body();
    return true;
  } catch (e) {
    onError(e);
    return false;
  }
}

const reportError = (e: unknown) => notify.error(formatAppError(e));
const reportRemoteError = (e: unknown) => notify.error(remoteOpErrorMessage(e));

/** Switch-style failures; a checked-out-elsewhere refusal's toast opens the
 *  blocking worktree on click. */
function reportSwitchError(ctx: RefActionContext) {
  return (e: unknown) =>
    notifySwitchError(e, {
      onOpenWorktree: (path) => {
        void useRepoStore
          .getState()
          .openRepo(worktreeLocator(ctx.repo.locator ?? ctx.repo.path, path))
          .catch((err: unknown) => notify.error(formatAppError(err)));
      },
    });
}

// --- checkouts ---

export const checkoutBranch = (ctx: RefActionContext, name: string) =>
  attempt(async () => {
    const result = await repoSwitchBranch(ctx.repo.id, name);
    invalidate(ctx, BRANCH_DOMAINS);
    notifySwitchOutcome(result.outcome, name);
    notifyLfsStubs(result.lfs_stubs, "switch");
    void autoUpdateSubmodules(ctx.queryClient, ctx.repo.id);
  }, reportSwitchError(ctx));

export const checkoutRemoteBranch = (ctx: RefActionContext, remoteRef: string) =>
  attempt(async () => {
    const outcome = await repoCheckoutRemoteBranch(ctx.repo.id, remoteRef);
    invalidate(ctx, BRANCH_DOMAINS);
    notifyRemoteCheckoutOutcome(outcome, remoteRef.replace(/^refs\/remotes\//, ""));
    notifyLfsStubs(outcome.lfs_stubs, "checkout");
    void autoUpdateSubmodules(ctx.queryClient, ctx.repo.id);
  }, reportSwitchError(ctx));

export const checkoutCommit = (ctx: RefActionContext, sha: string) =>
  attempt(async () => {
    const result = await repoCheckoutCommit(ctx.repo.id, sha);
    invalidate(ctx, BRANCH_DOMAINS);
    notifySwitchOutcome(result.outcome, sha.slice(0, 8));
    notifyLfsStubs(result.lfs_stubs, "checkout");
    void autoUpdateSubmodules(ctx.queryClient, ctx.repo.id);
  }, reportSwitchError(ctx));

// --- branches ---

/** Create `name` (at `startPoint`, default HEAD); with `checkout` it is then
 *  switched to, and that switch reports its own outcome. Resolves whether the
 *  branch was created. */
export async function createBranch(
  ctx: RefActionContext,
  name: string,
  startPoint: string | undefined,
  opts: { checkout: boolean },
): Promise<boolean> {
  const created = await attempt(async () => {
    await repoCreateBranch(ctx.repo.id, name, startPoint);
    invalidate(ctx, BRANCH_DOMAINS);
  }, reportError);
  if (created && opts.checkout) await checkoutBranch(ctx, name);
  return created;
}

export const renameBranch = (ctx: RefActionContext, oldName: string, newName: string) =>
  attempt(async () => {
    await repoRenameBranch(ctx.repo.id, oldName, newName);
    invalidate(ctx, BRANCH_DOMAINS);
  }, reportError);

/** A safe delete raises the guided force-delete offer on a "not fully
 *  merged" refusal; resolves false when the user keeps the branch. */
export async function deleteBranch(ctx: RefActionContext, name: string, force: boolean): Promise<boolean> {
  let gone = false;
  const ok = await attempt(async () => {
    if (force) {
      await repoDeleteBranch(ctx.repo.id, name, true);
      gone = true;
    } else {
      gone = await deleteBranchGuided(ctx.repo.id, name);
    }
    invalidate(ctx, BRANCH_DOMAINS);
  }, reportError);
  return ok && gone;
}

export const setUpstream = (ctx: RefActionContext, branch: string, upstream: string | null) =>
  attempt(async () => {
    await repoSetUpstream(ctx.repo.id, branch, upstream);
    invalidate(ctx, BRANCH_DOMAINS);
  }, reportError);

/** Push `branch` (checked out or not); `setUpstream` makes `remote` its
 *  upstream. */
export const pushBranch = (ctx: RefActionContext, branch: string, remote: string, setUpstream: boolean) =>
  attempt(async () => {
    await pushWithTagFollowUp(
      ctx.queryClient,
      ctx.repo.id,
      {
        remote,
        branch,
        set_upstream: setUpstream,
        force_with_lease: false,
        recurse_submodules: useSettingsStore.getState().settings?.push_recurse_submodules ?? null,
      },
      crypto.randomUUID(),
    );
    notify.success(`Pushed '${branch}' to ${remote}`);
    invalidate(ctx, SYNC_DOMAINS);
  }, reportRemoteError);

/** Delete the branch ON THE REMOTE only; a local counterpart is untouched. */
export async function deleteRemoteBranch(ctx: RefActionContext, remoteRef: string): Promise<boolean> {
  const split = splitRemoteRef(remoteRef, [...(ctx.remoteNames ?? [])]);
  if (!split) return false;
  return attempt(async () => {
    await repoDeleteRemoteBranch(ctx.repo.id, split.remote, split.branch, crypto.randomUUID());
    notify.success(`Deleted '${split.branch}' on ${split.remote}`);
    invalidate(ctx, BRANCH_DOMAINS);
  }, reportRemoteError);
}

/** `git stash branch`: a new branch at the stash's base with the stash
 *  applied and dropped; it checks the branch out, so failures are switch
 *  failures. */
export const stashBranch = (ctx: RefActionContext, sha: string, name: string) =>
  attempt(async () => {
    await repoStashBranch(ctx.repo.id, sha, name);
    invalidate(ctx, BRANCH_DOMAINS);
    notify.info(`Created branch '${name}' from the stash and checked it out.`);
  }, reportSwitchError(ctx));

// --- merge / rebase (a failed attempt can still leave op state behind, so
// the domains refresh either way) ---

export async function mergeInto(ctx: RefActionContext, target: string, options: MergeOptions): Promise<boolean> {
  const ok = await attempt(async () => {
    notifyMergeOutcome(await repoMerge(ctx.repo.id, target, options), target);
  }, notifyOpError);
  invalidate(ctx, OP_DOMAINS);
  return ok;
}

/** "stashes" too: rebase runs --autostash, which creates and reapplies (or,
 *  on conflict, keeps) a stash entry. */
export async function rebaseOnto(ctx: RefActionContext, onto: string): Promise<boolean> {
  const ok = await attempt(async () => {
    notifyRebaseOutcome(await repoRebase(ctx.repo.id, onto), onto);
  }, notifyOpError);
  invalidate(ctx, [...OP_DOMAINS, "stashes"]);
  return ok;
}

// --- tags ---

export async function createTag(
  ctx: RefActionContext,
  name: string,
  target: string | undefined,
  message: string | undefined,
): Promise<boolean> {
  const ok = await attempt(async () => {
    await repoCreateTag(ctx.repo.id, name, target, message);
    invalidate(ctx, TAG_DOMAINS);
  }, reportError);
  // Create-time auto-push trigger (gated on the setting inside).
  if (ok) void autoPushTagAfterCreate(ctx.queryClient, ctx.repo.id, name);
  return ok;
}

export const deleteTag = (ctx: RefActionContext, name: string) =>
  attempt(async () => {
    await repoDeleteTag(ctx.repo.id, name);
    invalidate(ctx, TAG_DOMAINS);
  }, reportError);

export const pushTag = (ctx: RefActionContext, name: string, remote: string) =>
  attempt(async () => {
    await repoPushTag(ctx.repo.id, remote, name, crypto.randomUUID());
    notify.success(`Pushed tag '${name}' to ${remote}`);
    invalidate(ctx, ["remote-tags"]);
  }, reportRemoteError);

/** Delete the tag ON THE REMOTE only; local copies stay. */
export const deleteRemoteTag = (ctx: RefActionContext, name: string, remote: string) =>
  attempt(async () => {
    await repoDeleteRemoteTag(ctx.repo.id, remote, name, crypto.randomUUID());
    notify.success(`Deleted tag '${name}' from ${remote}`);
    invalidate(ctx, ["remote-tags"]);
  }, reportRemoteError);

// --- stashes (addressed by commit SHA; the backend resolves the current
// stash@{N} at action time, so a stale list can never hit the wrong one) ---

export const applyStash = (ctx: RefActionContext, sha: string, label = "the stash") =>
  attempt(async () => {
    const outcome = await repoApplyStash(ctx.repo.id, sha);
    invalidate(ctx, STASH_DOMAINS);
    if (outcome.kind === "conflicts") {
      notify.info(`Applying ${label} produced conflicts - resolve them in your working tree.`);
    }
  }, reportError);

export const popStash = (ctx: RefActionContext, sha: string, label = "the stash") =>
  attempt(async () => {
    const outcome = await repoPopStash(ctx.repo.id, sha);
    invalidate(ctx, STASH_DOMAINS);
    if (outcome.kind === "conflicts") {
      notify.info(
        `Popping ${label} produced conflicts - the stash was kept; resolve them in your working tree.`,
      );
    }
  }, reportError);

export const dropStash = (ctx: RefActionContext, sha: string) =>
  attempt(async () => {
    await repoDropStash(ctx.repo.id, sha);
    invalidate(ctx, STASH_DOMAINS);
  }, reportError);

/** Rename via drop + re-store: the stash moves to stash@{0}. */
export const renameStash = (ctx: RefActionContext, sha: string, message: string) =>
  attempt(async () => {
    await repoRenameStash(ctx.repo.id, sha, message);
    invalidate(ctx, STASH_DOMAINS);
  }, reportError);

/** Resolves "created", "nothing_to_stash" (a clean tree, reported with an
 *  info toast), or null on failure. */
export async function createStash(
  ctx: RefActionContext,
  opts: { message?: string; includeUntracked: boolean; keepIndex: boolean },
): Promise<"created" | "nothing_to_stash" | null> {
  let result: "created" | "nothing_to_stash" = "created";
  const ok = await attempt(async () => {
    const outcome = await repoCreateStash(ctx.repo.id, opts.message, opts.includeUntracked, opts.keepIndex);
    invalidate(ctx, STASH_DOMAINS);
    if (outcome.kind === "nothing_to_stash") {
      result = "nothing_to_stash";
      notify.info("Nothing to stash - the working tree is clean.");
    }
  }, reportError);
  return ok ? result : null;
}
