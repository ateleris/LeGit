// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../lib/commands", () => ({
  api: {
    listRepos: vi.fn(async () => []),
    listGitProfiles: vi.fn(async () => []),
  },
}));

import { WorkLogDayDetail, WorkLogDayList, WorkLogWindowBody } from "./WorkLogWindowShell";
import { buildWorkLog, type RepoGroup } from "./workLog";
import type { StashEntry, WorkLogCommit } from "../lib/bindings";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = 1794522600; // 2026-11-12T22:30:00Z
const GROUP: RepoGroup = { key: "/r/.git", name: "repo", repoIds: ["r1"], primaryRepoId: "r1" };

function commit(sha: string, subject: string, ts: number): WorkLogCommit {
  return {
    id: sha,
    author: { name: "A", email: "a@b.com", timestamp: ts, tz_offset_minutes: 60 },
    subject,
    source_ref: "refs/heads/dev",
  };
}

function view() {
  return buildWorkLog({
    groups: [GROUP],
    commitsByRepo: {
      r1: [commit("s-early", "early work", NOW - 10 * 3600), commit("s-late", "late work", NOW - 60)],
    },
    stashesByRepo: {},
    uncommittedByRepo: {
      r1: [
        {
          repoId: "r1",
          repoName: "repo",
          path: "wip.txt",
          oldPath: null,
          state: "Modified",
          staged: false,
          mtimeUnix: NOW - 300,
        },
      ],
    },
    allowedEmails: [],
    identityFilter: null,
    rangeDays: 7,
    nowUnix: NOW,
    localTzOffsetMinutes: 60,
  });
}

async function render(el: React.ReactElement): Promise<HTMLElement> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<QueryClientProvider client={qc}>{el}</QueryClientProvider>);
  });
  // Let React Query settle resolved fetches and re-render.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return host;
}

describe("WorkLogDayList", () => {
  it("shows counts and keeps empty days visible", async () => {
    const v = view();
    const host = await render(
      <WorkLogDayList days={v.days} olderCount={0} selected={v.days[0].key} onSelect={() => {}} />
    );
    const rows = host.querySelectorAll("[data-testid^='wl-day-']");
    expect(rows.length).toBe(7);
    expect(rows[0].textContent).toContain("2 commits, 1 repo");
    expect(rows[1].textContent).toContain("no activity");
  });
});

