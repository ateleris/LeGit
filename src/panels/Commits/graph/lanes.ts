// Lane-assignment algorithm for the Commits panel graph column.
//
// Pure TypeScript implementation of the "option 2" lookahead lane reuse
// algorithm with incremental stability under pagination
// (design/DESIGN-v0.4.md §F.3 and §H).
//
// The algorithm walks commits newest-to-oldest, assigning each commit to a
// lane. Lanes carry a target commit id (the next expected commit in that
// lane); when the walk reaches that commit, it occupies the lane and sets
// up the slot's next target (its first parent), with additional parents
// spawning new lanes.
//
// Stability under load-more is the central correctness property: when
// `previousAssignments` is supplied, every commit already assigned keeps
// its lane verbatim, and the walk reconstructs active slot state from the
// last-known slot positions before continuing with new commits.

import type {
  CommitForGraph,
  LaneEdge,
  LaneIndex,
  LaneResult,
  LockMap,
  RefsAtCommit,
} from "./types";

/**
 * Returns the lane index for a commit on a locked ref, or `null` if no
 * locked ref points to this commit. When multiple locks apply (rare —
 * the UI prevents conflict creation per §H.5), the lowest lane index
 * wins so behavior is deterministic.
 */
function isOnLockedRef(
  commitId: string,
  locks: LockMap,
  refsAt: RefsAtCommit,
): LaneIndex | null {
  const refs = refsAt.get(commitId);
  if (!refs || refs.length === 0) return null;
  let best: LaneIndex | null = null;
  for (const refName of refs) {
    const lane = locks[refName];
    if (typeof lane === "number") {
      if (best === null || lane < best) best = lane;
    }
  }
  return best;
}

/**
 * Returns the set of lane indices that are reserved by locks. Used to
 * keep non-locked branches from squatting on a locked lane.
 */
function lockedLaneSet(locks: LockMap): Set<LaneIndex> {
  const set = new Set<LaneIndex>();
  for (const refName of Object.keys(locks)) {
    set.add(locks[refName]);
  }
  return set;
}

/**
 * Builds the first-parent ownership map: `commitId -> locked laneIndex` for
 * every commit on a locked ref's first-parent ancestry within the loaded
 * window.
 *
 * A locked ref's lane is seeded at the ref's tip (the commit it decorates in
 * `refsAt`) and propagated down the *first-parent* chain. This makes lane
 * membership a deterministic, order-independent property of the topology
 * rather than something that emerges from the greedy walk — which is what
 * keeps two cross-merged branches (main ↔ development) in their locked lanes.
 *
 * Locks are processed lowest-lane-first and ownership is recorded
 * set-if-absent, so a commit on more than one locked ref's first-parent line
 * (the shared spine) is owned by the lowest lane index. A ref whose tip is
 * not present in the window is skipped: its lane stays reserved but unclaimed.
 */
function computeOwnership(
  commits: CommitForGraph[],
  locks: LockMap,
  refsAt: RefsAtCommit,
): Map<string, LaneIndex> {
  const owner = new Map<string, LaneIndex>();
  if (Object.keys(locks).length === 0) return owner;

  // O(1) lookup for first-parent walking.
  const index = new Map<string, CommitForGraph>();
  for (const c of commits) index.set(c.id, c);

  // Resolve each locked ref to its tip commit (the commit it decorates).
  const tipOf = new Map<string, string>(); // refName -> commitId
  for (const [commitId, refs] of refsAt) {
    for (const refName of refs) {
      if (refName in locks) tipOf.set(refName, commitId);
    }
  }

  // Process locked refs lowest-lane-first; ties broken by refName so the
  // result is deterministic even under conflicting (same-lane) locks.
  const lockedRefs = Object.keys(locks)
    .filter((r) => tipOf.has(r))
    .sort((a, b) => locks[a] - locks[b] || (a < b ? -1 : a > b ? 1 : 0));

  for (const refName of lockedRefs) {
    const lane = locks[refName];
    let cur: string | undefined = tipOf.get(refName);
    while (cur !== undefined) {
      const c = index.get(cur);
      if (c === undefined) break; // walked off the loaded window
      if (!owner.has(cur)) owner.set(cur, lane);
      cur = c.parentIds[0];
    }
  }
  return owner;
}

