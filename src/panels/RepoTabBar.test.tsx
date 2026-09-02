// @vitest-environment happy-dom
//
// Regression: with a "Cloning" tab selected, clicking the repo tab that had
// been active before the clone started did nothing - the clone store only
// deselected itself when `activeRepoId` CHANGED, and re-selecting the
// already-active repo changes nothing. The user had to click a second, other
// tab before anything happened.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../lib/commands", () => ({
  cancelClone: vi.fn(() => Promise.resolve(true)),
  setActiveRepo: vi.fn(() => Promise.resolve()),
  getRepoSettings: vi.fn(() => Promise.resolve({})),
  repoRemoteWebUrl: vi.fn(() => Promise.resolve(null)),
  repoSuperproject: vi.fn(() => Promise.resolve(null)),
  repoOpenInEditor: vi.fn(() => Promise.resolve()),
  repoOpenRemotePage: vi.fn(() => Promise.resolve()),
}));
vi.mock("../lib/editorAction", () => ({
  useEditorAction: () => ({ label: "Open in editor", opensFolder: false }),
}));
vi.mock("./ViewMenu", () => ({ ViewMenu: () => null }));
vi.mock("./RepoOverflowMenu", () => ({ RepoOverflowMenu: () => null }));
vi.mock("./RepoAddMenu", () => ({ RepoAddMenu: () => null }));

import { RepoTabBar } from "./RepoTabBar";
import { useCloneStore } from "../store/clone";
import { useRepoStore } from "../store/repos";
import { useSettingsStore } from "../store/settings";

const REPOS = [
  { id: "a", name: "alpha", path: "/src/alpha" },
  { id: "b", name: "beta", path: "/src/beta" },
];

describe("RepoTabBar with a running clone", () => {
  let container: HTMLElement;
  let root: Root;

  const repoTabs = () => Array.from(container.querySelectorAll<HTMLElement>('[data-testid="repo-tab"]'));
  const cloneTab = () => container.querySelector<HTMLElement>('[data-testid="clone-tab"]')!;
  const isActive = (el: HTMLElement) => el.classList.contains("is-active");

  beforeEach(() => {
    useRepoStore.setState({
      openRepos: REPOS,
      activeRepoId: "a",
      initialized: true,
      repoSettings: { a: {}, b: {} },
      cloneRepo: vi.fn(() => new Promise(() => {})),
    } as never);
    useCloneStore.setState({ jobs: {}, focusedOpId: null, completedCount: 0 });
    useSettingsStore.setState({ settings: { confirm_discard: true } } as never);
    document.body.innerHTML = "";
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const client = new QueryClient();
    act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <RepoTabBar />
        </QueryClientProvider>,
      ),
    );
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  it("a new clone's tab takes the active highlight from the active repo", () => {
    expect(isActive(repoTabs()[0])).toBe(true);
    act(() => {
      useCloneStore.getState().start({ url: "u", parentDir: "/src", name: "gamma", profileId: null, options: {} });
    });
    expect(isActive(cloneTab())).toBe(true);
    expect(repoTabs().some(isActive)).toBe(false);
  });

  it("one click on the previously active repo tab brings it back", () => {
    act(() => {
      useCloneStore.getState().start({ url: "u", parentDir: "/src", name: "gamma", profileId: null, options: {} });
    });
    expect(isActive(cloneTab())).toBe(true);

    // Repo "a" is still `activeRepoId`; the click must still deselect the clone.
    act(() => repoTabs()[0].click());

    expect(useCloneStore.getState().focusedOpId).toBeNull();
    expect(useRepoStore.getState().activeRepoId).toBe("a");
    expect(isActive(repoTabs()[0])).toBe(true);
    expect(isActive(cloneTab())).toBe(false);
  });

  it("clicking another repo tab switches to it and deselects the clone", () => {
    act(() => {
      useCloneStore.getState().start({ url: "u", parentDir: "/src", name: "gamma", profileId: null, options: {} });
    });
    act(() => repoTabs()[1].click());
    expect(useCloneStore.getState().focusedOpId).toBeNull();
    expect(useRepoStore.getState().activeRepoId).toBe("b");
    expect(isActive(repoTabs()[1])).toBe(true);
  });

  it("clicking the clone tab selects it again", () => {
    let opId = "";
    act(() => {
      opId = useCloneStore.getState().start({ url: "u", parentDir: "/src", name: "gamma", profileId: null, options: {} });
    });
    act(() => repoTabs()[0].click());
    act(() => cloneTab().click());
    expect(useCloneStore.getState().focusedOpId).toBe(opId);
    expect(isActive(cloneTab())).toBe(true);
    expect(repoTabs().some(isActive)).toBe(false);
  });
});
