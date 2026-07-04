import type { ConflictKind } from "../../lib/types";

/** Menu labels for whole-file conflict resolution, delete-aware: taking a
 *  side that deleted the file must say so. */
export function takeSideLabels(kind: ConflictKind | undefined): {
  ours: string;
  theirs: string;
} {
  switch (kind) {
    case "deleted_by_us":
      return { ours: "Take ours (delete file)", theirs: "Take theirs (keep file)" };
    case "deleted_by_them":
      return { ours: "Take ours (keep file)", theirs: "Take theirs (delete file)" };
    default:
      return { ours: "Take ours", theirs: "Take theirs" };
  }
}
