// Unit tests for the Git Log store: command entries and watcher-batch entries
// share one ring buffer and are distinguishable by `kind`.

import { describe, test, expect, beforeEach } from "vitest";
import { useGitLogStore } from "./gitLog";
import type { GitInvocation, RepoChangedPayload } from "../lib/types";

const inv = (args: string[]): GitInvocation => ({
  args,
  cwd: "C:\\repo",
  exit_code: 0,
  success: true,
  duration_ms: 5,
  stderr: "",
});

const batch = (over?: Partial<RepoChangedPayload>): RepoChangedPayload => ({
  repo_id: "r1",
  domains: ["log", "branches", "tags"],
  trigger_paths: [".git/packed-refs"],
  trigger_count: 1,
  ...over,
});

beforeEach(() => {
  useGitLogStore.getState().clear();
});

describe("useGitLogStore", () => {
  test("command and watcher entries interleave in arrival order", () => {
    const s = useGitLogStore.getState();
    s.addWatcherBatch(batch());
    s.add(inv(["log", "--max-count=500"]));

    const entries = useGitLogStore.getState().entries;
    expect(entries.map((e) => e.kind)).toEqual(["watcher", "command"]);
  });

  test("watcher entry carries repo id, domains, and trigger paths", () => {
    useGitLogStore.getState().addWatcherBatch(
      batch({ trigger_paths: [".git/refs/tags/v1"], trigger_count: 3 })
    );

    const e = useGitLogStore.getState().entries[0];
    expect(e.kind).toBe("watcher");
    if (e.kind === "watcher") {
      expect(e.repo_id).toBe("r1");
      expect(e.domains).toEqual(["log", "branches", "tags"]);
      expect(e.trigger_paths).toEqual([".git/refs/tags/v1"]);
      expect(e.trigger_count).toBe(3);
    }
  });

  test("ring buffer caps mixed entries at 500", () => {
    const s = useGitLogStore.getState();
    for (let i = 0; i < 300; i++) s.add(inv([`status-${i}`]));
    for (let i = 0; i < 300; i++) s.addWatcherBatch(batch());

    const entries = useGitLogStore.getState().entries;
    expect(entries.length).toBe(500);
    // Oldest command entries were evicted first.
    expect(entries[0].kind).toBe("command");
    if (entries[0].kind === "command") {
      expect(entries[0].args).toEqual(["status-100"]);
    }
  });
});
