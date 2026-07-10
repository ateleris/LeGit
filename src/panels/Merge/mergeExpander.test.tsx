// @vitest-environment happy-dom
// Regression test for the gap expanders: mount the REAL MergeView, click an
// expander button, and assert that lines get revealed (the fold bar numbers
// change). Guards the surgical fold-update path end to end.
import { describe, expect, it } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MergeView, type MergeViewHandle } from "./MergeView";
import { parseConflicts, type LineSelection } from "../Diff/conflictModel";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function mkContent(): { content: string; ours: string; theirs: string } {
  const common = (n: number, tag: string) =>
    Array.from({ length: n }, (_, i) => `${tag}${i + 1}`);
  const lead = common(30, "lead");
  const mid = common(40, "mid");
  const tail = common(30, "tail");
  const content = [
    ...lead,
    "<<<<<<< HEAD", "ours-a", "=======", "theirs-a", ">>>>>>> feature",
    ...mid,
    "<<<<<<< HEAD", "ours-b", "=======", "theirs-b", ">>>>>>> feature",
    ...tail,
  ].join("\n") + "\n";
  const ours = [...lead, "ours-a", ...mid, "ours-b", ...tail].join("\n") + "\n";
  const theirs = [...lead, "theirs-a", ...mid, "theirs-b", ...tail].join("\n") + "\n";
  return { content, ours, theirs };
}

describe("merge gap expander (integration)", () => {
  it("clicking the expander reveals lines (fold shrinks)", async () => {
    const { content, ours, theirs } = mkContent();
    const parsed = parseConflicts(content);
    const selections: LineSelection[] = parsed.sections
      .filter((s) => s.kind === "conflict")
      .map((s) => ({
        ours: (s as { ours: string[] }).ours.map(() => false),
        theirs: (s as { theirs: string[] }).theirs.map(() => false),
      }));
    const selectionsRef = { current: selections };

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const ref = React.createRef<MergeViewHandle>();
    await act(async () => {
      root.render(
        <MergeView
          ref={ref}
          ours={ours}
          theirs={theirs}
          sideNames={{ ours: "main", theirs: "feature" }}
          content={content}
          parsed={parsed}
          selectionsRef={selectionsRef}
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
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    const bars = Array.from(document.querySelectorAll(".cm-merge-fold"));
    expect(bars.length).toBeGreaterThan(0);
    const buttons = Array.from(document.querySelectorAll(".cm-hunk-expander-btn"));
    expect(buttons.length).toBeGreaterThan(0);

    const textsBefore = bars.map((b) => b.textContent);
    // mousedown is what the button listens for
    await act(async () => {
      buttons[0].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      await new Promise((r) => setTimeout(r, 20));
    });

    const barsAfter = Array.from(document.querySelectorAll(".cm-merge-fold"));
    const textsAfter = barsAfter.map((b) => b.textContent);
    expect(textsAfter).not.toEqual(textsBefore);
  });
});
