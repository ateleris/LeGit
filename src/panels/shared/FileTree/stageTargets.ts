import type { FileTreeEntry, Row } from "./buildTree";

/**
 * What Space acts on in a stageable FileTree: a folder acts on every file
 * beneath it (collapse state is irrelevant - `files` is the flat list, not
 * the visible rows); a file inside the current selection acts on the whole
 * selection (Ctrl+A then Space); a file outside it acts on itself alone;
 * with no cursor row yet, the selection is the target.
 */
export function spaceStageTargets(
  row: Row | undefined,
  selectedPaths: ReadonlySet<string>,
  files: readonly FileTreeEntry[],
): string[] {
  if (!row) return [...selectedPaths];
  if (row.kind === "dir") {
    const prefix = `${row.path}/`;
    return files.filter((f) => f.path.startsWith(prefix)).map((f) => f.path);
  }
  if (selectedPaths.has(row.file.path)) return [...selectedPaths];
  return [row.file.path];
}

/**
 * Where the cursor/selection lands after Space stages `targets`: the next
 * surviving FILE row below the acted row, else the nearest one above, else
 * null. Dir rows are skipped - landing on one would make the next Space act
 * on a whole folder - and so is everything about to leave this pane.
 */
export function nextCursorPath(
  rows: readonly Row[],
  fromIndex: number,
  targets: ReadonlySet<string>,
): string | null {
  const survives = (r: Row) => r.kind === "file" && !targets.has(r.path);
  for (let i = Math.max(fromIndex, -1) + 1; i < rows.length; i++) {
    if (survives(rows[i])) return rows[i].path;
  }
  for (let i = Math.min(fromIndex, rows.length) - 1; i >= 0; i--) {
    if (survives(rows[i])) return rows[i].path;
  }
  return null;
}