describe("WorkLogDayDetail", () => {
  it("renders uncommitted above commits, commits newest first", async () => {
    const v = view();
    const host = await render(
      <WorkLogDayDetail
        day={v.days[0]}
        older={null}
        sweepErrors={[]}
        selection={null}
        onSelect={() => {}}
      />
    );
    const text = host.textContent ?? "";
    const iUncommitted = text.indexOf("uncommitted");
    const iLate = text.indexOf("late work");
    const iEarly = text.indexOf("early work");
    expect(iUncommitted).toBeGreaterThanOrEqual(0);
    expect(iLate).toBeGreaterThan(iUncommitted);
    expect(iEarly).toBeGreaterThan(iLate);
  });

  it("collapses uncommitted files by default and expands on click", async () => {
    const v = view();
    const host = await render(
      <WorkLogDayDetail
        day={v.days[0]}
        older={null}
        sweepErrors={[]}
        selection={null}
        onSelect={() => {}}
      />
    );
    expect(host.textContent).toContain("1 file");
    expect(host.textContent).not.toContain("wip.txt");
    const toggle = host.querySelector("[data-testid='wl-uncommitted-toggle']") as HTMLElement;
    await act(async () => {
      toggle.click();
    });
    expect(host.textContent).toContain("wip.txt");
  });

  it("timeline and file rows carry the app hover and selection classes", async () => {
    const v = view();
    const host = await render(
      <WorkLogDayDetail
        day={v.days[0]}
        older={null}
        sweepErrors={[]}
        selection={{ kind: "working", repoId: "r1", path: "wip.txt", oldPath: null }}
        onSelect={() => {}}
      />
    );
    expect(host.querySelectorAll(".legit-commit-row").length).toBe(3);
    const toggle = host.querySelector("[data-testid='wl-uncommitted-toggle']") as HTMLElement;
    await act(async () => {
      toggle.click();
    });
    expect(host.querySelectorAll(".legit-commit-row").length).toBe(4);
    expect(host.querySelectorAll(".legit-commit-row--selected").length).toBe(1);
  });

  it("labels multi-worktree uncommitted rows with the tab name, not the id", async () => {
    const group: RepoGroup = {
      key: "/r/.git",
      name: "repo",
      repoIds: ["a1b2c3", "d4e5f6"],
      primaryRepoId: "a1b2c3",
    };
    const v = buildWorkLog({
      groups: [group],
      commitsByRepo: {},
      stashesByRepo: {},
      uncommittedByRepo: {
        a1b2c3: [
          {
            repoId: "a1b2c3",
            repoName: "repo main",
            path: "x.txt",
            oldPath: null,
            state: "Modified",
            staged: false,
            mtimeUnix: NOW - 60,
          },
        ],
      },
      allowedEmails: [],
      identityFilter: null,
      rangeDays: 7,
      nowUnix: NOW,
      localTzOffsetMinutes: 60,
    });
    const host = await render(
      <WorkLogDayDetail day={v.days[0]} older={null} sweepErrors={[]} selection={null} onSelect={() => {}} />
    );
    const toggle = host.querySelector("[data-testid='wl-uncommitted-toggle']") as HTMLElement;
    await act(async () => {
      toggle.click();
    });
    expect(host.textContent).toContain("(repo main)");
    expect(host.textContent).not.toContain("a1b2c3");
  });

  it("interleaves stashes chronologically between commits", async () => {
    const stash: StashEntry = {
      index: 0,
      selector: "stash@{0}",
      message: "WIP midday stash",
      stash_sha: "e".repeat(40),
      base_sha: "b".repeat(40),
      author: { name: "A", email: "a@b.com", timestamp: NOW - 5 * 3600, tz_offset_minutes: 60 },
      timestamp: NOW - 5 * 3600,
    };
    const v = buildWorkLog({
      groups: [GROUP],
      commitsByRepo: {
        r1: [
          commit("s-early", "early work", NOW - 10 * 3600),
          commit("s-late", "late work", NOW - 60),
        ],
      },
      stashesByRepo: { r1: [stash] },
      uncommittedByRepo: {},
      allowedEmails: [],
      identityFilter: null,
      rangeDays: 7,
      nowUnix: NOW,
      localTzOffsetMinutes: 60,
    });
    const host = await render(
      <WorkLogDayDetail day={v.days[0]} older={null} sweepErrors={[]} selection={null} onSelect={() => {}} />
    );
    const text = host.textContent ?? "";
    const iLate = text.indexOf("late work");
    const iStash = text.indexOf("WIP midday stash");
    const iEarly = text.indexOf("early work");
    expect(iLate).toBeGreaterThanOrEqual(0);
    expect(iStash).toBeGreaterThan(iLate);
    expect(iEarly).toBeGreaterThan(iStash);
  });
});

describe("OlderDetail", () => {
  it("renders per-repo blocks with collapsed files that expand on click", async () => {
    const group: RepoGroup = {
      key: "/r/.git",
      name: "my-distinct-repo",
      repoIds: ["r1"],
      primaryRepoId: "r1",
    };
    const host = await render(
      <WorkLogDayDetail
        day={null}
        older={{
          blocks: [
            {
              group,
              rows: [
                {
                  repoId: "r1",
                  repoName: "my-distinct-repo",
                  path: "a.txt",
                  oldPath: null,
                  state: "Modified",
                  staged: false,
                  mtimeUnix: NOW - 90 * 86400,
                },
              ],
            },
          ],
        }}
        sweepErrors={[]}
        selection={null}
        onSelect={() => {}}
      />
    );
    expect(host.textContent).toContain("my-distinct-repo");
    expect(host.textContent).not.toContain("a.txt");
    const toggle = host.querySelector("[data-testid='wl-uncommitted-toggle']") as HTMLElement;
    await act(async () => {
      toggle.click();
    });
    expect(host.textContent).toContain("a.txt");
    expect(host.textContent).toContain("2026-08-15");
  });
});

describe("WorkLogWindowBody", () => {
  it("shows the no-repos empty state", async () => {
    const host = await render(<WorkLogWindowBody />);
    expect(host.textContent).toContain("Open a repository");
  });
});
