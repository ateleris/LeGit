import { describe, it, expect } from "vitest";
import { gitErrorDetails, gitErrorKind } from "./errors";
import type { AppError } from "./types";

const worktree: AppError = {
  kind: "Git",
  details: {
    kind: "CheckedOutInWorktree",
    details: { branch: "feature", path: "/wt", stderr: "fatal: in use" },
  },
};

describe("gitErrorKind", () => {
  it("returns the inner git error kind", () => {
    expect(gitErrorKind(worktree)).toBe("CheckedOutInWorktree");
  });

  it("is null for non-git errors and non-errors", () => {
    expect(gitErrorKind({ kind: "Io", details: "disk full" })).toBeNull();
    expect(gitErrorKind(new Error("x"))).toBeNull();
    expect(gitErrorKind(null)).toBeNull();
  });
});

describe("gitErrorDetails", () => {
  it("returns the payload typed for the requested kind", () => {
    const d = gitErrorDetails(worktree, "CheckedOutInWorktree");
    expect(d?.path).toBe("/wt");
    expect(d?.branch).toBe("feature");
  });

  it("is null when the error is a different kind", () => {
    expect(gitErrorDetails(worktree, "BranchNotFullyMerged")).toBeNull();
    expect(gitErrorDetails({ kind: "Io", details: "x" }, "AuthFailed")).toBeNull();
  });

  it("rejects unknown kinds and payload-less kinds at compile time", () => {
    // @ts-expect-error not a GitError kind
    gitErrorDetails(worktree, "CheckedOutInWorkTree");
    // @ts-expect-error RewordNotHead carries no details
    gitErrorDetails(worktree, "RewordNotHead");
    // @ts-expect-error the comparison is checked against the kind union
    expect(gitErrorKind(worktree) === "AuthFaild").toBe(false);
  });
});
