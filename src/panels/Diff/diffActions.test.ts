import { describe, expect, it } from "vitest";
import { diffCapabilities, emptyDiffMessage } from "./diffActions";

describe("emptyDiffMessage", () => {
  it("plain empty diff", () => {
    expect(emptyDiffMessage(null, false)).toBe("No changes.");
  });

  it("names whitespace as the reason while the toggle is on", () => {
    expect(emptyDiffMessage(null, true)).toBe(
      "No changes except whitespace (hidden while Ignore whitespace is on).",
    );
  });

  it("pure rename keeps the rename notice", () => {
    expect(emptyDiffMessage({ oldPath: "a.txt", path: "b.txt" }, false)).toBe(
      "Renamed from a.txt → b.txt (no content changes)",
    );
  });

  it("rename under the toggle hedges the content claim", () => {
    expect(emptyDiffMessage({ oldPath: "a.txt", path: "b.txt" }, true)).toBe(
      "Renamed from a.txt → b.txt (no content changes beyond whitespace)",
    );
    expect(emptyDiffMessage({ oldPath: null, path: "b.txt" }, true)).toBe(
      "Renamed → b.txt (no content changes beyond whitespace)",
    );
  });
});

describe("diffCapabilities", () => {
  it("offers stage/discard, line staging and editing on the chunked unstaged diff", () => {
    expect(diffCapabilities("working_unstaged", true, false)).toEqual({
      actions: ["stage", "discard"],
      lineActionOp: "stage",
      editable: true,
    });
  });

  it("offers unstage on the chunked staged diff, read-only", () => {
    expect(diffCapabilities("working_staged", true, false)).toEqual({
      actions: ["unstage"],
      lineActionOp: "unstage",
      editable: false,
    });
  });

  it("commit and range diffs are view-only", () => {
    for (const kind of ["commit", "commit_range"] as const) {
      expect(diffCapabilities(kind, true, false)).toEqual({
        actions: [],
        lineActionOp: null,
        editable: false,
      });
    }
  });

  // Hunk indices only match the backend's unfiltered -U3 diff: the full-file
  // view shows ONE merged hunk, so its indices (and line indices) would stage
  // the wrong content. Editing stays available - the full view's new side is
  // still the real file.
  it("full-file view drops hunk and line actions but keeps editing", () => {
    expect(diffCapabilities("working_unstaged", false, false)).toEqual({
      actions: [],
      lineActionOp: null,
      editable: true,
    });
    expect(diffCapabilities("working_staged", false, false)).toEqual({
      actions: [],
      lineActionOp: null,
      editable: false,
    });
  });

  // Under ignore-whitespace, hunk/line actions stay available (the backend
  // maps the shown selection onto the unfiltered diff), but editing is off:
  // a -w diff doesn't reconstruct the real file (whitespace-changed lines
  // render as context with the old side's text).
  it("ignore-whitespace keeps staging but disables editing", () => {
    expect(diffCapabilities("working_unstaged", true, true)).toEqual({
      actions: ["stage", "discard"],
      lineActionOp: "stage",
      editable: false,
    });
    expect(diffCapabilities("working_staged", true, true)).toEqual({
      actions: ["unstage"],
      lineActionOp: "unstage",
      editable: false,
    });
    // Full-file view stays view-only regardless of the whitespace toggle.
    expect(diffCapabilities("working_unstaged", false, true)).toEqual({
      actions: [],
      lineActionOp: null,
      editable: false,
    });
  });

  it("no request means no capabilities", () => {
    expect(diffCapabilities(undefined, true, false)).toEqual({
      actions: [],
      lineActionOp: null,
      editable: false,
    });
  });
});
