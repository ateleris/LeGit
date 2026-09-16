// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { FileTreeEntry } from "./buildTree";
import { FileTree } from "./FileTree";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const FILES: FileTreeEntry[] = [
  { path: "src/one.ts", change: "Modified" },
  { path: "src/two.ts", change: "Modified" },
  { path: "z.txt", change: "Modified" },
];

// Tree order: dir rows first (alphabetical), then loose files - so rows are
// [dir src, src/one.ts, src/two.ts, z.txt].
function render(
  onSelectionChange: (paths: string[]) => void,
  selectedPaths: Set<string>,
  opts: {
    onToggleStage?: (paths: string[], next: string | null) => void;
    chords?: string[];
    pending?: Set<string>;
  } = {},
) {
  return act(async () =>
    root.render(
      <FileTree
        files={FILES}
        viewMode="tree"
        selectedPath={null}
        multiSelect
        selectedPaths={selectedPaths}
        onSelectionChange={onSelectionChange}
        onToggleStage={opts.onToggleStage ?? (() => {})}
        toggleStageChords={opts.chords}
        stagePendingPaths={opts.pending}
      />,
    ),
  );
}

const tree = () => host.querySelector("[tabindex]") as HTMLElement;

const press = (key: string, init: KeyboardEventInit = {}) =>
  act(async () => {
    tree().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  });

describe("FileTree keyboard selection", () => {
  it("arrowing onto a folder clears the file selection (the folder becomes the actor)", async () => {
    const onSelectionChange = vi.fn();
    await render(onSelectionChange, new Set(["z.txt"]));
    await press("ArrowDown"); // first press lands on row 0: the src dir
    expect(onSelectionChange).toHaveBeenCalledWith([]);
  });

  it("arrowing onto a file selects it", async () => {
    const onSelectionChange = vi.fn();
    await render(onSelectionChange, new Set());
    await press("ArrowDown"); // dir src
    await press("ArrowDown"); // src/one.ts
    expect(onSelectionChange).toHaveBeenLastCalledWith(["src/one.ts"]);
  });

  it("Shift+ArrowDown extends the selection as a range", async () => {
    const onSelectionChange = vi.fn();
    await render(onSelectionChange, new Set());
    await press("ArrowDown"); // dir src
    await press("ArrowDown"); // src/one.ts (anchor)
    await press("ArrowDown", { shiftKey: true }); // extend to src/two.ts
    expect(onSelectionChange).toHaveBeenLastCalledWith(["src/one.ts", "src/two.ts"]);
  });
});

describe("stage-toggle binding (widget-handled command)", () => {
  it("the default Space binding stages the cursor row", async () => {
    const onToggleStage = vi.fn();
    await render(vi.fn(), new Set(), { onToggleStage });
    await press("ArrowDown"); // dir src
    await press("ArrowDown"); // src/one.ts
    await press(" ");
    expect(onToggleStage).toHaveBeenCalledWith(["src/one.ts"], "src/two.ts");
  });

  it("a rebound key (Enter) stages instead of activating", async () => {
    const onToggleStage = vi.fn();
    const onSelectionChange = vi.fn();
    await render(onSelectionChange, new Set(), { onToggleStage, chords: ["Enter"] });
    await press("ArrowDown"); // dir src
    await press("ArrowDown"); // src/one.ts
    onSelectionChange.mockClear();
    await press("Enter");
    expect(onToggleStage).toHaveBeenCalledWith(["src/one.ts"], "src/two.ts");
    expect(onSelectionChange).not.toHaveBeenCalled();
    await press(" ");
    expect(onToggleStage).toHaveBeenCalledTimes(1);
  });

  it("the cursor advance skips files already pending from queued ops", async () => {
    // Rows: [dir src, src/one.ts, src/two.ts, z.txt]; z.txt is mid-stage from
    // an earlier press, so staging src/two.ts must fall BACK to src/one.ts
    // instead of landing on the in-flight z.txt.
    const onToggleStage = vi.fn();
    await render(vi.fn(), new Set(), { onToggleStage, pending: new Set(["z.txt"]) });
    await press("ArrowDown"); // dir src
    await press("ArrowDown"); // src/one.ts
    await press("ArrowDown"); // src/two.ts
    await press(" ");
    expect(onToggleStage).toHaveBeenCalledWith(["src/two.ts"], "src/one.ts");
  });

  it("with the binding cleared, no key stages", async () => {
    const onToggleStage = vi.fn();
    await render(vi.fn(), new Set(), { onToggleStage, chords: [] });
    await press("ArrowDown");
    await press("ArrowDown");
    await press(" ");
    expect(onToggleStage).not.toHaveBeenCalled();
  });
});
