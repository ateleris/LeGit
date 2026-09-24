// Shared, panel-constant inputs for the Commits rows: ref/branch/tag action
// handlers (consumed by RefsCell and the row menus), rendering config, and
// stable GETTERS for volatile state (selection, rows) so a memoized CommitRow
// is not re-rendered by every selection change - it reads those at event
// time instead.

import { createContext, useContext } from "react";
import type {
  Branch,
  Commit,
  CommitId,
  LaneLock,
  SignatureVerification,
  TrackingStatus,
} from "../../lib/types";
import type { WorktreeMark } from "../Worktrees/worktreeRows";
import type { SelectionState } from "./multiSelect";
import type { useCommitActions } from "./useCommitActions";
import type { useInlineEdits } from "./useInlineEdits";
import type { TokenFilterId } from "../../lib/types";
import type { LaneEdge } from "./graph/types";
import type { EdgeSpan, StashConnectorSpan } from "./graph/spans";
import type { ColumnId } from "./columns/types";

type CommitActions = ReturnType<typeof useCommitActions>;
type InlineEdits = ReturnType<typeof useInlineEdits>;

export interface CommitsRowContextValue {
  repoId: string;
  // --- rendering config (global settings / theme) --------------------------
  textSize: number;
  rowHeight: number;
  laneSpacing: number;
  dotRadius: number;
  lineWidth: number;
  avatarsEnabled: boolean;
  initialsEnabled: boolean;
  dateAbsolute: boolean;
  dateFormat: "iso" | "swiss" | "uk" | "us";
  dateShowTime: boolean;
  laneChipFilters: {
    fg: TokenFilterId | null;
    border: TokenFilterId | null;
    bg: TokenFilterId | null;
  } | null;
  stashBaseLaneColor: boolean;
  // --- per-repo data --------------------------------------------------------
  locks: LaneLock[];
  upstreamMap: Map<string, string>;
  worktreeBranches: ReadonlyMap<string, WorktreeMark>;
  worktreeHeadsBySha: ReadonlyMap<string, { name: string; path: string; dirty: boolean }[]>;
  branches: Branch[];
  remotes: string[];
  currentBranch: string | null;
  currentBranchLocal: Branch | null;
  tracking: TrackingStatus | null;
  headSha: string | null;
  headIsRewordable: boolean;
  pushedTags: ReadonlySet<string>;
  tagTargetsOnRemote: ReadonlySet<string>;
  tagRemote: string | null;
  unpushedSet: ReadonlySet<CommitId>;
  commitMessageById: Map<string, string>;
  stashSelectorById: ReadonlyMap<string, string>;
  signedSet: ReadonlySet<string>;
  verifiedSignatures: Record<string, SignatureVerification> | undefined;
  opInProgress: boolean;
  // --- graph model + column layout -------------------------------------------
  assignments: ReadonlyMap<string, number>;
  edgesByCommit: ReadonlyMap<string, LaneEdge[]>;
  incomingEdgesByCommit: ReadonlyMap<string, LaneEdge[]>;
  edgeSpans: readonly EdgeSpan[];
  stashConnectorSpans: readonly StashConnectorSpan[];
  visibleColumns: readonly ColumnId[];
  gridColumns: string;
  maxVisibleLane: number;
  // --- volatile state, read at event time -----------------------------------
  getSelection: () => SelectionState;
  getRows: () => readonly Commit[];
  isMultiSelectable: (id: CommitId) => boolean;
  // --- actions ---------------------------------------------------------------
  actions: CommitActions;
  edits: InlineEdits;
  upstreamCandidatesFor: (name: string) => string[];
  onOpenWorktree: (path: string) => void;
  setAuthorFilter: (author: { name: string; email: string } | null) => void;
  clearSearch: () => void;
  onRowClick: (commit: Commit, e: React.MouseEvent) => void;
}

export const CommitsRowContext = createContext<CommitsRowContextValue | null>(null);

export function useCommitsRow(): CommitsRowContextValue {
  const ctx = useContext(CommitsRowContext);
  if (!ctx) throw new Error("useCommitsRow outside CommitsRowContext");
  return ctx;
}
