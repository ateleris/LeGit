import type { DiffSource } from "./types";

/**
 * The two sides a diff source compares, as rev specs. `rev`: the new side,
 * `oldRev`: the old side; null = working tree, ":" = the index, else any
 * rev spec. Shared by the line-endings badge and the image preview so both
 * always address the same blobs the diff shows.
 */
export function diffSides(source: DiffSource): { rev: string | null; oldRev: string | null } {
  switch (source.kind) {
    case "working_unstaged":
      return { rev: null, oldRev: ":" }; // working tree vs index
    case "working_staged":
      return { rev: ":", oldRev: "HEAD" }; // index vs HEAD
    case "commit":
      return { rev: source.commit_id, oldRev: `${source.commit_id}^` }; // commit vs first parent
    case "commit_range":
      return { rev: source.to, oldRev: source.from };
  }
}
