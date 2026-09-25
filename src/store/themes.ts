import { create } from "zustand";
import { saveTheme, loadTheme, listThemes, deleteTheme, setActiveTheme } from "../lib/commands";
import { applyTheme } from "../theme/applier";
import { DEFAULT_THEME } from "../theme/defaults";
import { asTheme, validateTheme } from "../theme/validate";
import type { ThemeDocument, ThemeEntry } from "../lib/types";
import { useSettingsStore } from "./settings";

interface ThemeStore {
  themes: ThemeEntry[];
  activeThemeName: string | null;
  activeDocument: ThemeDocument | null;
  /** Working buffer used by the Theme Editor. */
  draft: ThemeDocument | null;
  /** `true` when `draft` has unsaved changes vs `activeDocument`. */
  draftDirty: boolean;
  /** Name of the user theme the draft was started from (null for a new
   *  theme). Saving under a different name renames — the origin file is
   *  removed — rather than duplicating (duplication is `startNewTheme`). */
  draftOrigin: string | null;

  init: () => Promise<void>;
  /** Refetch and re-apply the persisted active theme; for secondary windows
   *  reacting to the settings-changed broadcast. Never persists (that would
   *  re-emit the broadcast) and never touches the editor draft. */
  reload: () => Promise<void>;
  refreshList: () => Promise<void>;
  setActive: (name: string) => Promise<void>;
  startEditing: () => void;
  /** Start a new theme: a draft copied from the active document under a fresh
   *  name, immediately in editing mode (dirty, so Save is available). */
  startNewTheme: () => void;
  cancelEditing: () => void;
  updateDraftPalette: (palette: Record<string, string>) => void;
  updateDraftTokens: (tokens: ThemeDocument["tokens"]) => void;
  updateDraftPanelOverrides: (overrides: ThemeDocument["panelOverrides"]) => void;
  updateDraftMeta: (patch: Partial<Pick<ThemeDocument, "name" | "description" | "author" | "laneChipFilters">>) => void;
  saveDraftAs: (name: string) => Promise<void>;
  deleteUserTheme: (name: string) => Promise<void>;
  importThemeFromJson: (json: unknown, suggestedName?: string) => Promise<ThemeEntry>;
}

/** Theme to activate at startup: the persisted choice always wins; a fresh
 *  install (nothing persisted) starts on the built-in Dark theme - NOT the
 *  alphabetically first entry; only when Dark is missing entirely (broken
 *  install) fall back to whatever theme exists. `undefined` means no theme is
 *  available at all (caller applies the embedded default). */
export function pickInitialThemeName(
  persisted: string | null | undefined,
  themes: ThemeEntry[],
): string | undefined {
  return (
    persisted ?? themes.find((t) => t.name === "Dark")?.name ?? themes[0]?.name
  );
}

/** Split a theme list for pickers: built-ins first, then user themes, each
 *  group keeping the backend's alphabetical order. */
export function partitionThemes(themes: ThemeEntry[]): {
  builtin: ThemeEntry[];
  user: ThemeEntry[];
} {
  return {
    builtin: themes.filter((t) => t.source === "builtin"),
    user: themes.filter((t) => t.source === "user"),
  };
}

/** Copy per-panel override maps so draft edits never alias the source. */
function copyOverrides(
  overrides: ThemeDocument["panelOverrides"],
): ThemeDocument["panelOverrides"] {
  if (!overrides) return overrides;
  return Object.fromEntries(Object.entries(overrides).map(([id, entry]) => [id, { ...entry }]));
}

