import type { Commit } from "./types";

/**
 * Whether HEAD is detached, judged from the HEAD commit's log decorations:
 * a bare `head` decoration means detached, while `headOf` carries the branch
 * HEAD points at. `null`/missing decorations (unborn repo, plain rows) are
 * not detached — committing there creates/advances the branch normally.
 *
 * Used by the Working Changes commit flow to warn before a detached-HEAD
 * commit, which no ref keeps alive and is easily lost.
 */
export function isDetachedHead(head: Commit | null | undefined): boolean {
  return head?.decorations?.some((d) => d.type === "head") ?? false;
}
