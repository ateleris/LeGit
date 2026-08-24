import { useSummonStore } from "../../../store/summon";
import { copyAndNotify } from "../../../lib/clipboard";
import type { Branch, Commit, CommitId, MergeOptions, ResetMode } from "../../../lib/types";
import { BranchIcon, RemoteIcon, TagIcon } from "../../../icons";
import { openStashDiff } from "../../Stashes/StashesPanel";
import { branchesAt } from "../cells/refChips";
import { mainlineChoices } from "../mainline";
import { undoLastCommitPlan } from "../undoLastCommit";
import type { BulkPlan } from "../multiSelect";
import { usePanelContextMenu } from "./PanelContextMenu";
import { MenuItem, SectionLabel, Separator, Submenu } from "./primitives";
import { BranchMenuSection, RemoteBranchMenuSection } from "./BranchMenuSection";
import { StashMenuSection } from "./StashMenuSection";
import { TagMenuSection } from "./TagMenuSection";
import { ResetMenuItems } from "./ResetMenuItems";
import { UndoLastCommitMenuItem } from "./UndoLastCommitMenuItem";

// The Commits panel's row context menus, extracted from CommitsPanel.tsx
// (2026-08-24 structural split). Three menus, one per row kind: a 2+
// multi-selection, the synthetic uncommitted-changes row, and a normal
// commit/stash row. All render inside the panel's PanelContextMenuProvider,
// so `closeMenu` comes from the menu context rather than prop-threading.

/** Small inline note rendered inside a menu (merge caveats etc.). */
function MenuNote({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: "4px 14px 6px",
        fontSize: "var(--fz-sm)",
        color: "var(--subtle-fg)",
        maxWidth: 280,
        whiteSpace: "normal",
        cursor: "default",
      }}
    >
      {children}
    </div>
  );
}

/** Bulk menu for a right-click inside a 2+ multi-selection. */
export function BulkSelectionMenu({
  plan,
  opInProgress,
  handleCherryPick,
  handleRevert,
}: {
  plan: BulkPlan;
  opInProgress: boolean;
  handleCherryPick: (shas: CommitId[], mainline?: number) => void;
  handleRevert: (shas: CommitId[], mainline?: number) => void;
}) {
  const { closeMenu } = usePanelContextMenu();
  const comparePair = plan.compare;
  return (
    <>
      <SectionLabel>{plan.count} commits selected</SectionLabel>
      <MenuItem
        onClick={() => {
          closeMenu();
          void copyAndNotify(plan.revertShas.join("\n"), "Commit SHAs");
        }}
      >
        Copy SHAs
      </MenuItem>
      {/* Sequencer ops hidden while one is in progress, like the
          single-row menu. */}
      {!opInProgress && (
        <>
          <MenuItem
            disabled={plan.containsMerge}
            onClick={() => { closeMenu(); handleCherryPick(plan.cherryPickShas); }}
          >
            Cherry-pick {plan.count} commits
          </MenuItem>
          <MenuItem
            disabled={plan.containsMerge}
            onClick={() => { closeMenu(); handleRevert(plan.revertShas); }}
          >
            Revert {plan.count} commits
          </MenuItem>
          {plan.containsMerge && (
            <MenuNote>
              The selection contains a merge commit - cherry-pick
              or revert it on its own to choose a mainline parent.
            </MenuNote>
          )}
        </>
      )}
      {comparePair && (
        <MenuItem
          onClick={() => {
            closeMenu();
            useSummonStore.getState().summon("compare", comparePair);
          }}
        >
          Compare selected commits
        </MenuItem>
      )}
    </>
  );
}

/** Menu of the synthetic uncommitted-changes row. */
export function WorkdirRowMenu({
  handleCreateStash,
}: {
  handleCreateStash: (includeUntracked: boolean) => void;
}) {
  const { closeMenu } = usePanelContextMenu();
  return (
    <>
      <SectionLabel>Uncommitted changes</SectionLabel>
      <MenuItem onClick={() => { closeMenu(); handleCreateStash(false); }}>
        Stash changes
      </MenuItem>
      <MenuItem onClick={() => { closeMenu(); handleCreateStash(true); }}>
        Stash changes (incl. untracked)
      </MenuItem>
    </>
  );
}

