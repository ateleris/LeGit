// Unit tests for the theme store's import flow: importing a theme must
// activate it immediately (apply + persist), and a rejected import must
// leave the active theme untouched.

import { describe, test, expect, vi, beforeEach } from "vitest";
import { useThemeStore } from "./themes";
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
