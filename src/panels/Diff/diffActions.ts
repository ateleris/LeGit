// What the diff viewer may DO with the shown diff, as one pure decision so
// inline and split stay in action parity and every view-only mode gates the
// same way.
//
// Hunk/line actions send hunk and line INDICES to the backend, which applies
// from the -U3 diff of the SAME filter (apply_hunk in legit-core; the
// ignore-whitespace flag travels with every action and the backend maps that
// view's selection onto the unfiltered diff). The full-file view merges
// everything into one hunk no backend diff has, so it stays view-only.
// Editing needs the new side to be the real file: true in chunked AND full
// view, but not under ignore-whitespace (whitespace-changed lines render as
// context with the old side's text).

import type { DiffSource } from "../../lib/types";
import type { HunkAction, LineActionOp } from "./DiffEditor";

export interface DiffCapabilities {
  actions: HunkAction[];
  lineActionOp: LineActionOp;
  editable: boolean;
}

const NONE: DiffCapabilities = { actions: [], lineActionOp: null, editable: false };

/** The empty-state text for a diff with no hunks. With ignore-whitespace on,
 *  an empty diff (almost) always means the change was whitespace-only - say
 *  so, or the user wonders why the file is listed as changed at all. */
export function emptyDiffMessage(
  rename: { oldPath: string | null | undefined; path: string } | null,
  ignoreWhitespace: boolean,
): string {
  if (rename) {
    const from = rename.oldPath ? ` from ${rename.oldPath}` : "";
    const beyond = ignoreWhitespace ? " beyond whitespace" : "";
    return `Renamed${from} → ${rename.path} (no content changes${beyond})`;
  }
  return ignoreWhitespace
    ? "No changes except whitespace (hidden while Ignore whitespace is on)."
    : "No changes.";
}

export function diffCapabilities(
  sourceKind: DiffSource["kind"] | undefined,
  chunked: boolean,
  ignoreWhitespace: boolean,
): DiffCapabilities {
  const editable = sourceKind === "working_unstaged" && !ignoreWhitespace;
  if (!chunked) return { ...NONE, editable };
  switch (sourceKind) {
    case "working_unstaged":
      return { actions: ["stage", "discard"], lineActionOp: "stage", editable };
    case "working_staged":
      return { actions: ["unstage"], lineActionOp: "unstage", editable };
    default:
      return NONE;
  }
}
