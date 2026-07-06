// The Working Changes panel stacks three sections; the user can reorder them
// (Global Settings → "Working Changes layout"). Pure so the normalization is
// unit-tested and shared by the panel and the settings control.

export type WorkingChangesSection = "unstaged" | "staged" | "commit";

/** Canonical (default) top-to-bottom order. */
export const WORKING_CHANGES_SECTIONS: WorkingChangesSection[] = [
  "unstaged",
  "staged",
  "commit",
];

export const WORKING_CHANGES_SECTION_LABELS: Record<WorkingChangesSection, string> = {
  unstaged: "Unstaged",
  staged: "Staged",
  commit: "Commit message",
};

/**
 * Normalize a stored order into a complete, de-duplicated list of all three
 * sections: known entries keep their stored order, then any missing sections
 * are appended in the canonical order. Unknown/legacy ids are dropped. So an
 * empty or partial stored value degrades cleanly to the default.
 */
export function orderedWorkingChangesSections(
  stored?: string[] | null,
): WorkingChangesSection[] {
  const known = new Set<string>(WORKING_CHANGES_SECTIONS);
  const seen = new Set<WorkingChangesSection>();
  const out: WorkingChangesSection[] = [];
  for (const s of stored ?? []) {
    if (known.has(s) && !seen.has(s as WorkingChangesSection)) {
      out.push(s as WorkingChangesSection);
      seen.add(s as WorkingChangesSection);
    }
  }
  for (const s of WORKING_CHANGES_SECTIONS) if (!seen.has(s)) out.push(s);
  return out;
}