export const useThemeStore = create<ThemeStore>((set, get) => ({
  themes: [],
  activeThemeName: null,
  activeDocument: null,
  draft: null,
  draftDirty: false,
  draftOrigin: null,

  async init() {
    await get().refreshList();
    const settings = useSettingsStore.getState().settings;
    const candidate = pickInitialThemeName(settings?.active_theme, get().themes);
    if (candidate) {
      await get().setActive(candidate);
    } else {
      // Fall back to the embedded default so the app is never unstyled.
      applyTheme(DEFAULT_THEME);
      set({ activeDocument: DEFAULT_THEME });
    }
  },

  async refreshList() {
    const themes = await listThemes();
    set({ themes });
  },

  async reload() {
    await get().refreshList();
    const settings = useSettingsStore.getState().settings;
    const candidate = pickInitialThemeName(settings?.active_theme, get().themes);
    if (!candidate) return;
    let doc: ThemeDocument;
    try {
      const raw = await loadTheme(candidate);
      const validated = asTheme(raw);
      if (!validated) throw new Error("invalid theme file");
      doc = validated;
    } catch (e) {
      console.warn(`failed to load theme '${candidate}', falling back to default`, e);
      doc = DEFAULT_THEME;
    }
    applyTheme(doc);
    set({ activeThemeName: candidate, activeDocument: doc });
  },

  async setActive(name: string) {
    let doc: ThemeDocument;
    try {
      const raw = await loadTheme(name);
      const validated = asTheme(raw);
      if (!validated) throw new Error("invalid theme file");
      doc = validated;
    } catch (e) {
      console.warn(`failed to load theme '${name}', falling back to default`, e);
      doc = DEFAULT_THEME;
    }
    applyTheme(doc);
    set({ activeThemeName: name, activeDocument: doc, draft: null, draftDirty: false, draftOrigin: null });
    try {
      await setActiveTheme(name);
    } catch (e) {
      console.warn("failed to persist active theme", e);
    }
  },

  startEditing() {
    const active = get().activeDocument;
    if (!active) return;
    set({
      draft: {
        ...active,
        palette: { ...active.palette },
        tokens: { ...active.tokens },
        panelOverrides: copyOverrides(active.panelOverrides),
      },
      draftDirty: false,
      draftOrigin: get().activeThemeName,
    });
  },

  startNewTheme() {
    const base = get().activeDocument ?? DEFAULT_THEME;
    const taken = new Set(get().themes.map((t) => t.name));
    let name = "New Theme";
    let i = 1;
    while (taken.has(name)) name = `New Theme ${++i}`;
    set({
      draft: {
        ...base,
        name,
        palette: { ...base.palette },
        tokens: { ...base.tokens },
        panelOverrides: copyOverrides(base.panelOverrides),
      },
      draftDirty: true,
      draftOrigin: null,
    });
  },

  cancelEditing() {
    const active = get().activeDocument;
    if (active) applyTheme(active);
    set({ draft: null, draftDirty: false, draftOrigin: null });
  },

  updateDraftPalette(palette) {
    const draft = get().draft;
    if (!draft) return;
    const next: ThemeDocument = { ...draft, palette };
    applyTheme(next);
    set({ draft: next, draftDirty: true });
  },

  updateDraftTokens(tokens) {
    const draft = get().draft;
    if (!draft) return;
    const next: ThemeDocument = { ...draft, tokens };
    applyTheme(next);
    set({ draft: next, draftDirty: true });
  },

  updateDraftPanelOverrides(overrides) {
    const draft = get().draft;
    if (!draft) return;
    const next: ThemeDocument = { ...draft, panelOverrides: overrides };
    applyTheme(next);
    set({ draft: next, draftDirty: true });
  },

  updateDraftMeta(patch) {
    const draft = get().draft;
    if (!draft) return;
    set({ draft: { ...draft, ...patch }, draftDirty: true });
  },

  async saveDraftAs(name) {
    const draft = get().draft;
    if (!draft) throw new Error("no draft to save");
    const doc: ThemeDocument = { ...draft, name };
    const result = validateTheme(doc);
    if (!result.ok) {
      throw new Error(result.errors.map((e) => `${e.field}: ${e.message}`).join("; "));
    }
    const entry = await saveTheme(name, doc);
    // A changed name is a RENAME of the origin theme, not a copy — remove the
    // old file (duplication is `startNewTheme`'s job). Only ever deletes user
    // themes; built-ins aren't editable and are guarded again here.
    const origin = get().draftOrigin;
    if (
      origin &&
      origin !== entry.name &&
      get().themes.some((t) => t.name === origin && t.source === "user")
    ) {
      await deleteTheme(origin);
    }
    await get().refreshList();
    await get().setActive(entry.name);
  },

  async deleteUserTheme(name) {
    await deleteTheme(name);
    if (get().activeThemeName === name) {
      const fallback = get().themes.find((t) => t.name !== name);
      if (fallback) await get().setActive(fallback.name);
    }
    await get().refreshList();
  },

  async importThemeFromJson(raw, suggestedName) {
    const result = validateTheme(raw);
    if (!result.ok) {
      throw new Error(
        "Invalid theme file:\n" +
          result.errors.map((e) => `  ${e.field}: ${e.message}`).join("\n")
      );
    }
    const doc = raw as ThemeDocument;
    const name = suggestedName ?? doc.name;
    const entry = await saveTheme(name, doc);
    await get().refreshList();
    // An import is an explicit "use this" gesture: activate it right away
    // (applies + persists). Note this discards any open editor draft.
    await get().setActive(entry.name);
    return entry;
  },
}));
