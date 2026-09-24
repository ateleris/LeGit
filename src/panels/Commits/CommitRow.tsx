// One virtualised Commits row: graph/refs/subject/date/author/sha cells plus
// the row's context menu. Memoized - the panel re-renders a row only when its
// own props change (selection flip, row data) or the shared CommitsRowContext
// value changes (data/layout); scrolling and selection elsewhere are free.

import { memo } from "react";
import type { Commit } from "../../lib/types";
import type { LaneIndex } from "./graph/types";
import { promptDialog } from "../../store/confirm";
import { formatAbsolute, formatFull, formatRelative } from "../../lib/time";
import { usePanelContextMenu } from "../shared/menu/PanelContextMenu";
import { RefsCell } from "./cells/RefsCell";
import { InlineRenameInput } from "./cells/InlineRenameInput";
import { SignatureBadge } from "./cells/SignatureBadge";
import { GraphCellWithAvatar, laneColor } from "./cells/GraphCell";
import { dotHoverTitle, subjectHoverTitle } from "./hoverTitles";
import { BulkSelectionMenu, CommitRowMenu, WorkdirRowMenu } from "./menu/RowMenu";
import { bulkMenuPlan } from "./multiSelect";
import { COLUMN_GAP } from "./columns/types";
import { WORKING_DIR_ID } from "./commitRows";
import { useCommitsRow } from "./RowContext";

function subjectOf(message: string): string {
  return message.split("\n")[0] ?? "";
}

export interface CommitRowProps {
  commit: Commit;
  rowIndex: number;
  /** The virtual item's offset (translateY). */
  start: number;
  isSelected: boolean;
  /** The virtualizer's measure ref (stable). */
  measureElement: (el: HTMLDivElement | null) => void;
}

