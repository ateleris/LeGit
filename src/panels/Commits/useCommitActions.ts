// The Commits panel's mutating actions (merge/rebase/sequencer, branch, tag,
// stash, checkout), extracted from CommitsPanel where ~20 near-identical
// useCallback handlers lived inline. Every callback here is referentially
// STABLE (latest-ref pattern), so the panel needs no exhaustive-deps
// suppressions and menu components never re-render from handler identity.
//
// The handlers deliberately do NOT run through usePanelRunner: the commit
// graph never disables rows during an action - feedback arrives as toasts +
// query invalidation, and re-entry is harmless (git serializes on its own
// index lock; the runner convention covers button-driven panels).

import { useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  repoApplyStash,
  repoCheckoutCommit,
  repoCheckoutRemoteBranch,
  repoCherryPick,
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
  repoReset,
  repoRevert,
  repoRewordCommit,
  repoSetUpstream,
  repoSwitchBranch,
} from "../../lib/commands";
import type { Commit, CommitId, MergeOptions, RepoSummary, ResetMode } from "../../lib/types";
import { formatAppError } from "../../lib/types";
import { invalidateRepoDomains } from "../../lib/repoInvalidation";
import { autoUpdateSubmodules } from "../../lib/submodules";
import { notify } from "../../store/notifications";
import { useSettingsStore } from "../../store/settings";
import {
  notifySwitchOutcome,
  notifyRemoteCheckoutOutcome,
  notifySwitchError,
} from "../../lib/switchFeedback";
import { remoteOpErrorMessage } from "../../lib/pushFeedback";
import { autoPushTagAfterCreate, pushWithTagFollowUp } from "../../lib/autoPushTags";
import {
  notifyMergeOutcome,
  notifyOpError,
  notifyRebaseOutcome,
  notifySequenceOutcome,
} from "../../lib/mergeFeedback";
import { OP_DOMAINS } from "../../lib/useOpState";
import { splitRemoteRef } from "../../lib/branchGroups";

// Switching can create/consume an auto-stash, so "stashes" is invalidated too.
export const BRANCH_DOMAINS = ["branches", "log", "status", "tracking", "stashes"] as const;
// Push moves remote-tracking refs; "tags" because the tag list's per-tag
// `target_on_remote` flag is computed against them (same set as the sync
// toolbar's invalidation).
export const PUSH_DOMAINS = ["log", "branches", "status", "tracking", "tags"] as const;
export const STASH_DOMAINS = ["stashes", "log", "status"] as const;
export const TAG_DOMAINS = ["tags", "log"] as const;

