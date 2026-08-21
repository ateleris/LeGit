// @vitest-environment happy-dom
//
// Regression test for the close-last-repo / reopen-first-repo crash
// (React #300 "rendered fewer hooks" / #310 "rendered more hooks"): the
// Commits panel stays mounted when the last repo closes and early-returns
// its "No repo open." placeholder - any hook declared BELOW that early
// return changes the panel's hook count across the transition and blows up
// the whole tree at the app ErrorBoundary. The quick-search hooks
// (quickBufferRef & friends) used to live below it.
import { describe, it, expect, vi, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useRepoStore } from "../../store/repos";
import type { RepoId, RepoSummary } from "../../lib/types";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// Every backend command hangs forever: queries stay pending, the panel
// renders its loading shell - which is all the hook-order check needs.
vi.mock("../../lib/commands", async (importOriginal) => {
  const mod = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(
    Object.entries(mod).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(() => new Promise(() => {})) : v,
    ]),
  );
});

import { CommitsPanel } from "./CommitsPanel";

const REPO: RepoSummary = {
  id: "repo-1" as RepoId,
  path: "/tmp/repo-1",
  name: "repo-1",
};

describe("CommitsPanel repo open/close hook order", () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = "";
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  it("survives closing the last repo and reopening one while mounted", () => {
    useRepoStore.setState({
      openRepos: [REPO],
      activeRepoId: REPO.id,
      initialized: true,
    });
    const client = new QueryClient();
    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <CommitsPanel />
        </QueryClientProvider>,
      );
    });

    // Close the last repo: the mounted panel re-renders into its
    // "No repo open." placeholder. Pre-fix: "Rendered fewer hooks than
    // expected" (minified React #300).
    expect(() =>
      act(() => {
        useRepoStore.setState({ openRepos: [], activeRepoId: null });
      }),
    ).not.toThrow();
    expect(container.textContent).toContain("No repo open.");

    // Reopen a repo: the placeholder render flips back to the full panel.
    // Pre-fix: "Rendered more hooks than during the previous render"
    // (minified React #310).
    expect(() =>
      act(() => {
        useRepoStore.setState({ openRepos: [REPO], activeRepoId: REPO.id });
      }),
    ).not.toThrow();
    expect(container.textContent).not.toContain("No repo open.");
  });
});
