import { describe, expect, it } from "vitest";
import { findConflicts } from "./conflicts";
import type { Keymap } from "./keymap";
import type { Command } from "./registry";

const noop = () => {};
const cmd = (id: string, scope: Command["scope"]): Command => ({
  id,
  title: id,
  scope,
  defaultBinding: [],
  run: noop,
});

const COMMANDS = [
  cmd("global.a", "global"),
  cmd("global.b", "global"),
  cmd("repo.a", "repo"),
  cmd("panel.a", "panel:log"),
];

const keymap: Keymap = {
  "global.a": ["Mod+K"],
  "global.b": ["Mod+K", "F6"],
  "repo.a": ["Mod+K"],
  "panel.a": ["F6"],
};

describe("findConflicts", () => {
  it("same scope + same chord is a hard conflict", () => {
    const c = findConflicts("Mod+K", "global.a", COMMANDS, keymap);
    expect(c.hard.map((x) => x.id)).toEqual(["global.b"]);
  });

  it("different scope + same chord is legal shadowing, reported as a hint", () => {
    const c = findConflicts("Mod+K", "global.a", COMMANDS, keymap);
    expect(c.shadows.map((x) => x.id)).toEqual(["repo.a"]);
  });

  it("the command itself is never its own conflict", () => {
    const c = findConflicts("F6", "global.b", COMMANDS, keymap);
    expect(c.hard).toEqual([]);
    expect(c.shadows.map((x) => x.id)).toEqual(["panel.a"]);
  });

  it("an unused chord has no conflicts", () => {
    const c = findConflicts("F9", "global.a", COMMANDS, keymap);
    expect(c.hard).toEqual([]);
    expect(c.shadows).toEqual([]);
  });
});
