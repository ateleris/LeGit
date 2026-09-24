// In-place editing state for the Commits rows: rewording a subject / renaming
// a stash (the subject cell becomes an input), renaming a branch inside its
// ref chip, and the create-branch / create-tag chip inputs. The panel renders
// from this state; every mutation routes through useCommitActions.

import { useCallback, useEffect, useMemo, useState, type MutableRefObject } from "react";
import type { QueryClient } from "@tanstack/react-query";
import type { Virtualizer } from "@tanstack/react-virtual";
import type { Commit, CommitId, RepoSummary } from "../../lib/types";
import { formatAppError } from "../../lib/errors";
import { notify } from "../../store/notifications";
import { createBranch, stashBranch } from "../../lib/refActions";
import { shouldCenterScroll } from "./scrollToRow";
import type { useCommitActions } from "./useCommitActions";

type CommitActions = ReturnType<typeof useCommitActions>;
type RowVirtualizer = Virtualizer<HTMLDivElement, Element>;

export function useInlineEdits(args: {
  repo: RepoSummary;
  actions: CommitActions;
  queryClient: QueryClient;
  /** Global setting (default on): creating a branch also checks it out. */
  checkoutNewBranch: boolean;
  headId: CommitId | null;
  rowsRef: MutableRefObject<readonly Commit[]>;
  virtualizerRef: MutableRefObject<RowVirtualizer>;
}) {
  const { repo, actions, queryClient, checkoutNewBranch, headId, rowsRef, virtualizerRef } = args;

  // In-place editing in the Subject column: rewording a commit's subject line
  // or renaming a stash's message. The row keeps its normal layout — only the
  // subject text is swapped for an input (Enter approves, Esc discards).
  const [subjectEdit, setSubjectEdit] = useState<
    { kind: "reword" | "stashRename"; id: string } | null
  >(null);
  const [subjectBusy, setSubjectBusy] = useState(false);

  // Branch being renamed in place inside its ref chip (short name, unique
  // across the repo — at most one chip matches).
  const [renamingBranch, setRenamingBranch] = useState<string | null>(null);

  // Create-new-branch mode: shows an empty branch-name input on `rowId`'s ref
  // cell; the branch is only created when a name is confirmed. From the
  // toolbar the input sits on the HEAD row and `startPoint` is undefined
  // (git branches at HEAD proper); from a row's context menu the clicked
  // commit's SHA is the explicit start point. With `stashSha` set (a stash
  // row's "Branch from stash…"), confirming runs `git stash branch` instead:
  // branch at the stash's base, stash applied and dropped.
  const [branchCreation, setBranchCreation] = useState<
    { rowId: CommitId; startPoint?: string; stashSha?: string } | null
  >(null);

  // Create-new-tag mode (row context menu): same pattern as branchCreation;
  // the input creates a lightweight tag at the clicked commit. Annotated tags
  // (with a message) are created via the Refs panel's Tags section.
  const [tagCreation, setTagCreation] = useState<{ rowId: CommitId } | null>(null);

  // Discard any in-place edit when the active repo changes — the edited
  // commit/stash/branch belongs to the previous repo.
  useEffect(() => {
    setSubjectEdit(null);
    setRenamingBranch(null);
    setBranchCreation(null);
    setTagCreation(null);
  }, [repo.id]);

  // Branch rename happens in place, inside the branch's ref chip.
  const handleBranchRename = useCallback((name: string) => {
    setRenamingBranch(name);
  }, []);

  const handleBranchRenameSave = useCallback(
    async (oldName: string, newName: string) => {
      setRenamingBranch(null);
      await actions.handleBranchRenameSave(oldName, newName);
    },
    [actions],
  );

  const handleBranchRenameCancel = useCallback(() => {
    setRenamingBranch(null);
  }, []);

  const handleRewordStart = useCallback((commit: Commit) => {
    setSubjectEdit({ kind: "reword", id: commit.id });
    setSubjectBusy(false);
  }, []);

  const handleSubjectEditCancel = useCallback(() => {
    setSubjectEdit(null);
    setSubjectBusy(false);
  }, []);

  // Save the in-place subject edit. For a reword, only the subject line is
  // edited — a multi-line body (everything after the first line) is preserved
  // verbatim. For a stash, the whole reflog subject is the message. On failure
  // the editor stays open (toast carries the error) so the draft isn't lost.
  const handleSubjectEditSave = useCallback(
    async (commit: Commit, value: string) => {
      if (!subjectEdit) return;
      setSubjectBusy(true);
      try {
        if (subjectEdit.kind === "reword") {
          await actions.rewordCommit(commit, value);
        } else {
          await actions.renameStash(commit.id, value);
        }
        setSubjectEdit(null);
      } catch (e) {
        notify.error(formatAppError(e));
      } finally {
        setSubjectBusy(false);
      }
    },
    [subjectEdit, actions],
  );

  // Create-new-tag flow: the input shows on the clicked row; the (lightweight)
  // tag is only created when a name is confirmed.
  const handleCreateTagStart = useCallback((commitId: CommitId) => {
    setTagCreation({ rowId: commitId });
  }, []);

  const handleCreateTagSave = useCallback(
    async (name: string) => {
      const creation = tagCreation;
      setTagCreation(null);
      if (!creation) return;
      await actions.createTag(name, creation.rowId, null);
    },
    [tagCreation, actions],
  );

  const handleCreateTagCancel = useCallback(() => {
    setTagCreation(null);
  }, []);

  // Stash rename happens in place: the stash row's subject (which shows the
  // stash message) becomes an input.
  const handleStashRename = useCallback((sha: string) => {
    setSubjectEdit({ kind: "stashRename", id: sha });
    setSubjectBusy(false);
  }, []);

  const scrollRowIntoView = useCallback(
    (rowId: string) => {
      const idx = rowsRef.current.findIndex((c) => c.id === rowId);
      if (idx >= 0 && shouldCenterScroll(idx, virtualizerRef.current.range)) {
        virtualizerRef.current.scrollToIndex(idx, { align: "center" });
      }
    },
    [rowsRef, virtualizerRef],
  );

  // Create-new-branch flow: scroll the target row into view and show the
  // empty branch-name input there; the branch is only created when a name is
  // confirmed (Esc leaves no trace). No `startPoint` = branch at HEAD proper
  // (the toolbar button); a commit SHA = branch from that commit (row menu).
  const handleCreateBranchStart = useCallback(
    (startPoint?: string) => {
      const rowId = startPoint ?? headId;
      if (rowId === null) return; // empty repo — nothing to branch from
      setBranchCreation({ rowId, startPoint });
      scrollRowIntoView(rowId);
    },
    [headId, scrollRowIntoView],
  );

  // "Branch from stash…" — reuses the create-branch chip input on the stash's
  // own row; the save handler routes to `git stash branch` via `stashSha`.
  const handleStashBranchStart = useCallback(
    (sha: string) => {
      setBranchCreation({ rowId: sha, stashSha: sha });
      scrollRowIntoView(sha);
    },
    [scrollRowIntoView],
  );

  const handleCreateBranchSave = useCallback(
    async (name: string) => {
      const creation = branchCreation;
      setBranchCreation(null);
      if (!creation) return;
      const ctx = { queryClient, repo };
      if (creation.stashSha) await stashBranch(ctx, creation.stashSha, name);
      // Global setting (default on): a new branch is checked out right away.
      else await createBranch(ctx, name, creation.startPoint, { checkout: checkoutNewBranch });
    },
    [repo, branchCreation, checkoutNewBranch, queryClient],
  );

  const handleCreateBranchCancel = useCallback(() => {
    setBranchCreation(null);
  }, []);

  // Memoized so consumers (the row context) get a new identity exactly when
  // an edit state or handler actually changed.
  return useMemo(
    () => ({
      subjectEdit,
      subjectBusy,
      renamingBranch,
      branchCreation,
      tagCreation,
      handleBranchRename,
      handleBranchRenameSave,
      handleBranchRenameCancel,
      handleRewordStart,
      handleSubjectEditCancel,
      handleSubjectEditSave,
      handleCreateTagStart,
      handleCreateTagSave,
      handleCreateTagCancel,
      handleStashRename,
      handleCreateBranchStart,
      handleStashBranchStart,
      handleCreateBranchSave,
      handleCreateBranchCancel,
    }),
    [
      subjectEdit,
      subjectBusy,
      renamingBranch,
      branchCreation,
      tagCreation,
      handleBranchRename,
      handleBranchRenameSave,
      handleBranchRenameCancel,
      handleRewordStart,
      handleSubjectEditCancel,
      handleSubjectEditSave,
      handleCreateTagStart,
      handleCreateTagSave,
      handleCreateTagCancel,
      handleStashRename,
      handleCreateBranchStart,
      handleStashBranchStart,
      handleCreateBranchSave,
      handleCreateBranchCancel,
    ],
  );
}
