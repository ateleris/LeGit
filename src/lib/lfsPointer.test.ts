import { describe, expect, it } from "vitest";
import { lfsPointerDiffSides, parseLfsPointer } from "./lfsPointer";
import type { DiffHunk, DiffLine } from "./types";

// Real pointer committed in the LeGit-Test-LFS fixture repo.
const POINTER =
  "version https://git-lfs.github.com/spec/v1\n" +
  "oid sha256:c414cd0e204de974f73753c7e28d7638e7b3691bb8b1a2bab6b25bb7fed7ce77\n" +
  "size 70";
const POINTER_B =
  "version https://git-lfs.github.com/spec/v1\n" +
  "oid sha256:10fc3c51a152e90e5b90319b601d92ccf37290ef53c35ff92507687d8a911a08\n" +
  "size 2048";

describe("parseLfsPointer", () => {
  it("parses a real pointer", () => {
    expect(parseLfsPointer(POINTER)).toEqual({
      oid: "c414cd0e204de974f73753c7e28d7638e7b3691bb8b1a2bab6b25bb7fed7ce77",
      size: 70,
    });
  });
  it("tolerates a trailing newline", () => {
    expect(parseLfsPointer(POINTER + "\n")).not.toBeNull();
  });
  it("tolerates extra key-value lines (pointer extensions)", () => {
    const ext = POINTER.replace(
      "oid sha256:",
      "ext-0-foo sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\noid sha256:",
    );
    expect(parseLfsPointer(ext)).not.toBeNull();
  });
  it("rejects a near-miss version line", () => {
    expect(parseLfsPointer(POINTER.replace("git-lfs.github.com", "example.com"))).toBeNull();
  });
  it("rejects a malformed oid", () => {
    expect(parseLfsPointer(POINTER.replace("c414", "ZZZZ"))).toBeNull();
    expect(parseLfsPointer(POINTER.replace("sha256:", "md5:"))).toBeNull();
  });
  it("rejects a missing or malformed size", () => {
    expect(parseLfsPointer(POINTER.replace("size 70", ""))).toBeNull();
    expect(parseLfsPointer(POINTER.replace("size 70", "size seventy"))).toBeNull();
  });
  it("rejects oversized input (spec caps pointers below 1024 bytes)", () => {
    expect(parseLfsPointer(POINTER + "\n" + "x ".repeat(600))).toBeNull();
  });
  it("rejects ordinary text and empty input", () => {
    expect(parseLfsPointer("fn main() {}\n")).toBeNull();
    expect(parseLfsPointer("")).toBeNull();
    // A line that is not `key value` shaped disqualifies the whole blob.
    expect(parseLfsPointer(POINTER + "\nnot-a-key-value-line")).toBeNull();
  });
});

// -- diff-side reconstruction ------------------------------------------------

const line = (kind: DiffLine["kind"], content: string): DiffLine => ({ kind, content });
const hunk = (lines: DiffLine[]): DiffHunk => ({
  old_start: 1,
  old_lines: 0,
  new_start: 1,
  new_lines: 0,
  header: "@@ -1 +1 @@",
  lines,
});
const toLines = (text: string, kind: DiffLine["kind"]): DiffLine[] =>
  text.split("\n").map((c) => line(kind, c));

describe("lfsPointerDiffSides", () => {
  it("detects a pointer-to-pointer change", () => {
    const h = hunk([...toLines(POINTER, "Removed"), ...toLines(POINTER_B, "Added")]);
    const sides = lfsPointerDiffSides([h]);
    expect(sides?.oldInfo?.size).toBe(70);
    expect(sides?.newInfo?.size).toBe(2048);
  });
  it("detects an added LFS file (old side empty)", () => {
    const sides = lfsPointerDiffSides([hunk(toLines(POINTER, "Added"))]);
    expect(sides?.oldInfo).toBeNull();
    expect(sides?.newInfo?.oid).toMatch(/^c414/);
  });
  it("detects a deleted LFS file (new side empty)", () => {
    const sides = lfsPointerDiffSides([hunk(toLines(POINTER, "Removed"))]);
    expect(sides?.oldInfo?.size).toBe(70);
    expect(sides?.newInfo).toBeNull();
  });
  it("keeps a normal diff for an LFS-to-text conversion", () => {
    const h = hunk([...toLines(POINTER, "Removed"), ...toLines("real file\ncontent", "Added")]);
    expect(lfsPointerDiffSides([h])).toBeNull();
  });
  it("returns null for an ordinary text diff", () => {
    const h = hunk([line("Context", "a"), line("Removed", "b"), line("Added", "c")]);
    expect(lfsPointerDiffSides([h])).toBeNull();
  });
  it("returns null for empty hunks", () => {
    expect(lfsPointerDiffSides([])).toBeNull();
  });
});
