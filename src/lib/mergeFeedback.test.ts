// The user-facing half of the tested Rust merge/rebase/sequencer classifiers:
// every outcome variant must map to guidance with no silent fall-through.

import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  notifyMergeOutcome,
  notifyRebaseOutcome,
  notifySequenceOutcome,
  notifyOpError,
  notifyResolutionInvisible,
} from "./mergeFeedback";
import { notify } from "../store/notifications";
import { repoStatus } from "./commands";
import type { MergeOutcome, RebaseOutcome, SequenceOutcome } from "./types";

vi.mock("../store/notifications", () => ({
  notify: { info: vi.fn(), error: vi.fn(), success: vi.fn() },
}));
vi.mock("./commands", () => ({
  repoStatus: vi.fn(),
}));

const lastInfo = () =>
  vi.mocked(notify.info).mock.calls.at(-1)?.[0] as string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("notifyMergeOutcome", () => {
  const cases: Array<[MergeOutcome["kind"], string]> = [
    ["fast_forwarded", "Fast-forwarded"],
    ["merged", "Merged"],
    ["squashed", "staged"],
    ["already_up_to_date", "Already up to date"],
    ["conflicts", "conflicts"],
  ];
  test.each(cases)("%s → message mentions %s", (kind, phrase) => {
    notifyMergeOutcome({ kind } as MergeOutcome, "feature");
    expect(lastInfo()).toContain(phrase);
  });
});

describe("notifyRebaseOutcome", () => {
  const cases: Array<[RebaseOutcome["kind"], string]> = [
    ["completed", "Rebased onto"],
    ["already_up_to_date", "Already up to date"],
    ["conflicts", "conflicts"],
    ["completed_with_stash_conflicts", "kept"],
  ];
  test.each(cases)("%s → message mentions %s", (kind, phrase) => {
    notifyRebaseOutcome({ kind } as RebaseOutcome, "main");
    expect(lastInfo()).toContain(phrase);
  });
});

describe("notifySequenceOutcome", () => {
  test("completed uses the right verb", () => {
    notifySequenceOutcome({ kind: "completed" } as SequenceOutcome, "cherry-pick", "abc123");
    expect(lastInfo()).toContain("Cherry-picked abc123");
    notifySequenceOutcome({ kind: "completed" } as SequenceOutcome, "revert", "abc123");
    expect(lastInfo()).toContain("Reverted abc123");
  });
  test("conflicts offer Continue / Skip / Abort", () => {
    notifySequenceOutcome(
      { kind: "conflicts", message: "x" } as SequenceOutcome,
      "revert",
      "abc123",
    );
    const msg = lastInfo()!;
    expect(msg).toContain("Continue");
    expect(msg).toContain("Skip");
    expect(msg).toContain("Abort");
  });
});

describe("notifyOpError", () => {
  test("dirty-tree refusal gets the specific message", () => {
    notifyOpError({
      kind: "Git",
      details: { kind: "WouldOverwriteLocalChanges", details: "a.txt" },
    });
    expect(vi.mocked(notify.error).mock.calls[0][0]).toContain(
      "overwrite uncommitted changes",
    );
  });
  test("other errors show git's message", () => {
    notifyOpError({
      kind: "Git",
      details: { kind: "CommandFailed", details: { exit_code: 1, stderr: "fatal: x" } },
    });
    expect(notify.error).toHaveBeenCalledWith("fatal: x");
  });
});

describe("notifyResolutionInvisible", () => {
  test("notes the invisible resolution when the file left the status", async () => {
    vi.mocked(repoStatus).mockResolvedValue([]);
    await notifyResolutionInvisible("r1", "a.txt");
    expect(lastInfo()).toContain("won't appear as a change");
  });
  test("stays silent while the file still shows", async () => {
    vi.mocked(repoStatus).mockResolvedValue([
      { path: "a.txt" } as never,
    ]);
    await notifyResolutionInvisible("r1", "a.txt");
    expect(notify.info).not.toHaveBeenCalled();
  });
  test("a status failure never throws (best-effort note)", async () => {
    vi.mocked(repoStatus).mockRejectedValue(new Error("boom"));
    await expect(notifyResolutionInvisible("r1", "a.txt")).resolves.toBeUndefined();
    expect(notify.info).not.toHaveBeenCalled();
  });
});
