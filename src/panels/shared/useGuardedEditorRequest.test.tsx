// @vitest-environment happy-dom
//
// The Diff and Merge panels' "unsaved edits" guard around summoned file
// switches. Merge used to clear an unsaved resolution silently when summoned
// with null ("clear the panel"); both panels now hold every switch away from
// the current target until the user decides.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useRepoStore } from "../../store/repos";
import { useSummonStore } from "../../store/summon";
import { usePanelViewStateStore } from "../../store/panelViewState";
import type { RepoId } from "../../lib/types";
import { holdsSwitch, useGuardedEditorRequest } from "./useGuardedEditorRequest";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

type Req = { repoId: string; path: string };
const same = (a: Req | null, b: Req | null) => !!a && !!b && a.repoId === b.repoId && a.path === b.path;
let hook: ReturnType<typeof useGuardedEditorRequest<Req>>;

function Harness() {
  hook = useGuardedEditorRequest<Req>({ panelId: "test-editor", viewStateKey: "test.request", sameTarget: same });
  return null;
}

const deliver = (payload: Req | null) =>
  act(() => {
    useSummonStore.getState().callbacks["test-editor"]?.(payload);
  });

describe("holdsSwitch", () => {
  const a = { repoId: "r", path: "a" };
  const b = { repoId: "r", path: "b" };
  it("never holds while clean", () => {
    expect(holdsSwitch(false, b, a, same)).toBe(false);
    expect(holdsSwitch(false, null, a, same)).toBe(false);
  });
  it("holds a different target, including clearing, while dirty", () => {
    expect(holdsSwitch(true, b, a, same)).toBe(true);
    expect(holdsSwitch(true, null, a, same)).toBe(true);
  });
  it("lets the same target through while dirty", () => {
    expect(holdsSwitch(true, { ...a }, a, same)).toBe(false);
  });
});

describe("useGuardedEditorRequest", () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useRepoStore.setState({ activeRepoId: "r" as RepoId });
    usePanelViewStateStore.setState({ values: {} });
    act(() => root.render(<StrictMode><Harness /></StrictMode>));
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  it("adopts a summon at once while clean", () => {
    deliver({ repoId: "r", path: "a" });
    expect(hook.request?.path).toBe("a");
    expect(hook.pending).toBeNull();
  });

  it("holds a switch while dirty until accepted", () => {
    deliver({ repoId: "r", path: "a" });
    act(() => hook.setDirty(true));
    deliver({ repoId: "r", path: "b" });
    expect(hook.request?.path).toBe("a");
    expect(hook.pending?.req?.path).toBe("b");

    act(() => hook.acceptPending());
    expect(hook.request?.path).toBe("b");
    expect(hook.dirty).toBe(false);
    expect(hook.pending).toBeNull();
  });

  it("keeps the edits when the switch is rejected", () => {
    deliver({ repoId: "r", path: "a" });
    act(() => hook.setDirty(true));
    deliver({ repoId: "r", path: "b" });
    act(() => hook.rejectPending());
    expect(hook.request?.path).toBe("a");
    expect(hook.dirty).toBe(true);
  });

  it("holds a clear (null summon) while dirty", () => {
    deliver({ repoId: "r", path: "a" });
    act(() => hook.setDirty(true));
    deliver(null);
    expect(hook.request?.path).toBe("a");
    expect(hook.pending).toEqual({ req: null });
  });

  it("drops edits and a pending switch on a repo switch", () => {
    deliver({ repoId: "r", path: "a" });
    act(() => hook.setDirty(true));
    deliver({ repoId: "r", path: "b" });
    act(() => useRepoStore.setState({ activeRepoId: "other" as RepoId }));
    expect(hook.dirty).toBe(false);
    expect(hook.pending).toBeNull();
  });

  it("guards saves against re-entry", async () => {
    let release!: () => void;
    let calls = 0;
    const slow = () =>
      new Promise<void>((r) => {
        calls++;
        release = r;
      });
    let first!: Promise<void>;
    act(() => {
      first = hook.guardSave(slow);
    });
    await act(() => hook.guardSave(slow));
    expect(calls).toBe(1);
    release();
    await act(() => first);
    await act(() => hook.guardSave(async () => { calls++; }));
    expect(calls).toBe(2);
  });
});
