import { describe, expect, it } from "vitest";
import { cloneCancelCleanupFailure, formatAppError, gitErrorKind } from "./types";

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

  // `GitError::UnsafeArgument` (a ref name that looks like a git option, e.g.
  // a cloned tag called `--exec=...`) carries the whole explanation as its
  // string payload - the user must see that sentence, not the variant name.
  it("shows the refusal message for an option-like ref", () => {
    const e = {
      kind: "Git",
      details: {
        kind: "UnsafeArgument",
        details:
          'Refusing to run git with an option-like branch: "--exec=cmd". ' +
          "A name starting with '-' would be interpreted as a command-line option.",
      },
    };
    expect(formatAppError(e)).toContain("Refusing to run git with an option-like branch");
    expect(gitErrorKind(e)).toBe("UnsafeArgument");
  });

  it("labels unit GitError variants readably", () => {
    expect(formatAppError({ kind: "Git", details: { kind: "RewordNotHead" } })).toBe(
      "Only the latest commit (HEAD) can be reworded.",
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

// A cancelled clone is an expected outcome the UI stays silent about - EXCEPT
// when removing the partial clone's files failed: that note must reach the
// user (a failed best-effort cleanup is never silent).
describe("cloneCancelCleanupFailure", () => {
  it("returns the note when the cancelled clone's cleanup failed", () => {
    const e = {
      kind: "Git",
      details: {
        kind: "CloneCancelled",
        details: { cleanup_failed: "The partial clone at 'C:\\x\\repo' could not be removed: ..." },
      },
    };
    expect(cloneCancelCleanupFailure(e)).toBe(
      "The partial clone at 'C:\\x\\repo' could not be removed: ...",
    );
  });

  it("returns null when cleanup succeeded", () => {
    const e = {
      kind: "Git",
      details: { kind: "CloneCancelled", details: { cleanup_failed: null } },
    };
    expect(cloneCancelCleanupFailure(e)).toBeNull();
  });

  it("returns null for any other error", () => {
    expect(
      cloneCancelCleanupFailure({
        kind: "Git",
        details: { kind: "AuthFailed", details: "denied" },
      }),
    ).toBeNull();
    expect(cloneCancelCleanupFailure(new Error("x"))).toBeNull();
  });
});

describe("formatAppError: LFS download failures", () => {
  it("shows the friendly cause instead of raw stderr", () => {
    const e = {
      kind: "Git",
      details: {
        kind: "LfsDownloadFailed",
        details: { files: ["big.bin"], missing_on_remote: true, stderr: "404 noise" },
      },
    };
    const m = formatAppError(e);
    expect(m).toContain("big.bin");
    expect(m).toContain("git lfs push");
    expect(m).not.toContain("404 noise");
  });
});
