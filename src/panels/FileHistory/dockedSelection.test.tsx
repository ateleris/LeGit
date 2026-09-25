// @vitest-environment happy-dom
//
// The docked panel highlights the commit whose details it opened, aligned
// with the history window's selection highlight.
import { describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { FileHistoryEntry } from "../../lib/types";

vi.mock("../../lib/commands", () => ({
  repoFileHistory: vi.fn(),
  api: {},
}));
import { repoFileHistory } from "../../lib/commands";

import { FileHistoryPanel } from "./FileHistoryPanel";
import { useRepoStore } from "../../store/repos";
import { useSummonStore } from "../../store/summon";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const entries: FileHistoryEntry[] = [
  { commit_id: "aaa111", path: "a.ts", old_path: null, author: "x", summary: "commit aaa111", timestamp: 1 },
  { commit_id: "bbb222", path: "a.ts", old_path: null, author: "x", summary: "commit bbb222", timestamp: 1 },
];

describe("docked FileHistoryPanel", () => {
  it("highlights the activated row", async () => {
    vi.mocked(repoFileHistory).mockResolvedValue(entries);
    useRepoStore.setState({
      openRepos: [{ id: "r1", path: "/r", name: "r", host: null, locator: "/r" }],
      activeRepoId: "r1",
    } as never);
    // The activation fan-out summons other panels; stub them out.
    useSummonStore.setState({
      summon: vi.fn(),
      swapSummon: vi.fn(),
      notifyIfOpen: vi.fn(),
    } as never);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <QueryClientProvider client={qc}>
          <FileHistoryPanel />
        </QueryClientProvider>,
      );
    });
    // Deliver the file through the real summon registration.
    await act(async () => {
      useSummonStore.getState().callbacks["file-history"]?.("a.ts");
    });
    const findRow = () =>
      [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("commit bbb222"));
    for (let i = 0; i < 50 && !findRow(); i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 5));
      });
    }
    const row = findRow();
    expect(row).toBeTruthy();

    await act(async () => {
      row!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(row!.getAttribute("aria-current")).toBe("true");
  });
});
