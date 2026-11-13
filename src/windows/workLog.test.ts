import { describe, expect, test } from "vitest";
import type { StashEntry, WorkLogCommit } from "../lib/bindings";
import {
  buildWorkLog,
  collectSweepErrors,
  dayKeyFor,
  dayLabel,
  groupRepoTabs,
  shortRef,
  timeOfInOffset,
  type RepoGroup,
  type WorkLogUncommittedInput,
} from "./workLog";

// 2026-11-12T22:30:00Z - late evening UTC, so a +02:00 author is already on
// Nov 13 while UTC (and a +00:00 author) is still on Nov 12.
const NOW = 1794522600;
const LOCAL_TZ = 60; // app-local +01:00 -> "today" is 2026-11-12

function commit(over: Partial<WorkLogCommit> & { sha: string }): WorkLogCommit {
  return {
    id: over.sha,
    author: {
      name: "Alice",
      email: over.author?.email ?? "a@b.com",
      timestamp: over.author?.timestamp ?? NOW - 3600,
      tz_offset_minutes: over.author?.tz_offset_minutes ?? 60,
    },
    subject: over.subject ?? "subject",
    source_ref: over.source_ref ?? "refs/heads/dev",
  };
}

function stash(sha: string, ts: number): StashEntry {
  return {
    index: 0,
    selector: "stash@{0}",
    message: "WIP on dev: x",
    stash_sha: sha,
    base_sha: "b".repeat(40),
    author: { name: "Alice", email: "a@b.com", timestamp: ts, tz_offset_minutes: 60 },
    timestamp: ts,
  };
}

function uncommitted(
  repoId: string,
  path: string,
  over: Partial<WorkLogUncommittedInput> = {}
): WorkLogUncommittedInput {
  return {
    repoId,
    repoName: over.repoName ?? `${repoId}-name`,
    path,
    oldPath: over.oldPath ?? null,
    state: over.state ?? "Modified",
    staged: over.staged ?? false,
    mtimeUnix: "mtimeUnix" in over ? (over.mtimeUnix ?? null) : NOW - 600,
  };
}

const GROUP_A: RepoGroup = { key: "/a/.git", name: "alpha", repoIds: ["ra"], primaryRepoId: "ra" };

function build(over: Partial<Parameters<typeof buildWorkLog>[0]> = {}) {
  return buildWorkLog({
    groups: [GROUP_A],
    commitsByRepo: {},
    stashesByRepo: {},
    uncommittedByRepo: {},
    allowedEmails: ["a@b.com"],
    identityFilter: null,
    rangeDays: 7,
    nowUnix: NOW,
    localTzOffsetMinutes: LOCAL_TZ,
    ...over,
  });
}

describe("dayKeyFor", () => {
  test("dayKeyFor_uses_author_offset", () => {
    expect(dayKeyFor(1794522600, 120)).toBe("2026-11-13");
    expect(dayKeyFor(1794522600, 0)).toBe("2026-11-12");
  });

  test("dayLabel_is_weekday_plus_iso_date", () => {
    expect(dayLabel("2026-11-12")).toBe("Thu 2026-11-12");
  });

  test("timeOfInOffset_renders_the_authors_clock", () => {
    // 2026-11-12T22:30:00Z is 00:30 next day at +02:00, 22:30 at UTC.
    expect(timeOfInOffset(NOW, 120)).toBe("00:30");
    expect(timeOfInOffset(NOW, 0)).toBe("22:30");
  });
});

describe("collectSweepErrors", () => {
  test("labels_errors_per_repo_and_kind", () => {
    const repos = [
      { id: "ra", name: "alpha" },
      { id: "rb", name: "beta" },
    ];
    const ok = { isError: false, error: null };
    const boom = { isError: true, error: "boom" };
    const out = collectSweepErrors(
      repos,
      [
        { label: "sweep", queries: [ok, boom] },
        { label: "stashes", queries: [boom, ok] },
        { label: "uncommitted", queries: [ok, ok] },
      ],
      (e) => String(e)
    );
    expect(out).toEqual([
      { name: "alpha", message: "stashes: boom" },
      { name: "beta", message: "sweep: boom" },
    ]);
  });
});

