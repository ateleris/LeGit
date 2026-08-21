// @vitest-environment happy-dom
//
// Regression test for the same hook-order bug class as
// CommitsPanel.test.tsx: OpStateBanner used to declare a useEffect BELOW
// its `kind === "none"` early return, so a mounted banner re-rendering
// into the "none" state dropped a hook (React #300) and re-rendering back
// added one (React #310).
import { describe, it, expect, vi, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RepoOpState } from "../lib/types";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../lib/commands", async (importOriginal) => {
  const mod = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(
    Object.entries(mod).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(() => new Promise(() => {})) : v,
    ]),
  );
});

import { OpStateBanner } from "./OpStateStrip";

describe("OpStateBanner op-state transition hook order", () => {
  let container: HTMLElement;
  let root: Root;
  const client = new QueryClient();

  const render = (opState: RepoOpState) =>
    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <OpStateBanner repoId="repo-1" opState={opState} conflictCount={0} />
        </QueryClientProvider>,
      );
    });

  beforeEach(() => {
    document.body.innerHTML = "";
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  it("survives a mounted banner re-rendering merge -> none -> merge", () => {
    render({ kind: "merge", branch: "feature", message: null });
    expect(container.textContent).toContain("Merging");

    // Pre-fix: "Rendered fewer hooks than expected" (React #300).
    expect(() => render({ kind: "none" })).not.toThrow();
    expect(container.textContent).toBe("");

    // Pre-fix: "Rendered more hooks than during the previous render" (#310).
    expect(() =>
      render({ kind: "merge", branch: "feature", message: null }),
    ).not.toThrow();
    expect(container.textContent).toContain("Merging");
  });
});
