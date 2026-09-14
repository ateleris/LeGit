import { beforeEach, describe, expect, it } from "vitest";
import {
  applyKeymapDiff,
  diffFromDefaults,
  reverseIndex,
  useKeymapStore,
  type Keymap,
} from "./keymap";

const DEFAULTS: Keymap = {
  "repo.fetch": ["Mod+Shift+F"],
  "panel.toggleMaximize": ["Mod+Shift+M"],
  "repo.pull": [],
};

describe("applyKeymapDiff", () => {
  it("absent entries inherit the default", () => {
    expect(applyKeymapDiff(DEFAULTS, {})).toEqual(DEFAULTS);
  });

  it("an entry overrides the default", () => {
    const out = applyKeymapDiff(DEFAULTS, { "repo.fetch": ["F6", "Mod+Shift+F"] });
    expect(out["repo.fetch"]).toEqual(["F6", "Mod+Shift+F"]);
    expect(out["panel.toggleMaximize"]).toEqual(["Mod+Shift+M"]);
  });

  it("an empty array means explicitly unbound, not inherit", () => {
    const out = applyKeymapDiff(DEFAULTS, { "repo.fetch": [] });
    expect(out["repo.fetch"]).toEqual([]);
  });

  it("unknown command ids are kept (downgrade/upgrade safety)", () => {
    const out = applyKeymapDiff(DEFAULTS, { "future.command": ["F9"] });
    expect(out["future.command"]).toEqual(["F9"]);
  });
});

describe("diffFromDefaults", () => {
  it("round-trips: apply(diff(effective)) == effective", () => {
    const effective: Keymap = {
      ...DEFAULTS,
      "repo.fetch": [],
      "panel.toggleMaximize": ["F11"],
    };
    const diff = diffFromDefaults(DEFAULTS, effective);
    expect(applyKeymapDiff(DEFAULTS, diff)).toEqual(effective);
  });

  it("stores only changed entries", () => {
    const diff = diffFromDefaults(DEFAULTS, { ...DEFAULTS, "repo.pull": ["F7"] });
    expect(diff).toEqual({ "repo.pull": ["F7"] });
  });

  it("an unchanged keymap produces an empty diff", () => {
    expect(diffFromDefaults(DEFAULTS, { ...DEFAULTS })).toEqual({});
  });

  it("records explicit unbinding as an empty array", () => {
    const diff = diffFromDefaults(DEFAULTS, { ...DEFAULTS, "repo.fetch": [] });
    expect(diff).toEqual({ "repo.fetch": [] });
  });
});

describe("reverseIndex", () => {
  it("maps each chord to every command bound to it", () => {
    const idx = reverseIndex({
      a: ["Mod+K"],
      b: ["Mod+K", "F6"],
      c: [],
    });
    expect(idx.get("Mod+K")).toEqual(["a", "b"]);
    expect(idx.get("F6")).toEqual(["b"]);
    expect(idx.has("")).toBe(false);
  });
});

describe("useKeymapStore", () => {
  beforeEach(() => {
    useKeymapStore.getState().reset(DEFAULTS);
  });

  it("exposes the effective keymap (defaults + diff)", () => {
    expect(useKeymapStore.getState().effective["repo.fetch"]).toEqual(["Mod+Shift+F"]);
    useKeymapStore.getState().setDiff({ "repo.fetch": ["F6"] });
    expect(useKeymapStore.getState().effective["repo.fetch"]).toEqual(["F6"]);
  });

  it("keeps the reverse index in sync", () => {
    useKeymapStore.getState().setDiff({ "repo.pull": ["F7"] });
    expect(useKeymapStore.getState().byChord.get("F7")).toEqual(["repo.pull"]);
    expect(useKeymapStore.getState().byChord.get("Mod+Shift+F")).toEqual(["repo.fetch"]);
  });
});
