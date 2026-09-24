// Pins the CLAUDE.md theme-editor rules as pure logic: renaming a palette
// entry auto-updates every token binding and panel override that references
// it, and an entry can be deleted only while nothing references it.
import { describe, it, expect } from "vitest";
import type { ThemeDocument } from "../lib/types";
import {
  addPaletteEntry,
  paletteRefsInUse,
  removePaletteEntry,
  renamePaletteEntry,
  resetToken,
} from "./draftOps";

const doc = (over: Partial<ThemeDocument> = {}): ThemeDocument => ({
  format: "legit-theme",
  formatVersion: 1,
  name: "t",
  palette: { ink: "#111111", paper: "#eeeeee", spare: "#ff0000" },
  tokens: {
    "panel.fg": "ink",
    "panel.bg": { ref: "paper", filter: "darker" },
  },
  ...over,
});

describe("renamePaletteEntry", () => {
  it("moves the colour and rebinds plain and filtered token bindings", () => {
    const patch = renamePaletteEntry(doc(), "paper", "parchment");
    expect(patch).not.toBeNull();
    expect(patch!.palette.parchment).toBe("#eeeeee");
    expect(patch!.palette.paper).toBeUndefined();
    expect(patch!.tokens["panel.fg"]).toBe("ink");
    expect(patch!.tokens["panel.bg"]).toEqual({ ref: "parchment", filter: "darker" });
  });

  it("rebinds panel overrides referencing the old name", () => {
    const patch = renamePaletteEntry(
      doc({ panelOverrides: { log: { "panel.bg": "paper" } } }),
      "paper",
      "parchment",
    );
    expect(patch!.panelOverrides).toEqual({ log: { "panel.bg": "parchment" } });
  });

  it("is a no-op for an empty or unchanged name", () => {
    expect(renamePaletteEntry(doc(), "paper", "")).toBeNull();
    expect(renamePaletteEntry(doc(), "paper", "paper")).toBeNull();
  });
});

describe("removePaletteEntry", () => {
  it("refuses while a token references the entry", () => {
    expect(removePaletteEntry(doc(), "ink")).toBeNull();
  });

  it("refuses while only a panel override references the entry", () => {
    const d = doc({ panelOverrides: { log: { "panel.bg": "spare" } } });
    expect(removePaletteEntry(d, "spare")).toBeNull();
  });

  it("removes an unreferenced entry", () => {
    const palette = removePaletteEntry(doc(), "spare");
    expect(palette).not.toBeNull();
    expect(palette!.spare).toBeUndefined();
    expect(palette!.ink).toBe("#111111");
  });
});

describe("addPaletteEntry", () => {
  it("picks a name that does not collide", () => {
    const first = addPaletteEntry(doc());
    expect(first.name).toBe("new-color");
    const second = addPaletteEntry(doc({ palette: { "new-color": "#000000" } }));
    expect(second.name).toBe("new-color-2");
    expect(second.palette["new-color-2"]).toBe("#000000");
  });
});

describe("paletteRefsInUse", () => {
  it("unions token refs and panel-override refs", () => {
    const d = doc({ panelOverrides: { log: { "panel.bg": "spare" } } });
    expect(paletteRefsInUse(d)).toEqual(new Set(["ink", "paper", "spare"]));
  });
});

describe("resetToken", () => {
  it("drops only the named token's override", () => {
    const tokens = resetToken(doc(), "panel.bg");
    expect(tokens["panel.bg"]).toBeUndefined();
    expect(tokens["panel.fg"]).toBe("ink");
  });
});
