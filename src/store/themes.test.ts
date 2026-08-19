// Unit tests for the theme store's import flow: importing a theme must
// activate it immediately (apply + persist), and a rejected import must
// leave the active theme untouched.

import { describe, test, expect, vi, beforeEach } from "vitest";
import { partitionThemes, pickInitialThemeName, useThemeStore } from "./themes";
import { listThemes, loadTheme, saveTheme, setActiveTheme } from "../lib/commands";
import { applyTheme } from "../theme/applier";
import { DEFAULT_THEME } from "../theme/defaults";
import type { ThemeDocument } from "../lib/types";

vi.mock("../lib/commands", () => ({
  listThemes: vi.fn(),
  loadTheme: vi.fn(),
  saveTheme: vi.fn(),
  setActiveTheme: vi.fn(),
  deleteTheme: vi.fn(),
}));

// applyTheme writes CSS custom properties on `document`; vitest runs in a
// node environment, so the applier is stubbed out.
vi.mock("../theme/applier", () => ({ applyTheme: vi.fn() }));

vi.mock("./settings", () => ({
  useSettingsStore: { getState: () => ({ settings: null }) },
}));

const importedDoc: ThemeDocument = { ...DEFAULT_THEME, name: "Imported" };

beforeEach(() => {
  vi.clearAllMocks();
  useThemeStore.setState({
    themes: [],
    activeThemeName: null,
    activeDocument: null,
    draft: null,
    draftDirty: false,
    draftOrigin: null,
  });
});

describe("pickInitialThemeName", () => {
  const entry = (name: string, source: "builtin" | "user" = "builtin") => ({
    name,
    source,
    path: `themes/${name}.legit-theme.json`,
  });
  // Alphabetical, as the backend returns it — "Dark" is NOT first.
  const themes = [entry("Ateleris"), entry("Cozy"), entry("Dark"), entry("Light")];

  test("first install (no persisted choice) starts on Dark, not the first entry", () => {
    expect(pickInitialThemeName(null, themes)).toBe("Dark");
    expect(pickInitialThemeName(undefined, themes)).toBe("Dark");
  });

  test("a persisted choice always wins", () => {
    expect(pickInitialThemeName("Cozy", themes)).toBe("Cozy");
  });

  test("without Dark, falls back to the first available theme", () => {
    expect(pickInitialThemeName(null, [entry("Ateleris"), entry("Light")])).toBe("Ateleris");
    expect(pickInitialThemeName(null, [])).toBeUndefined();
  });
});

describe("partitionThemes", () => {
  test("splits built-ins from user themes, keeping each group's order", () => {
    const entry = (name: string, source: "builtin" | "user") => ({
      name,
      source,
      path: `themes/${name}.legit-theme.json`,
    });
    // Backend order is alphabetical across sources — the picker regroups it.
    const mixed = [
      entry("Cozy Light", "user"),
      entry("Dark", "builtin"),
      entry("Light", "builtin"),
      entry("Unicorn Light", "user"),
    ];

    const { builtin, user } = partitionThemes(mixed);

    expect(builtin.map((t) => t.name)).toEqual(["Dark", "Light"]);
    expect(user.map((t) => t.name)).toEqual(["Cozy Light", "Unicorn Light"]);
  });
});

describe("importThemeFromJson", () => {
  test("a successful import activates the imported theme", async () => {
    const entry = { name: "Imported", source: "user" as const, path: "themes/Imported.legit-theme.json" };
    vi.mocked(saveTheme).mockResolvedValue(entry);
    vi.mocked(listThemes).mockResolvedValue([entry]);
    vi.mocked(loadTheme).mockResolvedValue(importedDoc);

    await useThemeStore.getState().importThemeFromJson(importedDoc, "Imported");

    expect(setActiveTheme).toHaveBeenCalledWith("Imported");
    expect(applyTheme).toHaveBeenCalledWith(importedDoc);
    expect(useThemeStore.getState().activeThemeName).toBe("Imported");
  });

  test("a rejected import saves nothing and activates nothing", async () => {
    await expect(
      useThemeStore.getState().importThemeFromJson({ nonsense: true }, "Bad")
    ).rejects.toThrow(/Invalid theme file/);

    expect(saveTheme).not.toHaveBeenCalled();
    expect(setActiveTheme).not.toHaveBeenCalled();
    expect(useThemeStore.getState().activeThemeName).toBeNull();
  });
});
