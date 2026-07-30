// User-selectable sort order for ref lists (Refs panel: branches and tags).
// Stashes are exempt: their reflog order (newest first) is positional meaning,
// not presentation.

/** Sort order for branches/tags ("Refs sorting" global setting). */
export type RefsSortMode = "alphabetical" | "date" | "date_reversed";

export const REFS_SORT_MODE_DEFAULT: RefsSortMode = "alphabetical";

/** Narrow the persisted setting string; anything unknown falls back to the
 * default so an old/hand-edited settings file can't break the panel. */
export function coerceRefsSortMode(value: string | null | undefined): RefsSortMode {
  return value === "date" || value === "date_reversed" ? value : REFS_SORT_MODE_DEFAULT;
}

/** Natural-order name comparison: case-insensitive, numeric-aware, so
 * "v1.9" sorts before "v1.10" (unlike git's byte-wise refname order). */
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * Return a sorted copy of `items` (the input order - git's - is left intact
 * for callers that rely on it). "date" = newest first, "date_reversed" =
 * oldest first; date ties (e.g. branches on the same commit) fall back to the
 * name so the order is deterministic.
 */
export function sortRefs<T>(
  items: readonly T[],
  mode: RefsSortMode,
  name: (item: T) => string,
  createdAt: (item: T) => number,
): T[] {
  const sorted = [...items];
  sorted.sort((a, b) => {
    if (mode !== "alphabetical") {
      const diff = createdAt(a) - createdAt(b);
      if (diff !== 0) return mode === "date" ? -diff : diff;
    }
    return byName.compare(name(a), name(b));
  });
  return sorted;
}
