// @vitest-environment happy-dom
//
// Regression tests for the clear-on-repo-switch policy shared by Commit
// Details and Changed Files (useRepoSwitchClear), under React.StrictMode
// like the dev build.
//
// The key case (2026-08-06): "open submodule at this commit" summons the
// commit to the panels right after openRepo, BEFORE they re-render for the
// submodule repo - a blind clear-on-repo-change then wiped the
// just-delivered selection, so Commit Details / Changed Files stayed empty
// while the log showed the highlight.
import { describe, it, expect, beforeEach } from "vitest";
import React, { act, StrictMode, useCallback, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useRepoStore } from "../../store/repos";
import type { RepoId } from "../../lib/types";
import { useRepoSwitchClear } from "./useRepoSwitchClear";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// Mimics a summon-receiving panel: `receive` is the summon callback
// (adopt payload + markDelivered), the selection clears via the hook.
let receive: (id: string) => void;

function Harness({ repoId }: { repoId: string | undefined }) {
  const [selected, setSelected] = useState<string | null>(null);
  const markDelivered = useRepoSwitchClear(
    repoId,
    useCallback(() => setSelected(null), []),
  );
  receive = (id: string) => {
    setSelected(id);
    markDelivered();
  };
  return <div id="sel">{selected ?? "(none)"}</div>;
}

describe("useRepoSwitchClear", () => {
  let container: HTMLElement;
  let root: Root;

  const render = (repoId: string | undefined) =>
    act(() => {
      root.render(
        <StrictMode>
          <Harness repoId={repoId} />
        </StrictMode>,
      );
    });
  const selection = () => container.querySelector("#sel")!.textContent;
  const setActiveRepo = (id: string | null) =>
    useRepoStore.setState({ activeRepoId: id as RepoId | null });

  beforeEach(() => {
    document.body.innerHTML = "";
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    setActiveRepo(null);
  });

  it("does not clear a payload delivered on first mount (StrictMode)", () => {
    setActiveRepo("repo-a");
    render("repo-a");
    act(() => receive("c1"));
    render("repo-a"); // unrelated re-render, same repo
    expect(selection()).toBe("c1");
  });

  it("clears the selection on an ordinary repo switch", () => {
    setActiveRepo("repo-a");
    render("repo-a");
    act(() => receive("c1"));
    setActiveRepo("repo-b");
    render("repo-b");
    expect(selection()).toBe("(none)");
  });

  it("keeps a selection delivered for the repo being switched to", () => {
    // open-submodule-at-commit: openRepo has already set the active repo to
    // the submodule when the payload arrives, but the panel still renders
    // the superproject until React catches up.
    setActiveRepo("repo-a");
    render("repo-a");
    setActiveRepo("repo-b"); // openRepo switched...
    act(() => receive("c2")); // ...then the summon delivered
    render("repo-b"); // panel catches up with the switch
    expect(selection()).toBe("c2");
  });

  it("the delivered-for marker is one-shot", () => {
    setActiveRepo("repo-a");
    render("repo-a");
    setActiveRepo("repo-b");
    act(() => receive("c2"));
    render("repo-b");
    setActiveRepo("repo-c"); // a later ordinary switch must clear again
    render("repo-c");
    expect(selection()).toBe("(none)");
  });
});
