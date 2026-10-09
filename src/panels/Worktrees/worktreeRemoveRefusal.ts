/**
 * Classify why `git worktree remove` (without force) refused, deciding
 * whether a force-retry may be offered and with which warning:
 *
 * - "dirty": the worktree has local changes; git's message says
 *   "use --force to delete it".
 * - "submodules": the worktree contains an initialized submodule checkout;
 *   git refuses regardless of cleanliness (it does not inspect submodule
 *   state) and the message never mentions --force, but a single --force
 *   removes it.
 * - null: no force offer - e.g. a locked worktree, where a single --force
 *   would not help and unlocking is the right path.
 */
export type WorktreeRemoveRefusal = "dirty" | "submodules" | null;

export function classifyWorktreeRemoveRefusal(message: string): WorktreeRemoveRefusal {
  if (message.includes("containing submodules")) return "submodules";
  if (message.includes("--force")) return "dirty";
  return null;
}