export const CommitRow = memo(function CommitRow({
  commit,
  rowIndex,
  start,
  isSelected,
  measureElement,
}: CommitRowProps) {
  const ctx = useCommitsRow();
  const { openMenu } = usePanelContextMenu();
  const { actions, edits } = ctx;

  const isWorkingDir = commit.id === WORKING_DIR_ID;
  const commitLane = ctx.assignments.get(commit.id) ?? 0;
  const edges = ctx.edgesByCommit.get(commit.id) ?? [];

  // Active lanes at this row: the commit's own lane plus every lane that has
  // a live edge spanning this row (strictly between its two commit rows).
  // Pass-through lines are drawn only for these lanes. A span on the commit's
  // *own* lane is suppressed as a pass-through (to avoid double-drawing) but
  // must still render the own-lane vertical full height — flagged via
  // `ownLanePassThrough`.
  const activeLanes = new Set<LaneIndex>([commitLane]);
  let ownLanePassThrough = false;
  for (const span of ctx.edgeSpans) {
    if (span.fromRow < rowIndex && rowIndex < span.toRow) {
      activeLanes.add(span.lane);
      if (span.lane === commitLane) ownLanePassThrough = true;
    }
  }

  // Stash connectors covering this row (pass-through rows AND the base row
  // itself, whose jog arc finishes the line).
  let laneColorOverrides: Map<LaneIndex, string> | undefined;
  for (const span of ctx.stashConnectorSpans) {
    if (span.fromRow < rowIndex && rowIndex <= span.toRow) {
      (laneColorOverrides ??= new Map()).set(span.lane, laneColor(span.baseLane));
    }
  }

  const onContextMenu = (e: React.MouseEvent) => {
    const selection = ctx.getSelection();
    const selectedIds = selection.ids;
    const rows = ctx.getRows();
    // Right-click on a row inside a 2+ multi-selection: the bulk menu for the
    // whole set. Any other row falls through to its normal single-row menu.
    if (selectedIds.size >= 2 && selectedIds.has(commit.id) && ctx.isMultiSelectable(commit.id)) {
      // Everything data-decided lives in bulkMenuPlan (tested): the action
      // plan plus the guarded drop/squash offer with its selection snapshot
      // (the selection can change while the confirm or message dialog is open).
      const menu = bulkMenuPlan(selectedIds, rows, ctx.unpushedSet);
      if (menu) {
        const { plan, rewrite } = menu;
        openMenu(
          e,
          <BulkSelectionMenu
            plan={plan}
            opInProgress={ctx.opInProgress}
            handleCherryPick={actions.handleCherryPick}
            handleRevert={actions.handleRevert}
            rewrite={rewrite ? { contiguous: rewrite.contiguous } : null}
            onDrop={() => {
              if (rewrite) {
                void actions.handleBulkRewrite("drop", rewrite.selectedSnapshot, rewrite.base, null);
              }
            }}
            onSquash={() => {
              if (!rewrite) return;
              void (async () => {
                const message = await promptDialog({
                  title: `Squash ${rewrite.selectedSnapshot.size} commits`,
                  message: "Commit message for the squashed commit:",
                  confirmLabel: "Squash",
                  danger: false,
                  input: { initialValue: rewrite.squashPrefill },
                });
                if (message !== null) {
                  void actions.handleBulkRewrite("squash", rewrite.selectedSnapshot, rewrite.base, message);
                }
              })();
            }}
          />,
        );
        return;
      }
    }
    if (commit.id === WORKING_DIR_ID) {
      openMenu(e, <WorkdirRowMenu handleCreateStash={actions.handleCreateStash} />);
      return;
    }
    // Author-specific entries only when the click landed in the Author cell
    // (keeps the row menu uncluttered).
    const inAuthorCell = (e.target as HTMLElement).closest('[data-col="author"]') !== null;
    openMenu(
      e,
      <CommitRowMenu
        commit={commit}
        stashSelector={ctx.stashSelectorById.get(commit.id)}
        inAuthorCell={inAuthorCell}
        opInProgress={ctx.opInProgress}
        headSha={ctx.headSha}
        headIsRewordable={ctx.headIsRewordable}
        hasUpstream={!!ctx.currentBranchLocal?.upstream}
        trackingAhead={ctx.tracking?.ahead ?? null}
        currentBranchName={ctx.currentBranch}
        branches={ctx.branches}
        remoteNames={ctx.remotes}
        pushedTags={ctx.pushedTags}
        tagTargetsOnRemote={ctx.tagTargetsOnRemote}
        tagRemote={ctx.tagRemote}
        commitMessageById={ctx.commitMessageById}
        upstreamCandidatesFor={ctx.upstreamCandidatesFor}
        setAuthorFilter={ctx.setAuthorFilter}
        clearSearch={ctx.clearSearch}
        handleRewordStart={edits.handleRewordStart}
        handleUndoLastCommit={actions.handleUndoLastCommit}
        handleCommitCheckout={actions.handleCommitCheckout}
        handleCreateBranchStart={edits.handleCreateBranchStart}
        handleCreateTagStart={edits.handleCreateTagStart}
        handleCherryPick={actions.handleCherryPick}
        handleRevert={actions.handleRevert}
        handleReset={actions.handleReset}
        handleMerge={actions.handleMerge}
        handleRebaseOnto={actions.handleRebaseOnto}
        handleBranchCheckout={actions.handleBranchCheckout}
        handleBranchRename={edits.handleBranchRename}
        handleBranchPush={actions.handleBranchPush}
        handleSetUpstream={actions.handleSetUpstream}
        handleBranchDelete={actions.handleBranchDelete}
        handleRemoteCheckout={actions.handleRemoteCheckout}
        handleRemoteBranchDelete={actions.handleRemoteBranchDelete}
        handleTagPush={actions.handleTagPush}
        handleTagDelete={actions.handleTagDelete}
        handleTagDeleteRemote={actions.handleTagDeleteRemote}
        handleStashApply={actions.handleStashApply}
        handleStashPop={actions.handleStashPop}
        handleStashBranchStart={edits.handleStashBranchStart}
        handleStashRename={edits.handleStashRename}
        handleStashDrop={actions.handleStashDrop}
      />,
    );
  };

  return (
    <div
      data-index={rowIndex}
      ref={measureElement}
      // Hover + selection backgrounds live in global.css (classes, because
      // :hover can't be expressed in inline styles).
      className={`legit-commit-row${isSelected ? " legit-commit-row--selected" : ""}`}
      onClick={(e) => ctx.onRowClick(commit, e)}
      // Shift+click extends the selection - keep the browser from also
      // sweeping a text selection across the rows.
      onMouseDown={(e) => {
        if (e.shiftKey) e.preventDefault();
      }}
      onContextMenu={onContextMenu}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        transform: `translateY(${start}px)`,
        paddingLeft: "1em",
        paddingRight: "1em",
        cursor: "pointer",
        display: "grid",
        gridTemplateColumns: ctx.gridColumns,
        gap: `0 ${COLUMN_GAP}px`,
        alignItems: "center",
        height: ctx.rowHeight,
      }}
    >
      {ctx.visibleColumns.map((colId) => {
        switch (colId) {
          case "refs":
            return (
              <div key="refs" style={{ overflow: "hidden" }}>
                <RefsCell
                  decorations={commit.decorations ?? []}
                  worktreeHeads={ctx.worktreeHeadsBySha.get(commit.id)}
                  laneChip={
                    ctx.laneChipFilters
                      ? { tint: laneColor(commitLane), ...ctx.laneChipFilters }
                      : null
                  }
                  creatingBranch={edits.branchCreation?.rowId === commit.id}
                  creatingTag={edits.tagCreation?.rowId === commit.id}
                />
              </div>
            );
          case "graph":
            return (
              <div
                key="graph"
                style={{
                  overflow: "visible",
                  alignSelf: "stretch",
                  display: "flex",
                  alignItems: "stretch",
                }}
              >
                <GraphCellWithAvatar
                  commitId={commit.id}
                  commitLane={commitLane}
                  totalLanes={ctx.maxVisibleLane + 1}
                  activeLanes={activeLanes}
                  edges={edges}
                  incomingEdges={ctx.incomingEdgesByCommit.get(commit.id) ?? []}
                  rowHeight={ctx.rowHeight}
                  laneSpacing={ctx.laneSpacing}
                  dotRadius={ctx.dotRadius}
                  lineWidth={ctx.lineWidth}
                  ownLanePassThrough={ownLanePassThrough}
                  laneColorOverrides={laneColorOverrides}
                  hollow={isWorkingDir}
                  isStash={ctx.stashSelectorById.has(commit.id)}
                  stashNodeColor={
                    // Per-theme: paint the stash with its BASE commit's lane
                    // so it reads as belonging to the branch it was taken from
                    // (base outside the loaded window falls back to the own lane).
                    ctx.stashBaseLaneColor &&
                    ctx.stashSelectorById.has(commit.id) &&
                    commit.parents[0] !== undefined &&
                    ctx.assignments.has(commit.parents[0])
                      ? laneColor(ctx.assignments.get(commit.parents[0])!)
                      : null
                  }
                  avatarEmail={
                    // Only regular commit dots carry an avatar — not the
                    // working-dir ring or stash squares.
                    ctx.avatarsEnabled &&
                    !isWorkingDir &&
                    !ctx.stashSelectorById.has(commit.id) &&
                    commit.author.email
                      ? commit.author.email
                      : null
                  }
                  initialsName={
                    ctx.initialsEnabled && !isWorkingDir && !ctx.stashSelectorById.has(commit.id)
                      ? commit.author.name
                      : null
                  }
                  dotTitle={
                    !isWorkingDir && !ctx.stashSelectorById.has(commit.id)
                      ? dotHoverTitle(commit.author.name, commit.author.email)
                      : null
                  }
                />
              </div>
            );
          case "signed":
            // Icon-only column: presence chip, upgraded to the verified
            // verdict once the commit has been inspected in Commit Details
            // (session signature cache).
            return (
              <div
                key="signed"
                style={{ overflow: "hidden", display: "flex", alignItems: "center" }}
              >
                {!isWorkingDir && (
                  <SignatureBadge
                    signature={ctx.verifiedSignatures?.[commit.id] ?? null}
                    hasSignature={ctx.signedSet.has(commit.id)}
                    size={ctx.textSize}
                  />
                )}
              </div>
            );
          case "subject": {
            // The checked-out commit's subject renders bold — the row-level
            // counterpart of the dot on the current branch's chip.
            const isHeadRow = (commit.decorations ?? []).some(
              (d) => d.type === "head" || d.type === "headOf",
            );
            // In-place edit: reword (subject line; a body is kept verbatim)
            // or stash rename (the whole reflog subject).
            if (edits.subjectEdit?.id === commit.id) {
              return (
                <InlineRenameInput
                  key="subject"
                  initialValue={
                    edits.subjectEdit.kind === "reword"
                      ? subjectOf(commit.message)
                      : commit.message
                  }
                  disabled={edits.subjectBusy}
                  onSave={(value) => void edits.handleSubjectEditSave(commit, value)}
                  onCancel={edits.handleSubjectEditCancel}
                  title="Enter to save · Esc to cancel"
                  style={{
                    width: "100%",
                    fontSize: ctx.textSize,
                    padding: "0 0.333em",
                  }}
                />
              );
            }
            return (
              <span
                key="subject"
                data-testid="commit-subject"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.417em",
                  fontSize: ctx.textSize,
                  fontStyle: isWorkingDir ? "italic" : undefined,
                  fontWeight: isHeadRow ? 700 : undefined,
                  overflow: "hidden",
                }}
              >
                <span
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  // Full message on hover, but only when the cell hides
                  // something (clipped subject or a body). Clipping depends on
                  // the live column width, so it's measured per hover, not per
                  // render.
                  onMouseEnter={(e) => {
                    const el = e.currentTarget;
                    el.title = subjectHoverTitle(
                      commit.message,
                      el.scrollWidth > el.clientWidth,
                    );
                  }}
                >
                  {subjectOf(commit.message)}
                </span>
              </span>
            );
          }
          case "date":
            return (
              <span
                key="date"
                // Hover complements the cell: the exact author datetime
                // (author's timezone) when the cell is relative, plus the
                // relative form when the cell shows the absolute date.
                title={
                  isWorkingDir
                    ? undefined
                    : ctx.dateAbsolute
                      ? `${formatFull(commit.timestamp, commit.author.tz_offset_minutes)} (${formatRelative(commit.timestamp)})`
                      : formatFull(commit.timestamp, commit.author.tz_offset_minutes)
                }
                style={{
                  fontSize: ctx.textSize,
                  color: "var(--subtle-fg)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {isWorkingDir
                  ? ""
                  : ctx.dateAbsolute
                    ? formatAbsolute(commit.timestamp, commit.author.tz_offset_minutes, ctx.dateFormat, ctx.dateShowTime)
                    : formatRelative(commit.timestamp)}
              </span>
            );
          case "author":
            return (
              <span
                key="author"
                // Marks the cell for the row menu's author-scoped entries
                // (right-click here offers the author filter).
                data-col="author"
                style={{
                  fontSize: ctx.textSize,
                  color: "var(--subtle-fg)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {isWorkingDir ? "" : commit.author.name}
              </span>
            );
          case "sha":
            return (
              <span
                key="sha"
                style={{
                  fontSize: ctx.textSize,
                  color: "var(--subtle-fg)",
                  fontFamily: "monospace",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {isWorkingDir ? "" : commit.id.slice(0, 8)}
              </span>
            );
          default:
            return null;
        }
      })}
    </div>
  );
});
