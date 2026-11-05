// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act, forwardRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useConfirmStore } from "../../store/confirm";
import { useSettingsStore } from "../../store/settings";
import type { DiffEntry, DiffRequest } from "../../lib/types";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// The editor's header buttons and hover affordances invoke these callbacks
// directly (no menu in between), so DiffBody must hand the editor
// confirm-gated versions. Capture what it receives.
const captured = vi.hoisted(() => ({
  onAction: undefined as ((hunkIndex: number, action: string) => void) | undefined,
  onLineAction: undefined as
    | ((hunkIndex: number, lines: number[], action: string) => void)
    | undefined,
}));

vi.mock("./DiffEditor", () => ({
  DiffEditor: forwardRef(function FakeDiffEditor(
    props: {
      onAction: (hunkIndex: number, action: string) => void;
      onLineAction: (hunkIndex: number, lines: number[], action: string) => void;
    },
    _ref: React.Ref<unknown>,
  ) {
    captured.onAction = props.onAction;
    captured.onLineAction = props.onLineAction;
    return null;
  }),
}));

import { DiffBody } from "./DiffBody";
import { PanelContextMenuProvider } from "../shared/menu/PanelContextMenu";

const request: DiffRequest = {
  repoId: "r1",
  path: "src/a.ts",
  source: { kind: "working_unstaged" },
};

const diff: DiffEntry = {
  Text: {
    old_path: "src/a.ts",
    new_path: "src/a.ts",
    hunks: [
      {
        old_start: 1,
        old_lines: 1,
        new_start: 1,
        new_lines: 1,
        header: "@@ -1 +1 @@",
        lines: [{ kind: "Added", content: "x" }],
      },
    ],
  },
};

let container: HTMLDivElement;
let root: Root;
const onAction = vi.fn();
const onLineAction = vi.fn();

const setGate = (on: boolean) =>
  useSettingsStore.setState({ settings: { confirm_discard: on } } as never);

const flush = () => act(async () => {});

const renderBody = async () => {
  await act(async () => {
    root.render(
      <PanelContextMenuProvider baseline={[]}>
        <DiffBody
          data={diff}
          mode="inline"
          actions={["stage", "discard"]}
          onAction={onAction}
          request={request}
          lineActionOp="stage"
          onLineAction={onLineAction}
          editable={false}
          dirty={false}
          onDirty={() => {}}
          onSaveRequest={() => {}}
          editorRef={{ current: null }}
          rebuildKey={0}
          syntaxPath={null}
        />
      </PanelContextMenuProvider>,
    );
  });
};

describe("DiffBody discard confirmation (editor button path)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    onAction.mockReset();
    onLineAction.mockReset();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    // Drain any dialog a test left pending.
    for (const p of useConfirmStore.getState().queue) {
      useConfirmStore.getState().settle(p.id, false);
    }
  });

  it("asks through the central dialog before a hunk discard", async () => {
    setGate(true);
    await renderBody();
    await act(async () => {
      captured.onAction!(0, "discard");
    });
    expect(onAction).not.toHaveBeenCalled();
    const pending = useConfirmStore.getState().queue.at(-1);
    expect(pending).toBeDefined();
    expect(pending!.confirmLabel).toBe("Discard");
    useConfirmStore.getState().settle(pending!.id, true);
    await flush();
    expect(onAction).toHaveBeenCalledWith(0, "discard");
  });

  it("does not run the discard when the dialog is cancelled", async () => {
    setGate(true);
    await renderBody();
    await act(async () => {
      captured.onAction!(0, "discard");
    });
    const pending = useConfirmStore.getState().queue.at(-1)!;
    useConfirmStore.getState().settle(pending.id, false);
    await flush();
    expect(onAction).not.toHaveBeenCalled();
  });

  it("runs the discard at once when the setting is off", async () => {
    setGate(false);
    await renderBody();
    const before = useConfirmStore.getState().queue.length;
    await act(async () => {
      captured.onAction!(0, "discard");
    });
    expect(useConfirmStore.getState().queue.length).toBe(before);
    expect(onAction).toHaveBeenCalledWith(0, "discard");
  });

  it("never gates stage behind a dialog", async () => {
    setGate(true);
    await renderBody();
    const before = useConfirmStore.getState().queue.length;
    await act(async () => {
      captured.onAction!(0, "stage");
    });
    expect(useConfirmStore.getState().queue.length).toBe(before);
    expect(onAction).toHaveBeenCalledWith(0, "stage");
  });

  it("asks before a line-level discard too", async () => {
    setGate(true);
    await renderBody();
    await act(async () => {
      captured.onLineAction!(0, [1, 2], "discard");
    });
    expect(onLineAction).not.toHaveBeenCalled();
    const pending = useConfirmStore.getState().queue.at(-1);
    expect(pending).toBeDefined();
    useConfirmStore.getState().settle(pending!.id, true);
    await flush();
    expect(onLineAction).toHaveBeenCalledWith(0, [1, 2], "discard");
  });
});
