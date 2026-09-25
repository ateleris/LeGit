// @vitest-environment happy-dom
//
// Load more bumps the query key (pageCount); the previous page must stay
// rendered while the next loads, or the window's selection sync sees an
// empty list and resets to the newest commit.
import { describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useFileHistoryQuery } from "./FileHistoryList";
import type { FileHistoryEntry } from "../../lib/types";

vi.mock("../../lib/commands", () => ({ repoFileHistory: vi.fn(), api: {} }));
import { repoFileHistory } from "../../lib/commands";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const entries = (sha: string): FileHistoryEntry[] => [
  { commit_id: sha, path: "a.ts", old_path: null, author: "x", summary: sha, timestamp: 1 },
];

function Probe({ pageCount, onData }: { pageCount: number; onData: (d: unknown) => void }) {
  const q = useFileHistoryQuery("r1", "a.ts", null, pageCount);
  onData(q.data);
  return null;
}

describe("useFileHistoryQuery", () => {
  it("keeps the previous page's entries while the next page loads", async () => {
    const resolvers: ((v: FileHistoryEntry[]) => void)[] = [];
    vi.mocked(repoFileHistory).mockImplementation(
      () => new Promise<FileHistoryEntry[]>((res) => resolvers.push(res)),
    );
    const seen: unknown[] = [];
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const host = document.createElement("div");
    const root = createRoot(host);
    const render = (pageCount: number) =>
      act(async () => {
        root.render(
          <QueryClientProvider client={qc}>
            <Probe pageCount={pageCount} onData={(d) => seen.push(d)} />
          </QueryClientProvider>,
        );
      });

    // react-query delivers results on its own scheduler ticks; flush inside
    // act until the probe saw the data (bounded, so a real failure still fails).
    const flushUntil = async (pred: () => boolean) => {
      for (let i = 0; i < 50 && !pred(); i++) {
        await act(async () => {
          await new Promise((r) => setTimeout(r, 5));
        });
      }
    };

    await render(1);
    resolvers[0]!(entries("one"));
    await flushUntil(() => Array.isArray(seen[seen.length - 1]));
    expect(seen[seen.length - 1]).toEqual(entries("one"));

    // Page 2 pending: the hook must still expose page 1, not undefined.
    await render(2);
    expect(seen[seen.length - 1]).toEqual(entries("one"));
  });
});
