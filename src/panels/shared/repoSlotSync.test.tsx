// @vitest-environment happy-dom
//
// Reconciling the shared Working Changes / Changed Files dock slot on a repo
// tab switch: the slot occupant is global dock state while each panel's shown
// commit is per-repo view state, so activating a repo must re-derive the slot
// from THAT repo's log selection (regression: switching tabs could show
// Working Changes while a commit was highlighted, or another repo's leftover
// slot choice with a stale commit's files).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { DockviewApi } from "dockview-react";
import { useRepoStore } from "../../store/repos";
import { panelViewStateKey, usePanelViewStateStore } from "../../store/panelViewState";
import { useSummonStore } from "../../store/summon";
import { useDockviewStore } from "../../store/dockview";
import type { RepoId } from "../../lib/types";
import { WORKING_DIR_ID } from "../Commits/commitRows";
import { reconcileSlotAction, useRepoSlotSync } from "./repoSlotSync";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

describe("reconcileSlotAction", () => {
  const base = {
    selectedCommitId: null as string | null,
    shownCommitId: null as string | null,
    changedFilesOpen: false,
    workingChangesOpen: false,
  };

  it("swaps to Changed Files when a commit is selected but Working Changes holds the slot", () => {
    expect(
      reconcileSlotAction({
        ...base,
        selectedCommitId: "c1",
        workingChangesOpen: true,
      }),
    ).toEqual({ kind: "show-changed-files", commitId: "c1" });
  });

  it("updates an open Changed Files showing a different commit", () => {
    expect(
      reconcileSlotAction({
        ...base,
        selectedCommitId: "c1",
        shownCommitId: "c0",
        changedFilesOpen: true,
      }),
    ).toEqual({ kind: "update-changed-files", commitId: "c1" });
  });

  it("does nothing when Changed Files already shows the selected commit (keeps the diff)", () => {
    expect(
      reconcileSlotAction({
        ...base,
        selectedCommitId: "c1",
        shownCommitId: "c1",
        changedFilesOpen: true,
      }),
    ).toEqual({ kind: "none" });
  });

  it("swaps to Working Changes when the working-dir row is selected but Changed Files holds the slot", () => {
    expect(
      reconcileSlotAction({
        ...base,
        selectedCommitId: WORKING_DIR_ID,
        shownCommitId: "c0",
        changedFilesOpen: true,
      }),
    ).toEqual({ kind: "show-working-changes" });
  });

  it("swaps to Working Changes when nothing is selected but Changed Files shows a stale commit", () => {
    expect(
      reconcileSlotAction({
        ...base,
        shownCommitId: "c0",
        changedFilesOpen: true,
      }),
    ).toEqual({ kind: "show-working-changes" });
  });

  it("does nothing when nothing is selected and Changed Files shows nothing", () => {
    expect(
      reconcileSlotAction({ ...base, changedFilesOpen: true }),
    ).toEqual({ kind: "none" });
  });

  it("does nothing when the working-dir row is selected and Working Changes holds the slot", () => {
    expect(
      reconcileSlotAction({
        ...base,
        selectedCommitId: WORKING_DIR_ID,
        workingChangesOpen: true,
      }),
    ).toEqual({ kind: "none" });
  });

  it("never opens a panel when neither slot panel is open (respects the layout)", () => {
    expect(reconcileSlotAction({ ...base, selectedCommitId: "c1" })).toEqual({ kind: "none" });
    expect(
      reconcileSlotAction({ ...base, selectedCommitId: WORKING_DIR_ID }),
    ).toEqual({ kind: "none" });
  });
});

describe("useRepoSlotSync", () => {
  let container: HTMLElement;
  let root: Root;
  let openPanels: Set<string>;
  let swapSummon: ReturnType<typeof vi.fn>;
  let notifyIfOpen: ReturnType<typeof vi.fn>;
  let savedSummon: { swapSummon: unknown; notifyIfOpen: unknown };

  function Harness() {
    useRepoSlotSync();
    return null;
  }

  const render = () =>
    act(() => {
      root.render(
        <StrictMode>
          <Harness />
        </StrictMode>,
      );
    });
  const setActiveRepo = (id: string | null) =>
    act(() => {
      useRepoStore.setState({ activeRepoId: id as RepoId | null });
    });
  const setViewState = (repoId: string, stateKey: string, value: unknown) =>
    usePanelViewStateStore.getState().setValue(panelViewStateKey(repoId, stateKey), value);

  beforeEach(() => {
    document.body.innerHTML = "";
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    openPanels = new Set();
    useDockviewStore.setState({
      repoApi: {
        getPanel: (id: string) => (openPanels.has(id) ? {} : undefined),
      } as unknown as DockviewApi,
    });
    swapSummon = vi.fn();
    notifyIfOpen = vi.fn();
    const s = useSummonStore.getState();
    savedSummon = { swapSummon: s.swapSummon, notifyIfOpen: s.notifyIfOpen };
    useSummonStore.setState({
      swapSummon: swapSummon as never,
      notifyIfOpen: notifyIfOpen as never,
    });
    usePanelViewStateStore.setState({ values: {} });
    useRepoStore.setState({ activeRepoId: "repo-a" as RepoId });
  });

  afterEach(() => {
    act(() => root.unmount());
    useSummonStore.setState(savedSummon as never);
    useDockviewStore.setState({ repoApi: null });
  });

  it("does not reconcile on mount (startup must not rewrite the restored layout)", () => {
    openPanels.add("changed-files");
    setViewState("repo-a", "commits.selectedId", WORKING_DIR_ID);
    render();
    expect(swapSummon).not.toHaveBeenCalled();
    expect(notifyIfOpen).not.toHaveBeenCalled();
  });

  it("swaps the slot to Changed Files with the activated repo's selected commit", () => {
    openPanels.add("working-changes");
    setViewState("repo-b", "commits.selectedId", "c1");
    render();
    setActiveRepo("repo-b");
    expect(swapSummon).toHaveBeenCalledWith("changed-files", "working-changes", "c1");
  });

  it("swaps the slot back to Working Changes when the activated repo selects the working dir", () => {
    openPanels.add("changed-files");
    setViewState("repo-b", "commits.selectedId", WORKING_DIR_ID);
    setViewState("repo-b", "changed-files.selectedId", "c0");
    render();
    setActiveRepo("repo-b");
    expect(swapSummon).toHaveBeenCalledWith("working-changes", "changed-files", null);
  });

  it("re-delivers the selected commit to an open Changed Files showing another commit", () => {
    openPanels.add("changed-files");
    setViewState("repo-b", "commits.selectedId", "c1");
    setViewState("repo-b", "changed-files.selectedId", "c0");
    render();
    setActiveRepo("repo-b");
    expect(notifyIfOpen).toHaveBeenCalledWith("changed-files", "c1");
    expect(swapSummon).not.toHaveBeenCalled();
  });

  it("leaves a consistent repo alone (no delivery, so its diff view survives)", () => {
    openPanels.add("changed-files");
    setViewState("repo-b", "commits.selectedId", "c1");
    setViewState("repo-b", "changed-files.selectedId", "c1");
    render();
    setActiveRepo("repo-b");
    expect(swapSummon).not.toHaveBeenCalled();
    expect(notifyIfOpen).not.toHaveBeenCalled();
  });

  it("does nothing when the last repo closes (no active repo)", () => {
    openPanels.add("changed-files");
    render();
    setActiveRepo(null);
    expect(swapSummon).not.toHaveBeenCalled();
    expect(notifyIfOpen).not.toHaveBeenCalled();
  });
});
