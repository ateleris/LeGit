// The native macOS menu bar mirrors the in-app View menu. The model is pure:
// entries derive from the same panel descriptors, actions round-trip through
// string ids (menu items carry only an id string across the IPC boundary).

import { describe, expect, it } from "vitest";
import { GLOBAL_PANELS, REPO_PANELS } from "../layout/descriptors";
import { parseMacMenuAction, viewMenuEntries } from "./macMenuModel";

describe("viewMenuEntries", () => {
  const entries = viewMenuEntries(["Default", "Review: wide"]);

  it("lists every global panel with a global: action id", () => {
    expect(entries.globalPanels).toEqual(
      GLOBAL_PANELS.map((p) => ({ actionId: `global:${p.id}`, label: p.title })),
    );
  });

  it("lists repo panels except summon-only ones", () => {
    expect(entries.repoPanels.map((e) => e.actionId)).toEqual(
      REPO_PANELS.filter((p) => !p.summonOnly).map((p) => `repo:${p.id}`),
    );
    expect(entries.repoPanels.some((e) => e.actionId === "repo:interactive-rebase")).toBe(false);
  });

  it("lists saved layouts by name", () => {
    expect(entries.layouts).toEqual([
      { actionId: "layout:Default", label: "Default" },
      { actionId: "layout:Review: wide", label: "Review: wide" },
    ]);
  });
});

describe("parseMacMenuAction", () => {
  it("parses panel and fixed actions", () => {
    expect(parseMacMenuAction("global:theme-editor")).toEqual({
      kind: "global-panel",
      id: "theme-editor",
    });
    expect(parseMacMenuAction("repo:log")).toEqual({ kind: "repo-panel", id: "log" });
    expect(parseMacMenuAction("maximize")).toEqual({ kind: "maximize" });
    expect(parseMacMenuAction("open-repo")).toEqual({ kind: "open-repo" });
    expect(parseMacMenuAction("settings")).toEqual({ kind: "settings" });
  });

  it("keeps colons inside layout names intact", () => {
    expect(parseMacMenuAction("layout:Review: wide")).toEqual({
      kind: "layout",
      name: "Review: wide",
    });
  });

  it("returns null for unknown or malformed ids", () => {
    expect(parseMacMenuAction("bogus")).toBeNull();
    expect(parseMacMenuAction("nope:x")).toBeNull();
    expect(parseMacMenuAction("layout:")).toBeNull();
  });
});
