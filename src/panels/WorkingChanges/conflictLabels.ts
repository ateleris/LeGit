import type { ConflictKind } from "../../lib/types";
import type { SideNames } from "../../lib/conflictSides";

type Consequence = "deletes file" | "keeps file" | null;

function label(
  name: string | null | undefined,
  word: "current" | "incoming",
  gitWord: "ours" | "theirs",
  consequence: Consequence,
): string {
  if (name) return `Take '${name}' (${consequence ?? word})`;
  return `Take ${word} (${gitWord}${consequence ? `, ${consequence}` : ""})`;
}

/** Menu labels for whole-file conflict resolution: branch-named when the
 *  operation names the sides, delete-aware (taking a side that deleted the
 *  file must say so). */
export function takeSideLabels(
  kind: ConflictKind | undefined,
  names?: SideNames,
): {
  ours: string;
  theirs: string;
} {
  const consequences: { ours: Consequence; theirs: Consequence } =
    kind === "deleted_by_us"
      ? { ours: "deletes file", theirs: "keeps file" }
      : kind === "deleted_by_them"
        ? { ours: "keeps file", theirs: "deletes file" }
        : { ours: null, theirs: null };
  return {
    ours: label(names?.ours, "current", "ours", consequences.ours),
    theirs: label(names?.theirs, "incoming", "theirs", consequences.theirs),
  };
}
