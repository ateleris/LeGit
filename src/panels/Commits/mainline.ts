// Parent choices for cherry-picking/reverting a MERGE commit. A merge's
// "change" is ambiguous - it depends on which parent it is measured against
// (`-m N`) - so the row menu asks, with informed labels. Pure so the wording
// and the no-picker rule for regular commits are pinned by unit tests.

/** Longest subject shown in a choice label before truncation. */
const SUBJECT_MAX = 50;

export interface MainlineChoice {
  /** 1-based parent number, passed to git as `-m N`. */
  mainline: number;
  /** The parent commit id. */
  id: string;
  /** "Parent 1 (abc12345): subject" - sha-only when the parent isn't loaded. */
  label: string;
}

/**
 * Choices for a commit's parents, or null for regular commits (no picker
 * needed - the action runs directly). `subjectOf` looks a parent up in the
 * loaded rows and may return null (parent outside the loaded window).
 */
export function mainlineChoices(
  commit: { parents: string[] },
  subjectOf: (id: string) => string | null,
): MainlineChoice[] | null {
  if (commit.parents.length < 2) return null;
  return commit.parents.map((id, i) => {
    const raw = subjectOf(id);
    const firstLine = raw?.split("\n")[0].trim() ?? "";
    const subject =
      firstLine.length > SUBJECT_MAX ? `${firstLine.slice(0, SUBJECT_MAX)}…` : firstLine;
    const short = id.slice(0, 8);
    return {
      mainline: i + 1,
      id,
      label: subject ? `Parent ${i + 1} (${short}): ${subject}` : `Parent ${i + 1} (${short})`,
    };
  });
}
