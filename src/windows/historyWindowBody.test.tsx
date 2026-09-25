// @vitest-environment happy-dom
//
// The splitview divider gets its colours from the --dv-* -> token mapping in
// global.css, which is scoped to .dv-dockview / .dockview-theme-abyss - the
// wrapper must carry the class or the sash renders unthemed (RefsPanel
// precedent).
import { describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../lib/commands", () => ({
  repoFileHistory: vi.fn(() => new Promise(() => {})),
  api: {},
}));

import { HistoryWindowBody } from "./HistoryWindowShell";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

describe("HistoryWindowBody", () => {
  it("wraps the splitview in the dockview theme class", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <QueryClientProvider client={qc}>
          <HistoryWindowBody
            ctx={{ repo_id: "r1", path: "a.ts", rev: null, repo_name: "repo", repo_path: "/r" }}
          />
        </QueryClientProvider>,
      );
    });
    expect(host.querySelector(".dockview-theme-abyss")).toBeTruthy();
  });
});
