import type { Row } from "./buildTree";

/**
 * ArrowLeft/ArrowRight are FOLD KEYS only: Right expands a collapsed folder,
 * Left collapses an expanded one, and neither ever moves the cursor (Up/Down
 * own movement; a fallback step here would double up on them and break the
 * Space-staging rhythm).
 */
/**
 * Where ArrowUp/ArrowDown land, and whether a selection change comes with it:
 * arrows move the SELECTION like any native list (landing on a file row
 * selects it; a dir row moves only the cursor - dirs are not selectable
 * entries). Null at a list edge, so bumping against the end never re-selects
 * the same row (which would re-open its diff).
 */
export function verticalMoveTarget(
  rows: readonly Row[],
  fromIndex: number,
  delta: 1 | -1,
): { index: number; selectPath: string | null } | null {
  if (rows.length === 0) return null;
  const from = fromIndex < 0 ? -1 : fromIndex;
  const index = Math.max(0, Math.min(rows.length - 1, from + delta));
  if (index === from) return null;
  const row = rows[index];
  return { index, selectPath: row.kind === "file" ? row.path : null };
}

export function horizontalKeyAction(
  key: "ArrowLeft" | "ArrowRight",
  row: Row | undefined,
): "toggle" | null {
  if (row?.kind !== "dir") return null;
  if (key === "ArrowRight") return row.collapsed ? "toggle" : null;
  return row.collapsed ? null : "toggle";
}
