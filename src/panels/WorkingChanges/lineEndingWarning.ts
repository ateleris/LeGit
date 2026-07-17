// Pure builder for the commit-time line-ending warning: which STAGED files
// change their line endings relative to HEAD (index vs HEAD - exactly what
// the commit records, so autocrlf can't produce false positives), and the
// human summary line. Unit-tested next door.

import type { LineEndingStatusEntry } from "../../lib/types";
import { eolLabel } from "../shared/lineEndingStatus";

export interface StagedEolChange {
  path: string;
  from: string;
  to: string;
}

/** Staged line-ending transitions among the files the commit would record. */
export function stagedEolChanges(
  entries: Iterable<LineEndingStatusEntry>,
  stagedPaths: ReadonlySet<string>,
): StagedEolChange[] {
  const out: StagedEolChange[] = [];
  for (const e of entries) {
    if (!e.staged || !stagedPaths.has(e.path)) continue;
    const from = eolLabel(e.staged.from);
    const to = eolLabel(e.staged.to);
    if (from && to) out.push({ path: e.path, from, to });
  }
  return out;
}

/** "a.ts CRLF→LF, b.ts LF→CRLF (+3 more)", capped at `max` files. */
export function formatEolChanges(changes: StagedEolChange[], max = 5): string {
  const shown = changes.slice(0, max).map((c) => `${c.path} ${c.from}→${c.to}`);
  const more = changes.length - shown.length;
  return shown.join(", ") + (more > 0 ? ` (+${more} more)` : "");
}
