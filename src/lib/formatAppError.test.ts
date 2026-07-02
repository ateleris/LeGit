import { describe, expect, it } from "vitest";
import { formatAppError, gitErrorKind } from "./types";

// Regression tests for error display: nested GitErrors must surface git's own
// message, never the serialized JSON envelope
// (`Git: {"kind":"CommandFailed","details":{...}}`).

describe("formatAppError", () => {
  it("shows stderr for a nested CommandFailed instead of JSON", () => {
    const e = {
      kind: "Git",
      details: {
        kind: "CommandFailed",
        details: { exit_code: 1, stderr: "error: Your local changes would be overwritten" },
      },
    };
    expect(formatAppError(e)).toBe("error: Your local changes would be overwritten");
  });

  it("shows the message for string-payload GitErrors", () => {
    const e = {
      kind: "Git",
      details: { kind: "WouldOverwriteLocalChanges", details: "local changes in f.txt" },
    };
    expect(formatAppError(e)).toBe("local changes in f.txt");
  });

  it("labels unit GitError variants readably", () => {
    expect(formatAppError({ kind: "Git", details: { kind: "Cancelled" } })).toBe(
      "Operation cancelled.",
    );
  });

  it("keeps plain AppError variants as before", () => {
    expect(formatAppError({ kind: "UnknownRepo", details: "abc" })).toBe("UnknownRepo: abc");
  });

  it("passes through Error objects and strings", () => {
    expect(formatAppError(new Error("boom"))).toBe("boom");
    expect(formatAppError("plain")).toBe("plain");
  });
});

describe("gitErrorKind", () => {
  it("extracts the nested kind for UI dispatch", () => {
    const e = {
      kind: "Git",
      details: { kind: "WouldOverwriteLocalChanges", details: "..." },
    };
    expect(gitErrorKind(e)).toBe("WouldOverwriteLocalChanges");
  });

  it("returns null for non-git errors", () => {
    expect(gitErrorKind({ kind: "Io", details: "x" })).toBeNull();
    expect(gitErrorKind(new Error("x"))).toBeNull();
  });
});
