// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DockviewApi } from "dockview-react";
import { focusedDockPanelId, useDockviewStore } from "./dockview";

const fakeApi = (activeId: string | null) =>
  ({ activePanel: activeId ? { id: activeId } : undefined }) as unknown as DockviewApi;

let globalRegion: HTMLDivElement;
let repoArea: HTMLDivElement;

beforeEach(() => {
  globalRegion = document.createElement("div");
  globalRegion.className = "legit-global-region";
  globalRegion.innerHTML = "<button id='g'>g</button>";
  repoArea = document.createElement("div");
  repoArea.innerHTML = "<button id='r'>r</button>";
  document.body.append(globalRegion, repoArea);
  useDockviewStore.setState({ globalApi: fakeApi("theme-editor"), repoApi: fakeApi("log") });
});

afterEach(() => {
  globalRegion.remove();
  repoArea.remove();
  useDockviewStore.setState({ globalApi: null, repoApi: null });
});

describe("focusedDockPanelId", () => {
  // Regression: selecting a file summons the Diff panel, which makes Diff the
  // dock's ACTIVE panel while keyboard focus stays in the Working Changes
  // list - panel-scoped shortcuts (Ctrl+A) must follow the DOM focus, not the
  // summoned panel.
  it("prefers the panel whose content holds DOM focus over the dock's active panel", () => {
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-panel-id", "working-changes");
    wrapper.innerHTML = "<div tabindex='0' id='list'></div>";
    document.body.appendChild(wrapper);
    (wrapper.querySelector("#list") as HTMLElement).focus();
    expect(focusedDockPanelId()).toBe("working-changes");
    wrapper.remove();
  });

  it("returns the global dock's active panel while focus is in the global region", () => {
    (globalRegion.querySelector("#g") as HTMLElement).focus();
    expect(focusedDockPanelId()).toBe("theme-editor");
  });

  it("returns the repo dock's active panel otherwise (incl. body focus)", () => {
    (repoArea.querySelector("#r") as HTMLElement).focus();
    expect(focusedDockPanelId()).toBe("log");
    (document.activeElement as HTMLElement | null)?.blur();
    expect(focusedDockPanelId()).toBe("log");
  });

  it("returns null when the focused dock has no active panel or no api", () => {
    useDockviewStore.setState({ repoApi: fakeApi(null) });
    (repoArea.querySelector("#r") as HTMLElement).focus();
    expect(focusedDockPanelId()).toBeNull();
    useDockviewStore.setState({ repoApi: null });
    expect(focusedDockPanelId()).toBeNull();
  });
});
