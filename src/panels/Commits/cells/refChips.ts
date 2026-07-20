// Pure helpers for the Refs column: chip ordering and overflow math.
//
// No React, no DOM — RefsCell.tsx consumes these. See DESIGN-v0.4.md §E.2.

import type { RefDecoration } from "../../../lib/types";

/**
 * A renderable ref chip. Mostly mirrors `RefDecoration`, but adds the
 * `fusedBranch` kind: a local branch shown together with its configured
 * upstream remote when both decorate the same commit.
 */
export type ChipDescriptor =
  | { kind: "head" }
  | { kind: "fusedBranch"; local: string; remote: string }
  | { kind: "branch"; value: string }
  | { kind: "remote"; value: string }
  | { kind: "tag"; value: string }
  | { kind: "other"; value: string };

/**
 * Turn a commit's flat decoration list into ordered, renderable chip
 * descriptors.
 *
 * Fusion: for each local branch, if its configured upstream (from
 * `upstreamMap`, keyed by full local ref → full upstream ref) is also present
 * on this commit as a remote decoration, the two collapse into a single
 * `fusedBranch` chip and that remote is not rendered separately. This only
 * happens when both refs sit on the same commit — a diverged branch and its
 * remote render as separate chips.
 *
 * Display priority (stable within a group, preserving git's order):
 *   0. HEAD (detached) / the checked-out branch
 *   1. local & fused branches
 *   2. remote branches
 *   3. tags
 *   4. everything else
 * Stash decorations emit no chip — the graph node marks a stash, and the
 * stash actions live in the row's context menu.
 *
 * When HEAD points at a branch, git folds the branch into `HEAD ->
 * refs/heads/x` and does not list it separately — we synthesize the branch so
 * the checked-out branch gets a real (lockable, fusable) chip. No separate
 * `HEAD →` indicator is rendered: the checked-out branch's chip carries a
 * leading dot instead (see `RefsCell`'s `Chip`).
 */
export function buildChips(
  decorations: RefDecoration[],
  upstreamMap: Map<string, string>,
): ChipDescriptor[] {
  const headOf = decorations.find((d) => d.type === "headOf");
  const headOfTarget = headOf && headOf.type === "headOf" ? headOf.value : null;

  // Synthesize the checked-out branch when git folded it into `HEAD -> x`.
  const expanded: RefDecoration[] = [];
  for (const dec of decorations) {
    expanded.push(dec);
    if (
      dec.type === "headOf" &&
      !decorations.some((d) => d.type === "branch" && d.value === dec.value)
    ) {
      expanded.push({ type: "branch", value: dec.value });
    }
  }

  // Decide which remotes fuse with a local branch (their configured upstream
  // present on this same commit), consuming them so they aren't also rendered
  // standalone. First local branch to claim a remote wins.
  const presentRemotes = new Set(
    expanded.filter((d) => d.type === "remote").map((d) => d.value),
  );
  const fusedFor = new Map<string, string>(); // local ref -> remote ref
  const consumedRemotes = new Set<string>();
  for (const dec of expanded) {
    if (dec.type !== "branch") continue;
    const upstream = upstreamMap.get(dec.value);
    if (upstream && presentRemotes.has(upstream) && !consumedRemotes.has(upstream)) {
      fusedFor.set(dec.value, upstream);
      consumedRemotes.add(upstream);
    }
  }

  const descriptors: ChipDescriptor[] = [];
  for (const dec of expanded) {
    switch (dec.type) {
      case "head":
        descriptors.push({ kind: "head" });
        break;
      case "headOf":
        // No chip of its own — the synthesized branch chip (above) carries
        // the checked-out marker.
        break;
      case "branch": {
        const remote = fusedFor.get(dec.value);
        descriptors.push(
          remote
            ? { kind: "fusedBranch", local: dec.value, remote }
            : { kind: "branch", value: dec.value },
        );
        break;
      }
      case "remote":
        // Skip the symbolic `refs/remotes/<remote>/HEAD` — it mirrors the
        // remote's default branch and adds nothing next to that branch's chip.
        if (!consumedRemotes.has(dec.value) && !dec.value.endsWith("/HEAD")) {
          descriptors.push({ kind: "remote", value: dec.value });
        }
        break;
      case "tag":
        descriptors.push({ kind: "tag", value: dec.value });
        break;
      case "stash":
        // No chip: the graph node (lane-coloured square with the Archive
        // icon) already marks the row as a stash, and the stash actions live
        // in the row's context menu.
        break;
      case "other":
        descriptors.push({ kind: "other", value: dec.value });
        break;
    }
  }

  const groupOf = (d: ChipDescriptor): number => {
    switch (d.kind) {
      case "head":
        return 0;
      case "fusedBranch":
        return d.local === headOfTarget ? 0 : 1;
      case "branch":
        return d.value === headOfTarget ? 0 : 1;
      case "remote":
        return 2;
      case "tag":
        return 3;
      case "other":
        return 4;
    }
  };

  // Array.prototype.sort is stable — within-group git order is preserved.
  return descriptors
    .map((d, i) => ({ d, i, group: groupOf(d) }))
    .sort((a, b) => a.group - b.group || a.i - b.i)
    .map((e) => e.d);
}