describe("shortRef", () => {
  test("strips_the_heads_prefix_only", () => {
    expect(shortRef("refs/heads/feature/x")).toBe("feature/x");
    expect(shortRef("HEAD")).toBe("HEAD");
    expect(shortRef(null)).toBe(null);
  });
});

describe("groupRepoTabs", () => {
  test("worktree_tabs_merge_by_common_dir", () => {
    const groups = groupRepoTabs([
      { repoId: "r1", name: "repo", commonDir: "/repo/.git" },
      { repoId: "r2", name: "repo-wt", commonDir: "/repo/.git" },
      { repoId: "r3", name: "other", commonDir: "/other/.git" },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toEqual({
      key: "/repo/.git",
      name: "repo",
      repoIds: ["r1", "r2"],
      primaryRepoId: "r1",
    });
  });
});

describe("buildWorkLog", () => {
  test("empty_allowed_emails_shows_everything", () => {
    const view = build({
      allowedEmails: [],
      commitsByRepo: { ra: [commit({ sha: "s1", author: { email: "stranger@x.y" } as never })] },
    });
    expect(view.days[0].repoBlocks[0]?.commits).toHaveLength(1);
  });

  test("identity_filter_hides_other_emails_but_keeps_uncommitted_and_stashes", () => {
    const view = build({
      allowedEmails: ["a@b.com", "other@b.com"],
      identityFilter: "other@b.com",
      commitsByRepo: {
        ra: [
          commit({ sha: "s1" }), // a@b.com - filtered out
          commit({ sha: "s2", author: { email: "Other@B.com" } as never }),
        ],
      },
      stashesByRepo: { ra: [stash("c".repeat(40), NOW - 1800)] },
      uncommittedByRepo: { ra: [uncommitted("ra", "f.txt")] },
    });
    const block = view.days[0].repoBlocks[0];
    expect(block.commits.map((c) => c.id)).toEqual(["s2"]);
    expect(block.stashes).toHaveLength(1);
    expect(block.uncommitted).toHaveLength(1);
  });

  test("worktree_tabs_merge_and_commits_dedupe", () => {
    const group: RepoGroup = {
      key: "/r/.git",
      name: "repo",
      repoIds: ["r1", "r2"],
      primaryRepoId: "r1",
    };
    const same = commit({ sha: "dup" });
    const view = build({
      groups: [group],
      commitsByRepo: { r1: [same], r2: [same] },
      uncommittedByRepo: {
        r1: [uncommitted("r1", "x.txt")],
        r2: [uncommitted("r2", "y.txt")],
      },
    });
    const block = view.days[0].repoBlocks[0];
    expect(block.commits).toHaveLength(1);
    expect(block.uncommitted.map((u) => `${u.repoId}:${u.path}`).sort()).toEqual([
      "r1:x.txt",
      "r2:y.txt",
    ]);
  });

  test("staged_and_unstaged_pair_merges_to_one_row", () => {
    const view = build({
      uncommittedByRepo: {
        ra: [
          uncommitted("ra", "f.txt", { staged: true, state: "Added" }),
          uncommitted("ra", "f.txt", { staged: false, state: "Modified" }),
        ],
      },
    });
    const rows = view.days[0].repoBlocks[0].uncommitted;
    expect(rows).toHaveLength(1);
    expect(rows[0].staged).toBe(true);
    expect(rows[0].state).toBe("Modified");
  });

  test("merged_pair_keeps_the_rename_source", () => {
    const view = build({
      uncommittedByRepo: {
        ra: [
          uncommitted("ra", "new.txt", { staged: true, state: "Renamed", oldPath: "old.txt" }),
          uncommitted("ra", "new.txt", { staged: false, state: "Modified" }),
        ],
      },
    });
    expect(view.days[0].repoBlocks[0].uncommitted[0].oldPath).toBe("old.txt");
  });

  test("old_unknown_and_deleted_mtimes_land_in_older", () => {
    const view = build({
      uncommittedByRepo: {
        ra: [
          uncommitted("ra", "ancient.txt", { mtimeUnix: NOW - 60 * 86400 }),
          uncommitted("ra", "unknown.txt", { mtimeUnix: null }),
          uncommitted("ra", "gone.txt", { state: "Deleted", mtimeUnix: null }),
        ],
      },
    });
    expect(view.older.blocks).toHaveLength(1);
    expect(view.older.blocks[0].group.key).toBe(GROUP_A.key);
    expect(view.older.blocks[0].rows.map((r) => r.path).sort()).toEqual([
      "ancient.txt",
      "gone.txt",
      "unknown.txt",
    ]);
    const allDayRows = view.days.flatMap((d) => d.repoBlocks.flatMap((b) => b.uncommitted));
    expect(allDayRows).toHaveLength(0);
  });

  test("older_blocks_follow_group_order_rows_newest_first", () => {
    const groupB: RepoGroup = { key: "/b/.git", name: "beta", repoIds: ["rb"], primaryRepoId: "rb" };
    const view = build({
      groups: [GROUP_A, groupB],
      uncommittedByRepo: {
        ra: [
          uncommitted("ra", "unknown.txt", { mtimeUnix: null }),
          uncommitted("ra", "oldest.txt", { mtimeUnix: NOW - 90 * 86400 }),
        ],
        rb: [uncommitted("rb", "newer.txt", { mtimeUnix: NOW - 30 * 86400 })],
      },
    });
    expect(view.older.blocks.map((b) => b.group.key)).toEqual([GROUP_A.key, "/b/.git"]);
    expect(view.older.blocks[0].rows.map((r) => r.path)).toEqual(["oldest.txt", "unknown.txt"]);
    expect(view.older.blocks[1].rows.map((r) => r.path)).toEqual(["newer.txt"]);
  });

  test("future_mtime_clamps_to_newest_day", () => {
    const view = build({
      uncommittedByRepo: { ra: [uncommitted("ra", "tomorrow.txt", { mtimeUnix: NOW + 2 * 86400 })] },
    });
    expect(view.days[0].repoBlocks[0].uncommitted.map((u) => u.path)).toEqual(["tomorrow.txt"]);
  });

  test("days_include_empty_and_stash_only_days_count", () => {
    const twoDaysAgo = NOW - 2 * 86400;
    const view = build({ stashesByRepo: { ra: [stash("d".repeat(40), twoDaysAgo)] } });
    expect(view.days).toHaveLength(7);
    expect(view.days[0].key).toBe("2026-11-12");
    expect(view.days[6].key).toBe("2026-11-06");
    const stashDay = view.days.find((d) => d.repoBlocks.length > 0);
    expect(stashDay?.counts.repos).toBe(1);
    expect(stashDay?.counts.commits).toBe(0);
    // Empty days remain in the list.
    expect(view.days.filter((d) => d.repoBlocks.length === 0)).toHaveLength(6);
  });

  test("commits_sorted_newest_first_and_span_is_min_max", () => {
    const t0 = NOW - 10 * 3600; // same local day (12:30 local)
    const view = build({
      commitsByRepo: {
        ra: [
          commit({ sha: "early", author: { email: "a@b.com", timestamp: t0 } as never }),
          commit({ sha: "late", author: { email: "a@b.com", timestamp: NOW - 60 } as never }),
        ],
      },
    });
    const block = view.days[0].repoBlocks[0];
    expect(block.commits.map((c) => c.id)).toEqual(["late", "early"]);
    expect(block.span).toEqual({ first: t0, last: NOW - 60 });
  });

  test("distinct_matched_emails_are_listed_case_insensitively", () => {
    const view = build({
      allowedEmails: ["a@b.com", "other@b.com"],
      commitsByRepo: {
        ra: [
          commit({ sha: "s1" }),
          commit({ sha: "s2", author: { email: "Other@B.com" } as never }),
          commit({ sha: "s3", author: { email: "other@b.com" } as never }),
        ],
      },
    });
    expect(view.emails.map((e) => e.toLowerCase()).sort()).toEqual(["a@b.com", "other@b.com"]);
    expect(view.emails).toHaveLength(2);
  });
});
