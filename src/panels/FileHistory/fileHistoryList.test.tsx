// @vitest-environment happy-dom
//
// The shared history list is presentational: rows, selection highlight,
// empty/error states and the Load-more affordance; both the docked panel and
// the history window render it with their own wiring.
import { describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { FileHistoryList } from "./FileHistoryList";
import { openCommitFromHistory } from "./FileHistoryPanel";
import { PanelContextMenuProvider } from "../shared/menu/PanelContextMenu";
import { useSummonStore } from "../../store/summon";
import type { FileHistoryEntry } from "../../lib/types";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const entry = (sha: string): FileHistoryEntry => ({
  commit_id: sha,
  path: "src/a.ts",
  old_path: null,
  author: "ada",
  summary: `commit ${sha}`,
  timestamp: 1700000000,
});

const noMenu = () => null;

type ListProps = Partial<React.ComponentProps<typeof FileHistoryList>>;

function renderList(props: ListProps) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      <PanelContextMenuProvider baseline={[]}>
        <FileHistoryList
          entries={[]}
          busy={false}
          error={null}
          maybeMore={false}
          onLoadMore={() => {}}
          onActivate={() => {}}
          renderMenu={noMenu}
          {...props}
        />
      </PanelContextMenuProvider>
    );
  });
  return { host, root };
}

describe("FileHistoryList", () => {
  it("activates a row on click", () => {
    const onActivate = vi.fn();
    const { host } = renderList({ entries: [entry("aaa111"), entry("bbb222")], onActivate });
    const row = [...host.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("commit bbb222")
    );
    act(() => {
      row!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onActivate).toHaveBeenCalledWith(expect.objectContaining({ commit_id: "bbb222" }));
  });

  it("marks the selected row", () => {
    const { host } = renderList({ entries: [entry("aaa111")], selectedSha: "aaa111" });
    expect(host.querySelector("[aria-current]")).toBeTruthy();
  });

  it("shows Load more only when a full page arrived", () => {
    const { host: without } = renderList({ entries: [entry("a")], maybeMore: false });
    expect(without.textContent).not.toContain("Load more");
    const { host: with_ } = renderList({ entries: [entry("a")], maybeMore: true });
    expect(with_.textContent).toContain("Load more");
  });
});

describe("openCommitFromHistory", () => {
  it("docked activation drives the four main-window panels", () => {
    const summon = vi.fn();
    const swapSummon = vi.fn();
    const notifyIfOpen = vi.fn();
    useSummonStore.setState({ summon, swapSummon, notifyIfOpen });
    openCommitFromHistory("abc123", "src/a.ts");
    expect(summon).toHaveBeenCalledWith("commit-details", "abc123");
    expect(swapSummon).toHaveBeenCalledWith("changed-files", "working-changes", {
      commitId: "abc123",
      selectPath: "src/a.ts",
    });
    expect(notifyIfOpen).toHaveBeenCalledWith("log", "abc123");
    expect(notifyIfOpen).toHaveBeenCalledWith("files", { rev: "abc123" });
  });
});
