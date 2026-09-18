// @vitest-environment happy-dom
//
// usePanelViewState: panel viewing context (selection, shown file, filters)
// that survives the two routine unmounts - a layout apply's `fromJSON` dock
// rebuild and the slot-sharing swaps (Diff <-> Merge, Working Changes <->
// Changed Files) - keyed per repo, under React.StrictMode like the dev build.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useRepoStore } from "./repos";
import type { RepoId } from "../lib/types";
import { usePanelViewState, usePanelViewStateStore } from "./panelViewState";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let setSelected: (v: React.SetStateAction<string | null>) => void;

function Harness() {
  const [selected, set] = usePanelViewState<string | null>("test.selected", null);
  setSelected = set;
  return <div id="sel">{selected ?? "(none)"}</div>;
}

describe("usePanelViewState", () => {
  let container: HTMLElement;
  let root: Root;

  const render = () =>
    act(() => {
      root.render(
        <StrictMode>
          <Harness />
        </StrictMode>,
      );
    });
  const unmount = () => act(() => root.render(<StrictMode>{null}</StrictMode>));
  const selection = () => container.querySelector("#sel")?.textContent ?? null;
  const setActiveRepo = (id: string | null) =>
    useRepoStore.setState({ activeRepoId: id as RepoId | null });

  beforeEach(() => {
    document.body.innerHTML = "";
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    setActiveRepo("repo-a");
    usePanelViewStateStore.setState({ values: {} });
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  it("returns the initial value when nothing is stored", () => {
    render();
    expect(selection()).toBe("(none)");
  });

  it("survives an unmount/remount (layout apply, slot swap)", () => {
    render();
    act(() => setSelected("file.txt"));
    expect(selection()).toBe("file.txt");
    unmount();
    render();
    expect(selection()).toBe("file.txt");
  });

  it("keys values per repo and restores them on switching back", () => {
    render();
    act(() => setSelected("a.txt"));
    act(() => setActiveRepo("repo-b"));
    expect(selection()).toBe("(none)");
    act(() => setSelected("b.txt"));
    expect(selection()).toBe("b.txt");
    act(() => setActiveRepo("repo-a"));
    expect(selection()).toBe("a.txt");
  });

  it("writes under the repo active at call time, not at render time", () => {
    // open-submodule-at-commit: openRepo has already switched the active repo
    // when the summon payload arrives, but the panel still renders the
    // superproject until React catches up - the write must land under the
    // destination repo's key.
    render();
    setActiveRepo("repo-b"); // openRepo switched...
    act(() => setSelected("c2")); // ...then the summon delivered
    render(); // panel catches up with the switch
    expect(selection()).toBe("c2");
    act(() => setActiveRepo("repo-a"));
    expect(selection()).toBe("(none)");
  });

  it("supports functional updates against the stored value", () => {
    render();
    act(() => setSelected("a"));
    unmount();
    render();
    act(() => setSelected((prev) => `${prev}+b`));
    expect(selection()).toBe("a+b");
  });
});
