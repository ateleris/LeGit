import type { RebaseAction } from "../../lib/types";

/** One editable plan row. DISPLAY order = newest first (matches the commit
 *  graph); `toTodoOrder` flips into git's oldest-first todo order at the
 *  boundaries (validation, submit). */
export interface PlanRow {
  sha: string;
  shortSha: string;
  subject: string;
  action: RebaseAction;
  /** Full original message (subject + body) - the reword prefill and the
   *  "did the reword actually change anything" baseline. */
  originalMessage: string;
  /** Reword draft; meaningful only while action === "reword". */
  message: string;
}

export function toTodoOrder(rows: readonly PlanRow[]): PlanRow[] {
  return [...rows].reverse();
}

/** Plan-validity rules in TODO order, mirroring `validate_rebase_plan` in
 *  legit-core (the enforcing copy) for immediate UX feedback - keep the two
 *  in sync. Messages are phrased for the DISPLAY order (newest first):
 *  todo-order "previous" is the row BELOW. */
export function planError(todoRows: readonly PlanRow[]): string | null {
  if (todoRows.length === 0) return null;
  const kept = todoRows.filter((r) => r.action !== "drop");
  if (kept.length === 0) return "Every commit is dropped: nothing to rebase onto.";
  if (kept[0].action !== "pick" && kept[0].action !== "reword")
    return "The last kept commit must be a pick or reword: squash/fixup meld into the commit below.";
  for (const r of todoRows) {
    if (r.action === "reword" && r.message.trim() === "")
      return `The reword of ${r.shortSha} needs a non-empty message.`;
  }
  return null;
}

/** True when running the plan would change nothing: original order, every
 *  action a pick, or a reword whose text equals the original message. */
export function isUnchanged(rows: readonly PlanRow[], newestFirstIds: readonly string[]): boolean {
  return rows.every((r, i) => {
    if (newestFirstIds[i] !== r.sha) return false;
    if (r.action === "pick") return true;
    if (r.action === "reword") return r.message === r.originalMessage;
    return false;
  });
}

/** Plan shas already on the upstream (null = no upstream = none). */
export function pushedShas(
  rowShas: readonly string[],
  unpushed: readonly string[] | null | undefined,
): Set<string> {
  if (unpushed == null) return new Set();
  const un = new Set(unpushed);
  return new Set(rowShas.filter((s) => !un.has(s)));
}
