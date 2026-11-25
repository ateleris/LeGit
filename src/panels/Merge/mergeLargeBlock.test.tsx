// @vitest-environment happy-dom
// A conflict block far taller than the viewport must not cost its full
// height to mount: the side panes pad the block with a spacer widget at its
// last line, and @codemirror/view before 6.44.0 then built gutter cells for
// every line between the viewport and that spacer (seconds of frozen UI on a
// 17k-line conflict).
import { expect, it } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MergeView } from "./MergeView";
import { parseConflicts, type LineSelection } from "./conflictModel";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const BLOCK_LINES = 4000;
const MAX_GUTTER_CELLS = 1000;

it("mounts a huge conflict block with gutter cells for the viewport only", async () => {
  const side = (tag: string) => Array.from({ length: BLOCK_LINES }, (_, i) => `${tag} line ${i}`);
  const ours = side("ours");
  const theirs = side("theirs");
  const content = ["<<<<<<< HEAD", ...ours, "=======", ...theirs, ">>>>>>> main", ""].join("\n");
  const parsed = parseConflicts(content);
  const selections: LineSelection[] = [
    { ours: ours.map(() => false), theirs: theirs.map(() => false) },
  ];

  const host = document.createElement("div");
  document.body.appendChild(host);
  await act(async () => {
    createRoot(host).render(
      <MergeView
        ours={ours.join("\n") + "\n"}
        theirs={theirs.join("\n") + "\n"}
        sideNames={{ ours: "dev", theirs: "main" }}
        content={content}
        parsed={parsed}
        selectionsRef={{ current: selections }}
        onToggleLine={() => {}}
        onToggleBlock={() => {}}
        onToggleSideAll={() => {}}
        onDirty={() => {}}
        onSaveRequest={() => {}}
        rebuildKey={0}
        foldCommon
        syntaxPath={null}
      />,
    );
  });

  expect(host.querySelectorAll(".cm-gutterElement").length).toBeLessThan(MAX_GUTTER_CELLS);
});
