// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SubmoduleDirtyNotice } from "./SubmoduleDiffView";
import { useRepoStore } from "../../store/repos";
import type { RepoSummary } from "../../lib/types";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const render = async (el: React.ReactElement) =>
  act(async () => {
    root.render(el);
  });

const repo = (overrides: Partial<RepoSummary>): RepoSummary =>
  ({
    id: "r1",
    path: "/home/u/repo",
    name: "repo",
    ...overrides,
  }) as RepoSummary;

describe("SubmoduleDirtyNotice", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    useRepoStore.setState({ openRepos: [] });
  });

  const clickOpen = async () => {
    const button = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Open submodule",
    );
    expect(button).toBeDefined();
    await act(async () => {
      button!.click();
    });
  };

  // The button used to concatenate the bare HOST path, which dropped the
  // `wsl://<distro>` scheme: the submodule of a WSL repo then opened (and
  // failed) as a local Windows path, while the Working Changes menu and the
  // Submodules pane opened it correctly via the locator.
  it("opens a WSL submodule on the parent's host (locator, not bare path)", async () => {
    const openRepo = vi.fn().mockResolvedValue(undefined);
    useRepoStore.setState({
      openRepos: [repo({ locator: "wsl://Ubuntu/home/u/repo" })],
      openRepo,
    });
    await render(<SubmoduleDirtyNotice repoId="r1" path="libs/sub" />);
    await clickOpen();
    expect(openRepo).toHaveBeenCalledWith("wsl://Ubuntu/home/u/repo/libs/sub");
  });

  it("falls back to the path for pre-locator local repos", async () => {
    const openRepo = vi.fn().mockResolvedValue(undefined);
    useRepoStore.setState({ openRepos: [repo({})], openRepo });
    await render(<SubmoduleDirtyNotice repoId="r1" path="libs/sub" />);
    await clickOpen();
    expect(openRepo).toHaveBeenCalledWith("/home/u/repo/libs/sub");
  });
});
