import { describe, it, expect } from "vitest";
import { commitHookRejection, hookNamesLabel } from "./hookWarning";
import type { AppError } from "../../lib/types";

const declined: AppError = {
  kind: "Git",
  details: {
    kind: "CommitHookDeclined",
    details: {
      hooks: ["pre-commit"],
      exit_code: 1,
      stderr: "LINT FAILED: a.ts",
    },
  },
};

describe("commitHookRejection", () => {
  it("extracts hooks and output from a hook-declined commit error", () => {
    expect(commitHookRejection(declined)).toEqual({
      hooks: ["pre-commit"],
      output: "LINT FAILED: a.ts",
    });
  });

  it("is null for other git errors and non-errors", () => {
    const other: AppError = {
      kind: "Git",
      details: { kind: "CommandFailed", details: { exit_code: 1, stderr: "x" } },
    };
    expect(commitHookRejection(other)).toBeNull();
    expect(commitHookRejection(new Error("x"))).toBeNull();
    expect(commitHookRejection(null)).toBeNull();
  });
});

describe("hookNamesLabel", () => {
  it("names one hook", () => {
    expect(hookNamesLabel(["pre-commit"])).toBe("pre-commit hook");
  });

  it("joins two hooks", () => {
    expect(hookNamesLabel(["pre-commit", "commit-msg"])).toBe(
      "pre-commit and commit-msg hooks",
    );
  });
});