export interface CommitRowMenuProps {
  commit: Commit;
  /** Stash `stash@{N}` selector when this row IS a stash; undefined for
   *  ordinary commits. */
  stashSelector: string | undefined;
  /** The click landed in the Author cell (gates the author-filter entry). */
  inAuthorCell: boolean;
  opInProgress: boolean;
  headSha: string | null;
  headIsRewordable: boolean;
  /** The current branch tracks an upstream (undo-last-commit gating). */
  hasUpstream: boolean;
  /** Commits ahead of upstream, null when unknown (undo gating). */
  trackingAhead: number | null;
  currentBranchName: string | null;
  branches: Branch[];
  remoteNames: string[];
  pushedTags: ReadonlySet<string>;
  tagTargetsOnRemote: ReadonlySet<string>;
  tagRemote: string | null;
  commitMessageById: ReadonlyMap<string, string>;
  upstreamCandidatesFor: (name: string) => string[];
  setAuthorFilter: (author: { name: string; email: string }) => void;
  clearSearch: () => void;
  handleRewordStart: (commit: Commit) => void;
  handleUndoLastCommit: (id: CommitId) => void;
  handleCommitCheckout: (id: CommitId) => void;
  handleCreateBranchStart: (startPoint?: string) => void;
  handleCreateTagStart: (id: CommitId) => void;
  handleCherryPick: (shas: CommitId[], mainline?: number) => void;
  handleRevert: (shas: CommitId[], mainline?: number) => void;
  handleReset: (id: CommitId, mode: ResetMode) => void;
  handleMerge: (target: string, options: MergeOptions) => void;
  handleRebaseOnto: (target: string) => void;
  handleBranchCheckout: (name: string) => void;
  handleBranchRename: (name: string) => void;
  handleBranchPush: (name: string, remote: string, setUpstream: boolean) => void;
  handleSetUpstream: (name: string, upstream: string | null) => void;
  handleBranchDelete: (name: string, force: boolean) => void;
  handleRemoteCheckout: (name: string) => void;
  handleRemoteBranchDelete: (name: string) => Promise<unknown> | void;
  handleTagPush: (name: string, remote: string) => void;
  handleTagDelete: (name: string) => void;
  handleTagDeleteRemote: (name: string, remote: string) => void;
  handleStashApply: (sha: string) => void;
  handleStashPop: (sha: string) => void;
  handleStashBranchStart: (sha: string) => void;
  handleStashRename: (sha: string) => void;
  handleStashDrop: (sha: string) => void;
}

/** Menu of a normal commit row (or a stash row, which gets the shared
 *  stash section instead). */
