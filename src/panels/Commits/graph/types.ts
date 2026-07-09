// Lane-assignment domain types for the Commits panel graph column.
//
// This module is pure TypeScript — no React, no DOM, no Tauri imports.
// See design/DESIGN-v0.4.md §F for the algorithm specification.

export type LaneIndex = number;

export interface LaneAssignment {
  commitId: string;
  lane: LaneIndex;
}

export interface LaneEdge {
  fromCommitId: string;
  toCommitId: string;
  fromLane: LaneIndex;
  toLane: LaneIndex;
}

export interface LaneResult {
  assignments: Map<string, LaneIndex>;
  edges: LaneEdge[];
  /** Highest lane index used across all assignments. -1 if no commits assigned. */
  maxLane: number;
}

export interface CommitForGraph {
  id: string;
  parentIds: string[];
  /**
   * Synthetic nodes only (working-dir row, injected stashes): when the
   * node's first parent is owned by a locked lane, the node may sit on
   * that lane instead of being pushed to a free one. Never set for real
   * commits — a branch tip forked off a locked branch must not inherit.
   */
  inheritsParentLane?: boolean;
}

/**
 * Maps a ref full name (e.g. `"refs/heads/main"`) to its locked lane index.
 *
 * Backend storage is a `Vec<LaneLock>` for stable iteration; the algorithm
 * consumes a `LockMap` object for O(1) lookup. Conflict resolution (two refs
 * locked to the same lane) is the caller's responsibility — by the time a
 * `LockMap` reaches the algorithm it must be conflict-free per §H.5.
 */
export interface LockMap {
  [refName: string]: LaneIndex;
}

/**
 * Maps `commitId` to the list of ref full names pointing at that commit
 * (populated from the `%d` decoration field returned by `git log`).
 */
export type RefsAtCommit = Map<string, string[]>;
