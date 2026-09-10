/**
 * Which list the selection lives in, plus the set of selected paths within it.
 * A partially-staged file appears in BOTH sections under the same path, so a
 * path alone can't identify an entry — the selection is scoped to one section.
 * Multi-select (Ctrl/Shift) is confined to a single list: selecting in one
 * section replaces any selection in the other, so the two lists never highlight
 * simultaneously.
 */
export type Section = "staged" | "unstaged";

export interface Selection {
  section: Section;
  paths: string[];
}

/**
 * Selection follow-through when `paths` move from one section to another (e.g.
 * staging). Generalises the single-select rule to a set: if none of the
 * selection moved, leave it; if all of it moved, follow it into `to`; if only
 * some moved, keep the not-moved paths in `from` (selection lives in one list).
 */
export function moveSelection(
  sel: Selection | null,
  from: Section,
  to: Section,
  paths: string[],
): Selection | null {
  if (sel?.section !== from) return sel;
  const remaining = sel.paths.filter((p) => !paths.includes(p));
  if (remaining.length === sel.paths.length) return sel;
  if (remaining.length === 0) return { section: to, paths: sel.paths };
  return { section: from, paths: remaining };
}

/** Drop discarded `paths` from an unstaged selection; empty clears it. */
export function dropSelection(sel: Selection | null, paths: string[]): Selection | null {
  if (sel?.section !== "unstaged") return sel;
  const remaining = sel.paths.filter((p) => !paths.includes(p));
  return remaining.length ? { section: "unstaged", paths: remaining } : null;
}