/**
 * Picks a lane for a commit that is not already being awaited by an
 * existing slot. Implements `pick_new_lane` from §F.3.
 *
 * - If `commitId` sits on a locked ref, return that ref's lane index.
 * - Otherwise scan free, non-locked lanes ascending. For each candidate,
 *   peek ahead through the remaining loaded window: if any upcoming
 *   commit on a locked ref claims this lane, skip the candidate.
 * - If no safe candidate exists, return the next unused lane index.
 */
function pickNewLane(
  commitId: string,
  locks: LockMap,
  refsAt: RefsAtCommit,
  activeSlots: Map<LaneIndex, string>,
  commits: CommitForGraph[],
  startIndex: number,
  reservedThisStep: Set<LaneIndex>,
): LaneIndex {
  const lockedLane = isOnLockedRef(commitId, locks, refsAt);
  if (lockedLane !== null) return lockedLane;

  const locked = lockedLaneSet(locks);

  // Compute which lockedLane indices are "needed" by upcoming commits.
  // We only care about locks whose ref decorates a commit later in the
  // window — orphaned locks (no commit in the window) shouldn't block
  // an otherwise good candidate.
  const upcomingLocks = new Set<LaneIndex>();
  for (let i = startIndex + 1; i < commits.length; i++) {
    const upcomingLane = isOnLockedRef(commits[i].id, locks, refsAt);
    if (upcomingLane !== null) upcomingLocks.add(upcomingLane);
  }

  // Determine the highest lane index currently in play so we have a
  // bounded scan range; we also need to consider unused indices beyond
  // it for the final fallback.
  let maxKnown = -1;
  for (const idx of activeSlots.keys()) if (idx > maxKnown) maxKnown = idx;
  for (const idx of locked) if (idx > maxKnown) maxKnown = idx;
  for (const idx of reservedThisStep) if (idx > maxKnown) maxKnown = idx;

  for (let candidate = 0; candidate <= maxKnown + 1; candidate++) {
    if (activeSlots.has(candidate)) continue;
    if (reservedThisStep.has(candidate)) continue;
    if (locked.has(candidate)) continue;
    if (upcomingLocks.has(candidate)) continue;
    return candidate;
  }

  // No safe non-locked candidate fits — fall back to the next unused
  // index. We allow stepping onto a not-yet-needed locked index only if
  // it isn't claimed by an upcoming locked commit; otherwise we jump
  // past it. This preserves the §F.3 fallback "next unused lane index"
  // while not silently colliding with an imminent lock.
  let fallback = maxKnown + 1;
  while (upcomingLocks.has(fallback) || locked.has(fallback) ||
         activeSlots.has(fallback) || reservedThisStep.has(fallback)) {
    fallback++;
  }
  return fallback;
}

/**
 * Reconstructs `activeSlots` from prior assignments for stability under
 * load-more. For each commit already assigned in `previousAssignments`,
 * we know the lane it lives in. The slot's next target is the first
 * parent of the *oldest* commit per lane that has a parent still outside
 * the previously-walked range — but we don't have to model that
 * precisely: when the walk encounters a new commit whose id matches the
 * remembered target, the slot fires. So we initialize each lane's
 * target to the first parent of the last (oldest) commit in that lane
 * within the previous set.
 */
function reconstructActiveSlots(
  commits: CommitForGraph[],
  previousAssignments: Map<string, LaneIndex>,
): { activeSlots: Map<LaneIndex, string>; firstNewIndex: number } {
  // Group previously-assigned commits by lane, keeping track of the
  // oldest (highest index) commit in each lane.
  const oldestByLane = new Map<LaneIndex, { id: string; idx: number }>();
  let firstNewIndex = commits.length;
  for (let i = 0; i < commits.length; i++) {
    const c = commits[i];
    const lane = previousAssignments.get(c.id);
    if (lane === undefined) {
      if (i < firstNewIndex) firstNewIndex = i;
      continue;
    }
    const prev = oldestByLane.get(lane);
    if (!prev || i > prev.idx) oldestByLane.set(lane, { id: c.id, idx: i });
  }

  // For each lane in the previous assignment, the active slot's target
  // is the first parent of the oldest commit in that lane (the next
  // commit that should land in that lane after the boundary).
  const activeSlots = new Map<LaneIndex, string>();
  for (const [lane, info] of oldestByLane) {
    const commit = commits[info.idx];
    const target = commit.parentIds[0];
    if (target !== undefined) {
      activeSlots.set(lane, target);
    }
    // If the oldest commit in the lane has no parents (root commit),
    // the lane has already terminated — leave it out of activeSlots.
  }

  return { activeSlots, firstNewIndex };
}

