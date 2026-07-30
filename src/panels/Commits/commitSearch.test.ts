import { describe, it, expect } from "vitest";
import { mergeSearchResults, quickSearchMatch } from "./commitSearch";
import type { Commit, RefDecoration } from "../../lib/types";

const row = (message: string, decorations: RefDecoration[] = []) => ({ message, decorations });

const rows = [
  row("fix login bug"),
  row("update docs", [{ type: "branch", value: "docs-branch" }]),
  row("refactor parser", [{ type: "tag", value: "v1.2" }]),
  row("fix logout bug\n\nlong body mentioning docs"),
];

describe("quickSearchMatch", () => {
  it("matches the subject line, case-insensitively", () => {
    expect(quickSearchMatch(rows, "LOGIN", 0, 1)).toBe(0);
    expect(quickSearchMatch(rows, "refactor", 0, 1)).toBe(2);
  });

  it("matches branch and tag decoration names", () => {
    expect(quickSearchMatch(rows, "docs-branch", 0, 1)).toBe(1);
    expect(quickSearchMatch(rows, "v1.2", 0, 1)).toBe(2);
  });

  it("does not match the message body (subject line only)", () => {
    // "mentioning" appears only in row 3's body.
    expect(quickSearchMatch(rows, "mentioning", 0, 1)).toBeNull();
  });

  it("scans forward from the anchor and wraps around", () => {
    // From row 2 forward, "fix" first hits row 3, then wraps to row 0.
    expect(quickSearchMatch(rows, "fix", 2, 1)).toBe(3);
    expect(quickSearchMatch(rows, "fix", 3, 1)).toBe(3); // anchor inclusive
    expect(quickSearchMatch(rows, "fix", 4, 1)).toBe(0); // wraps (and normalizes)
  });

  it("scans backward for direction -1", () => {
    expect(quickSearchMatch(rows, "fix", 2, -1)).toBe(0);
    expect(quickSearchMatch(rows, "fix", -1, -1)).toBe(3); // negative anchor normalizes
  });

  it("returns null for no match, empty query, or empty rows", () => {
    expect(quickSearchMatch(rows, "zzz", 0, 1)).toBeNull();
    expect(quickSearchMatch(rows, "  ", 0, 1)).toBeNull();
    expect(quickSearchMatch([], "fix", 0, 1)).toBeNull();
  });
});

describe("mergeSearchResults", () => {
  const commit = (id: string, timestamp: number): Commit => ({
    id,
    parents: [],
    author: { name: "", email: "", timestamp, tz_offset_minutes: 0 },
    committer: { name: "", email: "", timestamp, tz_offset_minutes: 0 },
    message: id,
    timestamp,
    signature: null,
    has_signature: false,
    decorations: [],
  });

  it("dedupes by id and sorts newest first", () => {
    const a = [commit("aaa", 300), commit("bbb", 100)];
    const b = [commit("ccc", 200), commit("aaa", 300)];
    expect(mergeSearchResults(a, b).map((c) => c.id)).toEqual(["aaa", "ccc", "bbb"]);
  });

  it("breaks timestamp ties deterministically by id", () => {
    const a = [commit("bbb", 100)];
    const b = [commit("aaa", 100)];
    expect(mergeSearchResults(a, b).map((c) => c.id)).toEqual(["aaa", "bbb"]);
    expect(mergeSearchResults(b, a).map((c) => c.id)).toEqual(["aaa", "bbb"]);
  });
});