export function useCommitActions(repo: RepoSummary | null, remoteNames: string[]) {
  const queryClient = useQueryClient();
  // Latest-ref: the returned callbacks stay stable while always seeing the
  // current repo/remote list.
  const ctx = useRef({ repo, remoteNames });
  ctx.current = { repo, remoteNames };

  return useMemo(() => {
    /** The active repo, or null - every action no-ops without one. */
    const repoOf = () => ctx.current.repo;
    const invalidate = (repoId: string, domains: readonly string[]) =>
      invalidateRepoDomains(queryClient, repoId, domains);

    return {
      // --- merge / rebase / sequencer (conflicts pause into op-state; a
      // failed op can still leave state behind, so refresh either way) ---
      handleMerge: async (target: string, options: MergeOptions) => {
        const repo = repoOf();
        if (!repo) return;
        try {
          const outcome = await repoMerge(repo.id, target, options);
          invalidate(repo.id, OP_DOMAINS);
          notifyMergeOutcome(outcome, target);
        } catch (e) {
          invalidate(repo.id, OP_DOMAINS);
          notifyOpError(e);
        }
      },

      // `mainline` (1-based parent number) comes from the merge-commit
      // parent picker; regular commits pass none.
      handleCherryPick: async (sha: string, mainline?: number) => {
        const repo = repoOf();
        if (!repo) return;
        try {
          const outcome = await repoCherryPick(repo.id, sha, mainline);
          invalidate(repo.id, OP_DOMAINS);
          notifySequenceOutcome(outcome, "cherry-pick", sha.slice(0, 8));
        } catch (e) {
          invalidate(repo.id, OP_DOMAINS);
          notifyOpError(e);
        }
      },

      handleRevert: async (sha: string, mainline?: number) => {
        const repo = repoOf();
        if (!repo) return;
        try {
          const outcome = await repoRevert(repo.id, sha, mainline);
          invalidate(repo.id, OP_DOMAINS);
          notifySequenceOutcome(outcome, "revert", sha.slice(0, 8));
        } catch (e) {
          invalidate(repo.id, OP_DOMAINS);
          notifyOpError(e);
        }
      },

      handleReset: async (sha: string, mode: ResetMode) => {
        const repo = repoOf();
        if (!repo) return;
        // Reset also moves the branch relative to its upstream.
        try {
          await repoReset(repo.id, sha, mode);
          invalidate(repo.id, [...OP_DOMAINS, "tracking"]);
          notify.info(`Reset (${mode}) to ${sha.slice(0, 8)}.`);
        } catch (e) {
          invalidate(repo.id, [...OP_DOMAINS, "tracking"]);
          notifyOpError(e);
        }
      },

      handleUndoLastCommit: async (headSha: string) => {
        const repo = repoOf();
        if (!repo) return;
        // `reset --soft <tip>~1`: changes come back staged, the undone commit
        // stays reachable via the reflog. Addressed relative to the row's SHA
        // (not HEAD~1) so a stale row cannot reset past a commit that landed
        // after the menu opened.
        try {
          await repoReset(repo.id, `${headSha}~1`, "soft");
          invalidate(repo.id, [...OP_DOMAINS, "tracking"]);
          notify.info(
            `Undid commit ${headSha.slice(0, 8)} - its changes are staged again.`,
          );
        } catch (e) {
          invalidate(repo.id, [...OP_DOMAINS, "tracking"]);
          notifyOpError(e);
        }
      },

      handleRebaseOnto: async (onto: string) => {
        const repo = repoOf();
        if (!repo) return;
        // "stashes" too: rebase runs --autostash, which creates and
        // reapplies (or, on conflict, keeps) a stash entry.
        try {
          const outcome = await repoRebase(repo.id, onto);
          invalidate(repo.id, [...OP_DOMAINS, "stashes"]);
          notifyRebaseOutcome(outcome, onto);
        } catch (e) {
          invalidate(repo.id, [...OP_DOMAINS, "stashes"]);
          notifyOpError(e);
        }
      },

      // --- checkouts ---
      handleBranchCheckout: async (name: string) => {
        const repo = repoOf();
        if (!repo) return;
        try {
          const outcome = await repoSwitchBranch(repo.id, name);
          invalidate(repo.id, BRANCH_DOMAINS);
          notifySwitchOutcome(outcome, name);
          void autoUpdateSubmodules(queryClient, repo.id);
        } catch (e) {
          notifySwitchError(e);
        }
      },

      handleRemoteCheckout: async (remoteRef: string) => {
        const repo = repoOf();
        if (!repo) return;
        try {
          const outcome = await repoCheckoutRemoteBranch(repo.id, remoteRef);
          invalidate(repo.id, BRANCH_DOMAINS);
          notifyRemoteCheckoutOutcome(outcome, remoteRef);
          void autoUpdateSubmodules(queryClient, repo.id);
        } catch (e) {
          notifySwitchError(e);
        }
      },

      handleCommitCheckout: async (sha: string) => {
        const repo = repoOf();
        if (!repo) return;
        try {
          const outcome = await repoCheckoutCommit(repo.id, sha);
          invalidate(repo.id, BRANCH_DOMAINS);
          notifySwitchOutcome(outcome, sha.slice(0, 8));
          void autoUpdateSubmodules(queryClient, repo.id);
        } catch (e) {
          notifySwitchError(e);
        }
      },

      // --- branches ---
      handleBranchRenameSave: async (oldName: string, newName: string) => {
        const repo = repoOf();
        if (!repo) return;
        try {
          await repoRenameBranch(repo.id, oldName, newName);
          invalidate(repo.id, BRANCH_DOMAINS);
        } catch (e) {
          notify.error(formatAppError(e));
        }
      },

      handleBranchDelete: async (name: string, force: boolean) => {
        const repo = repoOf();
        if (!repo) return;
        try {
          await repoDeleteBranch(repo.id, name, force);
          invalidate(repo.id, BRANCH_DOMAINS);
        } catch (e) {
          notify.error(formatAppError(e));
        }
      },

      handleSetUpstream: async (branch: string, upstream: string | null) => {
        const repo = repoOf();
        if (!repo) return;
        try {
          await repoSetUpstream(repo.id, branch, upstream);
          invalidate(repo.id, BRANCH_DOMAINS);
        } catch (e) {
          notify.error(formatAppError(e));
        }
      },

      // Pushes a branch - checked out or not (the backend addresses the full
      // refs/heads/ refspec). `setUpstream` publishes: the target remote
      // becomes the branch's upstream. Feedback is toast-based like the other
      // menu actions; the classified remote errors share the sync toolbar's
      // wording via remoteOpErrorMessage.
      handleBranchPush: async (branch: string, remote: string, setUpstream: boolean) => {
        const repo = repoOf();
        if (!repo) return;
        try {
          await pushWithTagFollowUp(
            queryClient,
            repo.id,
            {
              remote,
              branch,
              set_upstream: setUpstream,
              force_with_lease: false,
              recurse_submodules:
                useSettingsStore.getState().settings?.push_recurse_submodules ?? null,
            },
            crypto.randomUUID(),
          );
          notify.success(`Pushed '${branch}' to ${remote}`);
          invalidate(repo.id, PUSH_DOMAINS);
        } catch (e) {
          notify.error(remoteOpErrorMessage(e));
        }
      },

      // Deletes the branch ON THE REMOTE only (`git push --delete`) — any
      // local counterpart is untouched, mirroring remote tag deletion.
      handleRemoteBranchDelete: async (remoteRef: string) => {
        const repo = repoOf();
        if (!repo) return;
        const split = splitRemoteRef(remoteRef, ctx.current.remoteNames);
        if (!split) return;
        try {
          await repoDeleteRemoteBranch(repo.id, split.remote, split.branch, crypto.randomUUID());
          notify.success(`Deleted '${split.branch}' on ${split.remote}`);
          invalidate(repo.id, BRANCH_DOMAINS);
        } catch (e) {
          notify.error(formatAppError(e));
        }
      },

      // --- reword / stash rename (the in-place subject edit's git halves;
      // the panel owns the editor state around them) ---
      rewordCommit: async (commit: Commit, subject: string) => {
        const repo = repoOf();
        if (!repo) return;
        // Only the subject line is edited - a multi-line body is preserved.
        const lines = commit.message.split("\n");
        const body = lines.slice(1).join("\n");
        const newMessage = body.length > 0 ? `${subject}\n${body}` : subject;
        await repoRewordCommit(repo.id, commit.id, newMessage);
        invalidate(repo.id, ["log", "branches", "tracking"]);
      },

      renameStash: async (sha: string, message: string) => {
        const repo = repoOf();
        if (!repo) return;
        await repoRenameStash(repo.id, sha, message);
        invalidate(repo.id, STASH_DOMAINS);
      },

      // --- tags ---
      handleTagPush: async (name: string, remote: string) => {
        const repo = repoOf();
        if (!repo) return;
        try {
          await repoPushTag(repo.id, remote, name, crypto.randomUUID());
          notify.success(`Pushed tag '${name}' to ${remote}`);
          invalidate(repo.id, ["remote-tags"]);
        } catch (e) {
          notify.error(formatAppError(e));
        }
      },

      handleTagDelete: async (name: string) => {
        const repo = repoOf();
        if (!repo) return;
        try {
          await repoDeleteTag(repo.id, name);
          invalidate(repo.id, TAG_DOMAINS);
        } catch (e) {
          notify.error(formatAppError(e));
        }
      },

      // Deletes the tag ON THE REMOTE only — local/remote deletion are
      // separate, deliberate actions (GitKraken-style).
      handleTagDeleteRemote: async (name: string, remote: string) => {
        const repo = repoOf();
        if (!repo) return;
        try {
          await repoDeleteRemoteTag(repo.id, remote, name, crypto.randomUUID());
          notify.success(`Deleted tag '${name}' from ${remote}`);
          invalidate(repo.id, ["remote-tags"]);
        } catch (e) {
          notify.error(formatAppError(e));
        }
      },

      createTag: async (name: string, target: CommitId, message: string | null) => {
        const repo = repoOf();
        if (!repo) return;
        try {
          await repoCreateTag(repo.id, name, target, message ?? undefined);
          invalidate(repo.id, TAG_DOMAINS);
          // Create-time auto-push trigger (gated on the setting inside).
          void autoPushTagAfterCreate(queryClient, repo.id, name);
        } catch (e) {
          notify.error(formatAppError(e));
        }
      },

      // --- stashes (addressed by commit SHA; the backend resolves the
      // current stash@{N} at action time, so a stale list can never hit the
      // wrong stash; toasts use generic wording accordingly) ---
      handleStashApply: async (sha: string) => {
        const repo = repoOf();
        if (!repo) return;
        try {
          const outcome = await repoApplyStash(repo.id, sha);
          invalidate(repo.id, STASH_DOMAINS);
          if (outcome.kind === "conflicts") {
            notify.info(
              "Applying the stash produced conflicts — resolve them in your working tree.",
            );
          }
        } catch (e) {
          notify.error(formatAppError(e));
        }
      },

      handleStashPop: async (sha: string) => {
        const repo = repoOf();
        if (!repo) return;
        try {
          const outcome = await repoPopStash(repo.id, sha);
          invalidate(repo.id, STASH_DOMAINS);
          if (outcome.kind === "conflicts") {
            notify.info(
              "Popping the stash produced conflicts — the stash was kept; resolve them in your working tree.",
            );
          }
        } catch (e) {
          notify.error(formatAppError(e));
        }
      },

      handleStashDrop: async (sha: string) => {
        const repo = repoOf();
        if (!repo) return;
        try {
          await repoDropStash(repo.id, sha);
          invalidate(repo.id, STASH_DOMAINS);
        } catch (e) {
          notify.error(formatAppError(e));
        }
      },

      handleCreateStash: async (includeUntracked: boolean) => {
        const repo = repoOf();
        if (!repo) return;
        try {
          const outcome = await repoCreateStash(repo.id, undefined, includeUntracked, false);
          invalidate(repo.id, STASH_DOMAINS);
          if (outcome.kind === "nothing_to_stash") {
            notify.info("Nothing to stash — the working tree is clean.");
          }
        } catch (e) {
          notify.error(formatAppError(e));
        }
      },
    };
  }, [queryClient]);
}
