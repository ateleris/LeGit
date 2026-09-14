import { describe, expect, it } from "vitest";
import type { Layer } from "../store/layers";
import { reverseIndex, type Keymap } from "./keymap";
import type { Command } from "./registry";
import { resolve, type ResolveInput } from "./resolve";

const noop = () => {};

const COMMANDS: Command[] = [
  { id: "global.thing", title: "G", scope: "global", defaultBinding: ["Mod+K"], run: noop },
  { id: "repo.thing", title: "R", scope: "repo", defaultBinding: ["Mod+K"], run: noop },
  {
    id: "panel.thing",
    title: "P",
    scope: "panel:log",
    defaultBinding: ["Mod+K"],
    run: noop,
  },
  {
    id: "composer.commit",
    title: "Commit",
    scope: "repo",
    defaultBinding: ["Mod+Enter"],
    allowInInput: true,
    run: noop,
  },
  {
    id: "list.space",
    title: "Toggle",
    scope: "panel:workingChanges",
    defaultBinding: ["Space"],
    allowInInput: true,
    run: noop,
  },
  {
    id: "evil.selectAll",
    title: "Select all",
    scope: "global",
    defaultBinding: ["Mod+A"],
    allowInInput: true,
    run: noop,
  },
];

const keymap: Keymap = Object.fromEntries(COMMANDS.map((c) => [c.id, c.defaultBinding]));

const layer = (id: string, kind: Layer["kind"]): Layer => ({ id, kind, onDismiss: noop });

function input(overrides: Partial<ResolveInput> = {}): ResolveInput {
  return {
    commands: COMMANDS,
    byChord: reverseIndex(keymap),
    layers: [],
    focusPanel: null,
    repoActive: true,
    editableTarget: false,
    ...overrides,
  };
}

describe("resolve priority", () => {
  it("panel beats repo beats global for the same chord", () => {
    expect(resolve("Mod+K", input({ focusPanel: "log" }))?.id).toBe("panel.thing");
    expect(resolve("Mod+K", input({ focusPanel: "diff" }))?.id).toBe("repo.thing");
    expect(resolve("Mod+K", input({ repoActive: false }))?.id).toBe("global.thing");
  });

  it("returns null for an unbound chord", () => {
    expect(resolve("F9", input())).toBeNull();
  });

  it("a repo command needs an active repo", () => {
    expect(resolve("Mod+Enter", input({ repoActive: false }))).toBeNull();
  });
});

describe("layer blocking", () => {
  it("dialog and menu layers block resolution", () => {
    expect(resolve("Mod+K", input({ layers: [layer("d", "dialog")] }))).toBeNull();
    expect(resolve("Mod+K", input({ layers: [layer("m", "menu")] }))).toBeNull();
  });

  it("popover and mode layers do not block", () => {
    expect(resolve("Mod+K", input({ layers: [layer("p", "popover")] }))?.id).toBe("repo.thing");
    expect(resolve("Mod+K", input({ layers: [layer("x", "mode")] }))?.id).toBe("repo.thing");
  });
});

describe("input guard", () => {
  it("without allowInInput a binding never resolves in an editable target", () => {
    expect(resolve("Mod+K", input({ editableTarget: true }))).toBeNull();
  });

  it("allowInInput lets a modified chord resolve in an editable target", () => {
    expect(resolve("Mod+Enter", input({ editableTarget: true }))?.id).toBe("composer.commit");
  });

  it("plain keys never resolve in an editable target, even with allowInInput", () => {
    expect(
      resolve("Space", input({ editableTarget: true, focusPanel: "workingChanges" })),
    ).toBeNull();
    expect(
      resolve("Space", input({ editableTarget: false, focusPanel: "workingChanges" }))?.id,
    ).toBe("list.space");
  });

  it("native text-editing vocabulary is never intercepted in an editable target", () => {
    expect(resolve("Mod+A", input({ editableTarget: true }))).toBeNull();
    expect(resolve("Mod+A", input({ editableTarget: false }))?.id).toBe("evil.selectAll");
  });
});

describe("unbound vs absent", () => {
  it("an explicitly unbound command ([] in the keymap) does not resolve", () => {
    const unbound: Keymap = { ...keymap, "repo.thing": [], "panel.thing": [] };
    expect(resolve("Mod+K", input({ byChord: reverseIndex(unbound), focusPanel: "log" }))?.id).toBe(
      "global.thing",
    );
  });
});
