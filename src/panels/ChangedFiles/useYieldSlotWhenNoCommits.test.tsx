// @vitest-environment happy-dom
//
// Changed Files in a repo with verifiably no commits yields the shared slot
// to Working Changes (regression: a restored layout, a tab switch, or a View
// menu open could leave Changed Files showing "Select a commit in Log" in a
// log with nothing to select).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useRepoStore } from "../../store/repos";
import { useSummonStore } from "../../store/summon";
import type { Commit, CommitId, RepoSummary } from "../../lib/types";
import { useYieldSlotWhenNoCommits } from "./useYieldSlotWhenNoCommits";

vi.mock("../../lib/commands", () => ({ repoLog: vi.fn(), api: {} }));
import { repoLog } from "../../lib/commands";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const repo = { id: "r1", path: "/r1", name: "r1" } as RepoSummary;

const commit = { id: "c1" } as Commit;

function Harness({ selectedId }: { selectedId: CommitId | null }) {
  useYieldSlotWhenNoCommits(selectedId);
  return null;
}

describe("useYieldSlotWhenNoCommits", () => {
  let root: Root;
  let qc: QueryClient;
  let swapSummon: ReturnType<typeof vi.fn>;
  let savedSwapSummon: unknown;

  const render = (selectedId: CommitId | null) =>
    act(async () => {
      root.render(
        <QueryClientProvider client={qc}>
          <Harness selectedId={selectedId} />
        </QueryClientProvider>,
      );
    });

  // react-query delivers results on its own scheduler ticks; flush inside act
  // until the condition holds (bounded, so a real failure still fails).
  const flushUntil = async (pred: () => boolean) => {
    for (let i = 0; i < 50 && !pred(); i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 5));
      });
    }
  };

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(document.createElement("div"));
    swapSummon = vi.fn();
    savedSwapSummon = useSummonStore.getState().swapSummon;
    useSummonStore.setState({ swapSummon: swapSummon as never });
    useRepoStore.setState({ openRepos: [repo], activeRepoId: repo.id, repoSettings: {} });
    vi.mocked(repoLog).mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    useSummonStore.setState({ swapSummon: savedSwapSummon as never });
    useRepoStore.setState({ openRepos: [], activeRepoId: null });
  });

  it("swaps the slot to Working Changes when the repo has no commits", async () => {
    vi.mocked(repoLog).mockResolvedValue([]);
    await render(null);
    await flushUntil(() => swapSummon.mock.calls.length > 0);
    expect(swapSummon).toHaveBeenCalledWith("working-changes", "changed-files", null);
  });

  it("leaves the slot alone when the repo has commits", async () => {
    vi.mocked(repoLog).mockResolvedValue([commit]);
    await render(null);
    await flushUntil(() => vi.mocked(repoLog).mock.results.length > 0);
    expect(swapSummon).not.toHaveBeenCalled();
  });

  it("does not even probe while the panel shows a delivered commit", async () => {
    vi.mocked(repoLog).mockResolvedValue([]);
    await render("c1" as CommitId);
    await flushUntil(() => false);
    expect(repoLog).not.toHaveBeenCalled();
    expect(swapSummon).not.toHaveBeenCalled();
  });
});
