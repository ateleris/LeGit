import { describe, expect, it } from "vitest";
import { applyCommandAliases, parseKeybindingsImport } from "./persistence";

describe("applyCommandAliases", () => {
  const ALIASES = { "old.fetch": "repo.fetch", "old.pull": "repo.pull" };

  it("renames aliased ids in a loaded diff", () => {
    expect(applyCommandAliases({ "old.fetch": ["F6"] }, ALIASES)).toEqual({
      "repo.fetch": ["F6"],
    });
  });

  it("keeps non-aliased ids untouched, including unknown ones", () => {
    const diff = { "repo.push": ["F7"], "future.command": ["F9"] };
    expect(applyCommandAliases(diff, ALIASES)).toEqual(diff);
  });

  it("an existing entry under the new id wins over the aliased old one", () => {
    expect(
      applyCommandAliases({ "old.fetch": ["F6"], "repo.fetch": ["F8"] }, ALIASES),
    ).toEqual({ "repo.fetch": ["F8"] });
  });

  it("preserves explicit unbinds through a rename", () => {
    expect(applyCommandAliases({ "old.pull": [] }, ALIASES)).toEqual({ "repo.pull": [] });
  });
});

describe("parseKeybindingsImport", () => {
  const doc = (bindings: unknown, version = 1) => JSON.stringify({ version, bindings });

  it("accepts a valid file and normalizes chords to canonical form", () => {
    const r = parseKeybindingsImport(doc({ "repo.fetch": ["shift+mod+f"], "repo.pull": [] }));
    expect(r).toEqual({ ok: true, diff: { "repo.fetch": ["Mod+Shift+F"], "repo.pull": [] } });
  });

  it("keeps unknown command ids", () => {
    const r = parseKeybindingsImport(doc({ "future.command": ["F9"] }));
    expect(r.ok && r.diff["future.command"]).toEqual(["F9"]);
  });

  it("rejects malformed JSON, wrong shapes, and newer versions", () => {
    expect(parseKeybindingsImport("{ not json").ok).toBe(false);
    expect(parseKeybindingsImport(JSON.stringify([1, 2])).ok).toBe(false);
    expect(parseKeybindingsImport(doc("nope")).ok).toBe(false);
    expect(parseKeybindingsImport(doc({ "repo.fetch": "F6" })).ok).toBe(false);
    expect(parseKeybindingsImport(doc({ "repo.fetch": [5] })).ok).toBe(false);
    expect(parseKeybindingsImport(doc({}, 99)).ok).toBe(false);
  });

  it("rejects unparseable chords, naming the offender", () => {
    const r = parseKeybindingsImport(doc({ "repo.fetch": ["Bogus+Chord"] }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/repo\.fetch/);
  });
});
