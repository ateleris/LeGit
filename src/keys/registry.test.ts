import { describe, expect, it } from "vitest";
import { ALL_PANELS } from "../panels/registry";
import { normalizeChord, parseChord } from "./chord";
import { COMMANDS, COMMAND_ID_ALIASES, defaultKeymap } from "./registry";

/**
 * Registry contract (theme-contract style): command ids are a user-facing
 * contract referenced by persisted keymaps - adding is safe, renaming or
 * removing breaks user files silently, so a rename must land with an alias.
 * Shipped default bindings must be layout-independent (QWERTZ reference).
 */

/** Keys allowed in SHIPPED defaults (user captures are unconstrained). */
const ALLOWED_DEFAULT_KEYS = new Set([
  ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)),
  ...Array.from({ length: 10 }, (_, i) => String(i)),
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Enter",
  "Space",
  "Tab",
  "Delete",
  "Backspace",
  ",",
  ".",
  "Plus",
  "Minus",
  "ContextMenu",
]);

describe("command registry contract", () => {
  it("ids are unique", () => {
    const ids = COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("ids are dot-separated lowerCamel segments", () => {
    for (const c of COMMANDS) {
      expect(c.id).toMatch(/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/);
    }
  });

  it("every command has a human-readable title", () => {
    for (const c of COMMANDS) expect(c.title.trim().length).toBeGreaterThan(0);
  });

  it("panel scopes name a real panel id", () => {
    const panelIds = new Set(ALL_PANELS.map((p) => p.id));
    for (const c of COMMANDS) {
      if (c.scope.startsWith("panel:")) {
        expect(panelIds.has(c.scope.slice("panel:".length))).toBe(true);
      }
    }
  });

  it("every default binding parses, in canonical form, from allowed keys, never Escape", () => {
    for (const c of COMMANDS) {
      for (const chord of c.defaultBinding) {
        const parsed = parseChord(chord);
        expect(parsed, `${c.id}: ${chord}`).not.toBeNull();
        expect(normalizeChord(chord), `${c.id}: ${chord} not canonical`).toBe(chord);
        expect(parsed!.key, `${c.id}: ${chord} uses a layout-hostile key`).not.toBe("Escape");
        expect(
          ALLOWED_DEFAULT_KEYS.has(parsed!.key),
          `${c.id}: ${chord} uses a layout-hostile key`,
        ).toBe(true);
      }
    }
  });

  it("no two commands in the same scope share a default chord", () => {
    const seen = new Map<string, string>();
    for (const c of COMMANDS) {
      for (const chord of c.defaultBinding) {
        const key = `${c.scope}::${chord}`;
        expect(seen.get(key), `${c.id} collides with ${seen.get(key)} on ${chord}`).toBeUndefined();
        seen.set(key, c.id);
      }
    }
  });

  it("aliases map old ids to current ids, append-only", () => {
    const ids = new Set(COMMANDS.map((c) => c.id));
    for (const [oldId, newId] of Object.entries(COMMAND_ID_ALIASES)) {
      expect(ids.has(newId), `alias ${oldId} -> ${newId} targets a missing id`).toBe(true);
      expect(ids.has(oldId), `alias source ${oldId} is still a live id`).toBe(false);
    }
  });
});

describe("migrated bindings", () => {
  it("panel.toggleMaximize keeps Ctrl+Shift+M (Mod+Shift+M)", () => {
    const cmd = COMMANDS.find((c) => c.id === "panel.toggleMaximize");
    expect(cmd).toBeDefined();
    expect(cmd!.scope).toBe("global");
    expect(cmd!.defaultBinding).toEqual(["Mod+Shift+M"]);
  });
});

describe("defaultKeymap", () => {
  it("derives one entry per command", () => {
    const km = defaultKeymap();
    expect(Object.keys(km).sort()).toEqual(COMMANDS.map((c) => c.id).sort());
    expect(km["panel.toggleMaximize"]).toEqual(["Mod+Shift+M"]);
  });
});