export function CommitRowMenu(props: CommitRowMenuProps) {
  const { closeMenu } = usePanelContextMenu();
  const {
    commit,
    stashSelector,
    inAuthorCell,
    opInProgress,
    headSha,
    headIsRewordable,
    hasUpstream,
    trackingAhead,
    currentBranchName,
    branches,
    remoteNames,
    pushedTags,
    tagTargetsOnRemote,
    tagRemote,
    commitMessageById,
    upstreamCandidatesFor,
    setAuthorFilter,
    clearSearch,
    handleRewordStart,
    handleUndoLastCommit,
    handleCommitCheckout,
    handleCreateBranchStart,
    handleCreateTagStart,
    handleCherryPick,
    handleRevert,
    handleReset,
    handleMerge,
    handleRebaseOnto,
    handleBranchCheckout,
    handleBranchRename,
    handleBranchPush,
    handleSetUpstream,
    handleBranchDelete,
    handleRemoteCheckout,
    handleRemoteBranchDelete,
    handleTagPush,
    handleTagDelete,
    handleTagDeleteRemote,
    handleStashApply,
    handleStashPop,
    handleStashBranchStart,
    handleStashRename,
    handleStashDrop,
  } = props;

  if (stashSelector) {
    // Same shared section as the stash chip's menu — keeps the two in
    // parity, including the Drop confirm step.
    return (
      <StashMenuSection
        selector={stashSelector}
        onViewDiff={() => { closeMenu(); openStashDiff(commit.id); }}
        onApply={() => { closeMenu(); handleStashApply(commit.id); }}
        onPop={() => { closeMenu(); handleStashPop(commit.id); }}
        onBranch={() => { closeMenu(); handleStashBranchStart(commit.id); }}
        onRename={() => { closeMenu(); handleStashRename(commit.id); }}
        onDrop={() => { closeMenu(); handleStashDrop(commit.id); }}
      />
    );
  }

  // Branch sections for every branch decorating this row — the same shared
  // sections the ref chips use, so the actions (and the delete Confirm
  // step) stay in parity.
  const rowBranches = branchesAt(commit.decorations ?? []);
  const rowTags = (commit.decorations ?? [])
    .filter((d) => d.type === "tag")
    .map((d) => (d as { value: string }).value.replace(/^refs\/tags\//, ""));
  const hasRefSections =
    rowBranches.local.length > 0 || rowBranches.remote.length > 0 || rowTags.length > 0;
  // Merge commits need a mainline parent for cherry-pick / revert (-m N);
  // null = regular commit, run directly.
  const mainline = mainlineChoices(commit, (id) => commitMessageById.get(id) ?? null);
  const undoPlan = undoLastCommitPlan({
    isHeadRow: commit.id === headSha,
    hasParent: (commit.parents?.length ?? 0) > 0,
    opInProgress,
    hasUpstream,
    ahead: trackingAhead,
  });

  return (
    <>
      <SectionLabel>{commit.id.slice(0, 8)}</SectionLabel>
      <MenuItem onClick={() => { closeMenu(); void copyAndNotify(commit.id, "Commit SHA"); }}>
        Copy SHA
      </MenuItem>
      <MenuItem onClick={() => { closeMenu(); void copyAndNotify(commit.message, "Commit message"); }}>
        Copy message
      </MenuItem>
      <MenuItem onClick={() => { closeMenu(); handleCommitCheckout(commit.id); }}>
        Checkout commit
      </MenuItem>
      <MenuItem onClick={() => { closeMenu(); handleCreateBranchStart(commit.id); }}>
        Create branch here…
      </MenuItem>
      <MenuItem onClick={() => { closeMenu(); handleCreateTagStart(commit.id); }}>
        Create tag here…
      </MenuItem>
      <MenuItem
        onClick={() => {
          closeMenu();
          useSummonStore.getState().summon("files", { rev: commit.id });
        }}
      >
        Browse files at this commit
      </MenuItem>
      {inAuthorCell && (
        <MenuItem
          onClick={() => {
            closeMenu();
            setAuthorFilter({ name: commit.author.name, email: commit.author.email });
            // A search's hits may not be by this author - cycling would
            // only toast. Same as branch filter.
            clearSearch();
          }}
        >
          Show only commits by '{commit.author.name}'
        </MenuItem>
      )}
      {commit.id === headSha && headIsRewordable && (
        <MenuItem onClick={() => { closeMenu(); handleRewordStart(commit); }}>
          Reword message…
        </MenuItem>
      )}
      {undoPlan !== "hidden" && (
        <UndoLastCommitMenuItem
          pushed={undoPlan === "warn_pushed"}
          onUndo={() => { closeMenu(); handleUndoLastCommit(commit.id); }}
        />
      )}
      {/* Sequencer ops are hidden while a merge/rebase/cherry-pick/revert
          is already in progress. */}
      {!opInProgress && (
        <>
          <Separator />
          {mainline ? (
            // A merge's "change" is ambiguous - ask which parent to measure
            // against instead of surfacing git's raw "-m required" error.
            <>
              <Submenu label="Cherry-pick commit">
                <SectionLabel>Apply changes relative to…</SectionLabel>
                {mainline.map((c) => (
                  <MenuItem
                    key={c.mainline}
                    onClick={() => { closeMenu(); handleCherryPick([commit.id], c.mainline); }}
                  >
                    {c.label}
                  </MenuItem>
                ))}
              </Submenu>
              <Submenu label="Revert commit">
                <SectionLabel>Undo changes relative to…</SectionLabel>
                {mainline.map((c) => (
                  <MenuItem
                    key={c.mainline}
                    onClick={() => { closeMenu(); handleRevert([commit.id], c.mainline); }}
                  >
                    {c.label}
                  </MenuItem>
                ))}
                {/* The classic merge-revert caveat: history still records
                    the merge. */}
                <MenuNote>
                  History keeps the merge: re-merging the branch
                  later restores nothing.
                </MenuNote>
              </Submenu>
            </>
          ) : (
            <>
              <MenuItem onClick={() => { closeMenu(); handleCherryPick([commit.id]); }}>
                Cherry-pick commit
              </MenuItem>
              <MenuItem onClick={() => { closeMenu(); handleRevert([commit.id]); }}>
                Revert commit
              </MenuItem>
            </>
          )}
          <MenuItem
            onClick={() => {
              closeMenu();
              useSummonStore.getState().summon("interactive-rebase", commit.id);
            }}
          >
            Interactive rebase from here…
          </MenuItem>
          <MenuItem
            onClick={() => {
              closeMenu();
              useSummonStore.getState().summon("compare", { from: commit.id, to: "HEAD" });
            }}
          >
            Compare with HEAD
          </MenuItem>
          <ResetMenuItems
            branch={currentBranchName}
            onReset={(mode) => { closeMenu(); handleReset(commit.id, mode); }}
          />
        </>
      )}
      {/* One submenu entry per decorating ref: keeps the row menu O(refs)
          long while the flyouts reuse the same shared sections as the ref
          chips (action parity, incl. the delete Confirm takeover). */}
      {hasRefSections && <Separator />}
      {rowBranches.local.map((b) => (
        <Submenu
          key={`local-${b.name}`}
          label={<><BranchIcon /> {b.isCurrent ? `${b.name} (current)` : b.name}</>}
        >
          <BranchMenuSection
            name={b.name}
            isCurrent={b.isCurrent}
            currentBranch={currentBranchName}
            opInProgress={opInProgress}
            upstream={branches.find((x) => !x.is_remote && x.name === b.name)?.upstream ?? null}
            upstreamCandidates={upstreamCandidatesFor(b.name)}
            remotes={remoteNames}
            onCheckout={() => { closeMenu(); handleBranchCheckout(b.name); }}
            onRename={() => { closeMenu(); handleBranchRename(b.name); }}
            onPush={(remote, setUpstream) => { closeMenu(); handleBranchPush(b.name, remote, setUpstream); }}
            onSetUpstream={(up) => { closeMenu(); handleSetUpstream(b.name, up); }}
            onDelete={(force) => { closeMenu(); handleBranchDelete(b.name, force); }}
            onMerge={(options) => { closeMenu(); handleMerge(b.name, options); }}
            onRebaseOnto={() => { closeMenu(); handleRebaseOnto(b.name); }}
          />
        </Submenu>
      ))}
      {rowBranches.remote.map((name) => (
        <Submenu key={`remote-${name}`} label={<><RemoteIcon /> {name}</>}>
          <RemoteBranchMenuSection
            remoteName={name}
            currentBranch={currentBranchName}
            opInProgress={opInProgress}
            onCheckout={() => { closeMenu(); handleRemoteCheckout(name); }}
            onMerge={(options) => { closeMenu(); handleMerge(name, options); }}
            onRebaseOnto={() => { closeMenu(); handleRebaseOnto(name); }}
            onDeleteRemote={() => { closeMenu(); void handleRemoteBranchDelete(name); }}
          />
        </Submenu>
      ))}
      {rowTags.map((name) => (
        <Submenu key={`tag-${name}`} label={<><TagIcon /> {name}</>}>
          <TagMenuSection
            name={name}
            pushed={pushedTags.has(name)}
            targetOnRemote={tagTargetsOnRemote.has(name)}
            remote={tagRemote}
            remotes={remoteNames}
            onPush={(remote) => { closeMenu(); handleTagPush(name, remote); }}
            onDelete={() => { closeMenu(); handleTagDelete(name); }}
            onDeleteRemote={(remote) => { closeMenu(); handleTagDeleteRemote(name, remote); }}
          />
        </Submenu>
      ))}
    </>
  );
}
