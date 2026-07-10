// @vitest-environment happy-dom
// Regression test for the gap expanders: mount the REAL MergeView, click an
// expander button, and assert that lines get revealed (the fold bar numbers
// change). Guards the surgical fold-update path end to end.
import { describe, expect, it } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { EditorView } from "@codemirror/view";
import { MergeView, type MergeViewHandle } from "./MergeView";
import { parseConflicts, type LineSelection } from "../Diff/conflictModel";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function mkContent(): { content: string; ours: string; theirs: string } {
  const common = (n: number, tag: string) =>
    Array.from({ length: n }, (_, i) => `${tag}${i + 1}`);
  // Small enough that every fold sits inside CodeMirror's estimated viewport
  // (happy-dom has no layout), large enough that all three gaps fold.
  const lead = common(12, "lead");
  const mid = common(14, "mid");
  const tail = common(12, "tail");
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

async function mountMergeView() {
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
  return { ref, selectionsRef, host };
}

/** Check block 0's "ours" side and apply it: the 5 marker lines collapse to
 *  1, so everything below the block shifts in the result doc. */
async function toggleBlock0ToOurs(
  ref: React.RefObject<MergeViewHandle | null>,
  selectionsRef: { current: LineSelection[] },
) {
  selectionsRef.current[0] = {
    ours: selectionsRef.current[0].ours.map(() => true),
    theirs: selectionsRef.current[0].theirs.map(() => false),
  };
  await act(async () => {
    ref.current!.applyBlock(0);
    await new Promise((r) => setTimeout(r, 20));
  });
}

/** The mounted result pane's EditorView (pane order: Current, Result, Incoming). */
function resultEditorView(host: HTMLElement): EditorView {
  const el = host.querySelectorAll(".cm-editor")[1] as HTMLElement;
  const view = EditorView.findFromDOM(el);
  if (!view) throw new Error("result EditorView not found");
  return view;
}

/** Type `text` at position `pos` of the result doc, like a user edit. */
async function typeInResult(host: HTMLElement, pos: number, text: string) {
  const view = resultEditorView(host);
  await act(async () => {
    view.dispatch({ changes: { from: pos, insert: text }, userEvent: "input.type" });
    await new Promise((r) => setTimeout(r, 20));
  });
}

describe("manual result edits survive side selection", () => {
  it("keeps a line typed at the start of the line after an unresolved block", async () => {
    const { ref, selectionsRef, host } = await mountMergeView();
    const view = resultEditorView(host);
    // Start of the first common line after block 0's ">>>>>>>" marker.
    const pos = view.state.doc.toString().indexOf("\nmid1\n") + 1;
    await typeInResult(host, pos, "edited\n");

    await toggleBlock0ToOurs(ref, selectionsRef);

    expect(ref.current!.getText()).toContain("lead12\nours-a\nedited\nmid1");
  });

  it("keeps lines added below the closing marker via Enter", async () => {
    const { ref, selectionsRef, host } = await mountMergeView();
    const view = resultEditorView(host);
    // Cursor at the end of block 0's ">>>>>>> feature" line, press Enter, type.
    const doc = view.state.doc.toString();
    const pos = doc.indexOf(">>>>>>> feature") + ">>>>>>> feature".length;
    await typeInResult(host, pos, "\nedited");

    await toggleBlock0ToOurs(ref, selectionsRef);

    expect(ref.current!.getText()).toContain("lead12\nours-a\nedited\nmid1");
  });

  it("keeps a line typed right after a composed block when re-toggling", async () => {
    const { ref, selectionsRef, host } = await mountMergeView();
    await toggleBlock0ToOurs(ref, selectionsRef);

    const view = resultEditorView(host);
    const pos = view.state.doc.toString().indexOf("\nmid1\n") + 1;
    await typeInResult(host, pos, "edited\n");

    // Switch block 0 from ours to theirs.
    selectionsRef.current[0] = {
      ours: selectionsRef.current[0].ours.map(() => false),
      theirs: selectionsRef.current[0].theirs.map(() => true),
    };
    await act(async () => {
      ref.current!.applyBlock(0);
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(ref.current!.getText()).toContain("lead12\ntheirs-a\nedited\nmid1");
  });
});

describe("merge gap expander (integration)", () => {
  it("clicking the expander reveals lines (fold shrinks)", async () => {
    await mountMergeView();

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

  it("expanders survive a block toggle (result-doc surgery shifts the folds)", async () => {
    const { ref, selectionsRef, host } = await mountMergeView();
    // Pane order: Current, Result, Incoming.
    const result = host.querySelectorAll(".cm-editor")[1];

    const fillsBefore = result.querySelectorAll(".cm-hunk-expander-fill").length;
    expect(fillsBefore).toBeGreaterThanOrEqual(2); // lead gap + mid gap at least

    await toggleBlock0ToOurs(ref, selectionsRef);

    const fillsAfter = result.querySelectorAll(".cm-hunk-expander-fill").length;
    expect(fillsAfter).toBe(fillsBefore);
  });

  it("fold bars describe the current chunk after a block toggle", async () => {
    const { ref, selectionsRef, host } = await mountMergeView();
    const result = host.querySelectorAll(".cm-editor")[1];

    await toggleBlock0ToOurs(ref, selectionsRef);

    // The chunk below the lead fold shrank from 11 lines (context + 5 marker
    // lines + context) to 7 (context + 1 composed line + context).
    const bars = Array.from(result.querySelectorAll(".cm-merge-fold")).map(
      (b) => b.textContent,
    );
    expect(bars[0]).toBe("@@ -10,7 +10,7 @@");
  });
});