/**
 * Compute lane assignments for the commit window.
 *
 * @param commits Ordered newest-first. Each commit carries `id` and
 *   `parentIds` (first parent first).
 * @param locks Per-repo lane locks, `{ refName: laneIndex }`.
 * @param refsAt `commitId -> [refName, ...]` from log decorations.
 * @param previousAssignments Prior lane assignments for stability under
 *   load-more. When supplied, every commit it contains keeps its lane
 *   verbatim and the walk only computes new commits.
 */
export function computeLanes(
  commits: CommitForGraph[],
  locks: LockMap,
  refsAt: RefsAtCommit,
  previousAssignments?: Map<string, LaneIndex>,
): LaneResult {
  const assignments = new Map<string, LaneIndex>();
  const edges: LaneEdge[] = [];

  if (commits.length === 0) {
    return { assignments, edges, maxLane: -1 };
  }

  // First-parent ownership of locked lanes. This is the authority for any
  // commit on a locked ref's first-parent line; the greedy walk below only
  // governs unlocked branches. Recomputed every call — it is deterministic
  // and order-independent, so it is also stable across load-more.
  const owner = computeOwnership(commits, locks, refsAt);

  // Slot state: laneIndex -> commitId the lane is currently waiting for.
  const activeSlots = new Map<LaneIndex, string>();
  let startIndex = 0;

  if (previousAssignments && previousAssignments.size > 0) {
    // Honor prior assignments for stability, but let ownership win: a commit
    // on a locked ref's first-parent line is pinned to its owner lane even if
    // a prior (possibly pre-fix) pass placed it elsewhere.
    for (const [id, lane] of previousAssignments) {
      assignments.set(id, owner.get(id) ?? lane);
    }
    const recon = reconstructActiveSlots(commits, previousAssignments);
    for (const [lane, target] of recon.activeSlots) {
      activeSlots.set(lane, target);
    }
    startIndex = recon.firstNewIndex;
  }

  for (let i = startIndex; i < commits.length; i++) {
    const c = commits[i];

    // Skip commits already assigned (load-more stability path).
    if (assignments.has(c.id)) continue;

    // Step 1 — find waiting lanes (slots whose target === c.id).
    const waiting: LaneIndex[] = [];
    for (const [lane, target] of activeSlots) {
      if (target === c.id) waiting.push(lane);
    }
    waiting.sort((a, b) => a - b);

    // Step 2 — assign C to a lane. A commit owned by a locked ref's
    // first-parent line is pinned to that lane; otherwise the greedy walk
    // decides. (`isOnLockedRef` only knew tips; ownership covers the chain.)
    let cLane: LaneIndex;
    const ownedC = owner.get(c.id);
    const lockedLaneForC = ownedC === undefined ? null : ownedC;

    if (lockedLaneForC !== null && waiting.includes(lockedLaneForC)) {
      // The locked lane is among the waiters — claim it.
      cLane = lockedLaneForC;
    } else if (lockedLaneForC !== null) {
      // C is on a locked ref but no waiter sits on the locked lane.
      // C must still claim its locked lane. If another lane was
      // already waiting on the locked lane's index, evict it.
      cLane = lockedLaneForC;
      // If the locked lane is currently active under a different
      // target, terminate it: it would conflict with the lock claim.
      // (This is unusual — locked lanes are normally reserved.)
      const existingTarget = activeSlots.get(cLane);
      if (existingTarget !== undefined && existingTarget !== c.id) {
        // The existing occupant gets evicted with a merge edge into the
        // locked lane at C. We don't have an obvious source-commit to
        // attribute the edge to, so omit it; this case only arises with
        // hand-edited inconsistent state.
        activeSlots.delete(cLane);
      }
    } else if (waiting.length > 0) {
      cLane = waiting[0];
    } else {
      cLane = pickNewLane(
        c.id,
        locks,
        refsAt,
        activeSlots,
        commits,
        i,
        new Set(),
      );
    }

    assignments.set(c.id, cLane);

    // Step 3 — terminate other waiting lanes. These are emitted as
    // self-edges (fromCommitId === toCommitId): the dying lane's line jogs
    // into C's dot at C's own row. The renderer distinguishes jog edges
    // from regular child→parent edges by exactly this invariant.
    for (const lane of waiting) {
      if (lane === cLane) continue;
      edges.push({
        fromCommitId: c.id,
        toCommitId: c.id,
        fromLane: lane,
        toLane: cLane,
      });
      activeSlots.delete(lane);
    }

    // Step 4 — set up parent slots.
    const parents = c.parentIds;
    // Reserve only the lanes already spoken for in this step: the commit's
    // own lane (plus each additional parent's lane as it is claimed, below).
    // Lanes just freed by jogs are deliberately NOT reserved — a merge's
    // second parent reuses the lane its first-parent history just vacated,
    // so sequential PR branches all share one lane instead of alternating
    // rightward. Visually the jog arc (up into the dot) and the new child
    // arc (down out of the dot) occupy different halves of the row and share
    // only the horizontal stem at the dot: the lane reads as pinching
    // through the merge dot, the same compaction GitKraken and
    // `git log --graph` use.
    const reservedThisStep = new Set<LaneIndex>([cLane]);

    if (parents.length === 0) {
      // Root commit — C's lane terminates here.
      activeSlots.delete(cLane);
    } else {
      const firstParent = parents[0];
      // C's lane always continues toward its first parent on its own lane.
      // When the first parent lives on another (locked) lane, the lane does
      // NOT cross over here: it rides down to the parent and terminates as a
      // jog at the convergence commit (Step 3, where the parent claims its
      // owner lane and the surplus lanes jog in). This matches how unlocked
      // branch-offs render, so locking a branch never reshapes a branch-off
      // from a jog into a cross-edge.
      activeSlots.set(cLane, firstParent);
      edges.push({
        fromCommitId: c.id,
        toCommitId: firstParent,
        fromLane: cLane,
        toLane: cLane,
      });

      // Additional parents each spawn a new lane.
      for (let p = 1; p < parents.length; p++) {
        const parent = parents[p];
        let parentLane: LaneIndex | undefined;
        const ownedParent = owner.get(parent);
        if (ownedParent !== undefined) {
          // The parent is on a locked ref's first-parent line — route the
          // merge edge straight into that locked lane (this is how a
          // development → main merge connects into development's lane, and a
          // main → development merge connects into main's lane).
          parentLane = ownedParent;
          if (activeSlots.get(parentLane) !== parent) {
            activeSlots.set(parentLane, parent);
          }
        } else {
          // If a slot is already waiting for this parent, reuse it instead of
          // spawning a duplicate. (Possible when the same parent appears
          // multiple times in the loaded window via two independent lanes
          // converging.)
          for (const [lane, target] of activeSlots) {
            if (target === parent && !reservedThisStep.has(lane)) {
              parentLane = lane;
              break;
            }
          }
          if (parentLane === undefined) {
            parentLane = pickNewLane(
              parent,
              locks,
              refsAt,
              activeSlots,
              commits,
              i,
              reservedThisStep,
            );
            activeSlots.set(parentLane, parent);
          }
        }
        reservedThisStep.add(parentLane);
        edges.push({
          fromCommitId: c.id,
          toCommitId: parent,
          fromLane: cLane,
          toLane: parentLane,
        });
      }
    }
  }

  // Compute maxLane from assignments.
  let maxLane = -1;
  for (const lane of assignments.values()) if (lane > maxLane) maxLane = lane;

  return { assignments, edges, maxLane };
}
