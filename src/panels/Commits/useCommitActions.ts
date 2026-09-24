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
import {
  applyStash,
  checkoutBranch,
  checkoutCommit,
  checkoutRemoteBranch,
  createStash,
  createTag as createTagAction,
  deleteBranch,
  deleteRemoteBranch,
  deleteRemoteTag,
  deleteTag,
  dropStash,
  mergeInto,
  popStash,
  pushBranch,
  pushTag,
  rebaseOnto,
  renameBranch,
  setUpstream,
  type RefActionContext,
} from "../../lib/refActions";
import { useQueryClient } from "@tanstack/react-query";
import { repoCherryPick, repoLog, repoRevert, api } from "../../lib/commands";
import type { Commit, CommitId, MergeOptions, RepoSummary, ResetMode } from "../../lib/types";
import { formatAppError } from "../../lib/errors";
import { bulkRebasePlan } from "./multiSelect";
import { invalidateRepoDomains } from "../../lib/repoInvalidation";
import { notify } from "../../store/notifications";
import { notifyOpError, notifySequenceOutcome } from "../../lib/mergeFeedback";
import {
  OP_DOMAINS,
  STASH_DOMAINS,
  type QueryDomain,
} from "../../lib/queries/domains";

export function useCommitActions(repo: RepoSummary | null, remoteNames: string[]) {
  const queryClient = useQueryClient();
  // Latest-ref: the returned callbacks stay stable while always seeing the
  // current repo/remote list.
  const ctx = useRef({ repo, remoteNames });
  ctx.current = { repo, remoteNames };

  return useMemo(() => {
    /** The active repo, or null - every action no-ops without one. */
    const repoOf = () => ctx.current.repo;
    const invalidate = (repoId: string, domains: readonly QueryDomain[]) =>
      invalidateRepoDomains(queryClient, repoId, domains);
    const actionCtx = (): RefActionContext | null => {
      const repo = repoOf();
      return repo ? { queryClient, repo, remoteNames: ctx.current.remoteNames } : null;
    };

    return {
      // --- merge / rebase / sequencer (conflicts pause into op-state; a
      // failed op can still leave state behind, so refresh either way) ---
      handleMerge: async (target: string, options: MergeOptions) => {
        const c = actionCtx();
        if (c) await mergeInto(c, target, options);
      },

      // `mainline` (1-based parent number) comes from the merge-commit
      // parent picker; regular commits pass none. Multi-sha calls (bulk
      // selection) pass oldest-first and never a mainline.
      handleCherryPick: async (shas: string[], mainline?: number) => {
        const repo = repoOf();
        if (!repo || shas.length === 0) return;
        const label = shas.length === 1 ? shas[0].slice(0, 8) : `${shas.length} commits`;
        try {
          const outcome = await repoCherryPick(repo.id, shas, mainline);
          invalidate(repo.id, OP_DOMAINS);
          notifySequenceOutcome(outcome, "cherry-pick", label);
        } catch (e) {
          invalidate(repo.id, OP_DOMAINS);
          notifyOpError(e);
        }
      },

      // Bulk history rewrite (drop / squash of an UNPUSHED selection): an
      // automatic interactive rebase over base..HEAD. The range is fetched
      // fresh (never the visible rows - the log can be filtered or show
      // other branches). Unlike the sequencer ops, a conflict ABORTS and
      // rolls back: the branch is left unchanged.
      handleBulkRewrite: async (
        kind: "drop" | "squash",
        selected: ReadonlySet<CommitId>,
        base: CommitId,
        message: string | null,
      ) => {
        const repo = repoOf();
        if (!repo || selected.size === 0) return;
        const verb = kind === "drop" ? "Drop" : "Squash";
        const label = `${selected.size} commits`;
        try {
          const range = await repoLog(repo.id, undefined, undefined, `${base}..HEAD`);
          const plan = bulkRebasePlan(kind, selected, range.map((c) => c.id), message);
          if (!plan) {
            notify.error(
              "The selection no longer matches the branch history - refresh and try again.",
            );
            return;
          }
          const outcome = await api.repoRebaseInteractive(repo.id, base, plan);
          if (outcome.kind === "conflicts") {
            // Roll back rather than parking in the conflict state: the user
            // asked for a one-shot action, not a rebase session.
            try {
              await api.repoRebaseAbort(repo.id);
              notify.error(
                `${verb} aborted: replaying the remaining commits conflicted. The branch is unchanged.`,
              );
            } catch (abortErr) {
              // A failed recovery step must never be silent (house rule).
              notify.error(
                `${verb} conflicted AND the automatic abort failed (${formatAppError(abortErr)}). ` +
                  "Resolve or abort the rebase from the banner.",
              );
            }
          } else if (outcome.kind === "completed_with_stash_conflicts") {
            notify.success(kind === "drop" ? `Dropped ${label}.` : `Squashed ${label} into one.`);
            notify.error(outcome.message);
          } else if (outcome.kind === "already_up_to_date") {
            notify.info("Nothing to rewrite - the branch is already in that state.");
          } else {
            notify.success(kind === "drop" ? `Dropped ${label}.` : `Squashed ${label} into one.`);
          }
        } catch (e) {
          notifyOpError(e);
        } finally {
          invalidate(repo.id, [...OP_DOMAINS, "tracking", "stashes", "unpushed"]);
        }
      },

      // Multi-sha calls pass newest-first (each revert unwinds on top of the
      // previous one).
      handleRevert: async (shas: string[], mainline?: number) => {
        const repo = repoOf();
        if (!repo || shas.length === 0) return;
        const label = shas.length === 1 ? shas[0].slice(0, 8) : `${shas.length} commits`;
        try {
          const outcome = await repoRevert(repo.id, shas, mainline);
          invalidate(repo.id, OP_DOMAINS);
          notifySequenceOutcome(outcome, "revert", label);
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
          await api.repoReset(repo.id, sha, mode);
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
          await api.repoReset(repo.id, `${headSha}~1`, "soft");
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
        const c = actionCtx();
        if (c) await rebaseOnto(c, onto);
      },

      // --- checkouts ---
      handleBranchCheckout: async (name: string) => {
        const c = actionCtx();
        if (c) await checkoutBranch(c, name);
      },

      handleRemoteCheckout: async (remoteRef: string) => {
        const c = actionCtx();
        if (c) await checkoutRemoteBranch(c, remoteRef);
      },

      handleCommitCheckout: async (sha: string) => {
        const c = actionCtx();
        if (c) await checkoutCommit(c, sha);
      },

      // --- branches ---
      handleBranchRenameSave: async (oldName: string, newName: string) => {
        const c = actionCtx();
        if (c) await renameBranch(c, oldName, newName);
      },

      handleBranchDelete: async (name: string, force: boolean) => {
        const c = actionCtx();
        if (c) await deleteBranch(c, name, force);
      },

      handleSetUpstream: async (branch: string, upstream: string | null) => {
        const c = actionCtx();
        if (c) await setUpstream(c, branch, upstream);
      },

      handleBranchPush: async (branch: string, remote: string, setUpstream: boolean) => {
        const c = actionCtx();
        if (c) await pushBranch(c, branch, remote, setUpstream);
      },

      handleRemoteBranchDelete: async (remoteRef: string) => {
        const c = actionCtx();
        if (c) await deleteRemoteBranch(c, remoteRef);
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
        await api.repoRewordCommit(repo.id, commit.id, newMessage);
        invalidate(repo.id, ["log", "branches", "tracking"]);
      },

      renameStash: async (sha: string, message: string) => {
        const repo = repoOf();
        if (!repo) return;
        await api.repoRenameStash(repo.id, sha, message);
        invalidate(repo.id, STASH_DOMAINS);
      },

      // --- tags ---
      handleTagPush: async (name: string, remote: string) => {
        const c = actionCtx();
        if (c) await pushTag(c, name, remote);
      },

      handleTagDelete: async (name: string) => {
        const c = actionCtx();
        if (c) await deleteTag(c, name);
      },

      handleTagDeleteRemote: async (name: string, remote: string) => {
        const c = actionCtx();
        if (c) await deleteRemoteTag(c, name, remote);
      },

      createTag: async (name: string, target: CommitId, message: string | null) => {
        const c = actionCtx();
        if (c) await createTagAction(c, name, target, message ?? undefined);
      },

      handleStashApply: async (sha: string) => {
        const c = actionCtx();
        if (c) await applyStash(c, sha);
      },

      handleStashPop: async (sha: string) => {
        const c = actionCtx();
        if (c) await popStash(c, sha);
      },

      handleStashDrop: async (sha: string) => {
        const c = actionCtx();
        if (c) await dropStash(c, sha);
      },

      handleCreateStash: async (includeUntracked: boolean) => {
        const c = actionCtx();
        if (c) await createStash(c, { includeUntracked, keepIndex: false });
      },
    };
  }, [queryClient]);
}