/** The branches decorating one commit, for the row context menu. */
export interface BranchesAtCommit {
  /** Local branches (short names) with their checked-out state. */
  local: { name: string; isCurrent: boolean }[];
  /** Remote-tracking branches (short names, e.g. `origin/feature-x`). */
  remote: string[];
}

/**
 * Derive the branches present on a commit from its decorations, for the row
 * context menu. Mirrors `buildChips`' handling: the checked-out branch is
 * synthesized from `HEAD -> x` (git folds it and emits no separate branch
 * decoration), and the symbolic `refs/remotes/<remote>/HEAD` is skipped.
 */
export function branchesAt(decorations: RefDecoration[]): BranchesAtCommit {
  const headOf = decorations.find((d) => d.type === "headOf");
  const headOfTarget = headOf && headOf.type === "headOf" ? headOf.value : null;

  const local: { name: string; isCurrent: boolean }[] = [];
  const seen = new Set<string>();
  const pushLocal = (ref: string) => {
    if (seen.has(ref)) return;
    seen.add(ref);
    local.push({
      name: ref.replace(/^refs\/heads\//, ""),
      isCurrent: ref === headOfTarget,
    });
  };
  if (headOfTarget) pushLocal(headOfTarget);
  for (const dec of decorations) {
    if (dec.type === "branch") pushLocal(dec.value);
  }

  const remote = decorations
    .filter((d) => d.type === "remote" && !d.value.endsWith("/HEAD"))
    .map((d) => (d as { value: string }).value.replace(/^refs\/remotes\//, ""));

  return { local, remote };
}

/**
 * How many leading chips fit in `containerWidth`?
 *
 * Returns `widths.length` when everything fits without an overflow chip.
 * Otherwise returns the largest count that fits alongside the `+N`
 * overflow chip, but never below `minVisible` (default 1, so the
 * highest-priority ref stays visible even in a very narrow column).
 * A caller that reserves space for something more important than chips
 * (the create-branch/-tag input) passes `minVisible` 0 to let every chip
 * collapse behind "+N".
 */
export function computeVisibleCount(
  widths: number[],
  containerWidth: number,
  gap: number,
  overflowChipWidth: number,
  minVisible: 0 | 1 = 1,
): number {
  const n = widths.length;
  if (n === 0) return 0;

  const totalOf = (count: number): number => {
    let total = 0;
    for (let i = 0; i < count; i++) total += widths[i];
    return total + Math.max(0, count - 1) * gap;
  };

  if (totalOf(n) <= containerWidth) return n;

  for (let count = n - 1; count >= minVisible; count--) {
    if (totalOf(count) + gap + overflowChipWidth <= containerWidth) return count;
  }
  return minVisible;
}
