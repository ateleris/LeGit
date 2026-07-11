// Pure row/ref derivations for the Commits panel, extracted from the panel's
// useMemo bodies so the decision logic is unit-testable (the same treatment
// graph/lanes and graph/spans already get). Each function is text/data in,
// data out - no React, no IPC.

import type { Branch, Commit, LaneLock } from "../../lib/types";
import type { LockMap, RefsAtCommit } from "./graph/types";

/** Build a conflict-free LockMap for the lane algorithm: first lock per lane
 * wins, later claims on an already-held lane are dropped (with a console
 * warning - the persisted settings hold the conflict, not us). */
export function buildLockMap(rawLocks: readonly LaneLock[]): LockMap {
  const map: LockMap = {};
  const claimedLanes = new Set<number>();
  for (const lock of rawLocks) {
    if (claimedLanes.has(lock.laneIndex)) {
      console.warn(
        `[LeGit] Lane lock conflict: lane ${lock.laneIndex} claimed by "${lock.refName}" ` +
          `but already held by "${Object.entries(map).find(([, v]) => v === lock.laneIndex)?.[0]}". ` +
          `Ignoring this lock. Edit repo settings to resolve.`,
      );
      continue;
    }
    map[lock.refName] = lock.laneIndex;
    claimedLanes.add(lock.laneIndex);
  }
  return map;
}

/** Full local ref → full upstream ref
 * (e.g. `refs/heads/dev` → `refs/remotes/origin/dev`). */
export function buildUpstreamMap(branches: readonly Branch[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const b of branches) {
    if (!b.is_remote && b.upstream) {
      map.set(`refs/heads/${b.name}`, b.upstream);
    }
  }
  return map;
}

/** commitId -> [refName,...] from log decorations. `headOf` carries the
 * checked-out branch's ref - git folds it into `HEAD -> refs/heads/x` and
 * emits no separate `branch` decoration, so it must be included here or a
 * lock on the current branch reserves an empty lane. */
export function buildRefsAt(commits: readonly Commit[]): RefsAtCommit {
  const map = new Map<string, string[]>();
  for (const commit of commits) {
    const refs: string[] = [];
    for (const dec of commit.decorations ?? []) {
      if (dec.type === "branch" || dec.type === "headOf") refs.push(dec.value);
      else if (dec.type === "tag") refs.push(dec.value);
    }
    if (refs.length > 0) map.set(commit.id, refs);
  }
  return map;
}

/** Stash commit id → its reflog selector (e.g. "stash@{0}") from the
 * synthetic stash decorations - drives the diamond dot and stash menus. */
export function buildStashSelectorById(commits: readonly Commit[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const commit of commits) {
    for (const dec of commit.decorations ?? []) {
      if (dec.type === "stash") map.set(commit.id, dec.value);
    }
  }
  return map;
}
