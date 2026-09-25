import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { formatAppError } from "../../lib/errors";
import { partitionThemes, useThemeStore } from "../../store/themes";
import { notify } from "../../store/notifications";
import { confirmDestructiveAction } from "../../store/confirm";
import { DEFAULT_THEME } from "../../theme/defaults";
import { TOKEN_CONTRACT } from "../../theme/tokens";
import {
  bindingFilter,
  bindingRef,
  makeBinding,
  resolveBindingColor,
  setPanelOverrideBinding,
  TOKEN_FILTERS,
  effectiveLaneChipFilters,
} from "../../theme/filters";
import * as draftOps from "../../theme/draftOps";
import { validateTheme } from "../../theme/validate";
import type { ThemeDocument, TokenFilterId } from "../../lib/types";
import { Button } from "../shared/buttons";
import { SettingsGroup } from "../Settings/primitives";
import { ContrastSection } from "./ContrastSection";
import { PaletteEditor } from "./PaletteEditor";
import { PanelOverridesSection } from "./PanelOverridesSection";

export function ThemeEditorPanel() {
  const themes = useThemeStore((s) => s.themes);
  const activeName = useThemeStore((s) => s.activeThemeName);
  const activeDoc = useThemeStore((s) => s.activeDocument);
  const draft = useThemeStore((s) => s.draft);
  const draftDirty = useThemeStore((s) => s.draftDirty);
  const setActive = useThemeStore((s) => s.setActive);
  const startEditing = useThemeStore((s) => s.startEditing);
  const startNewTheme = useThemeStore((s) => s.startNewTheme);
  const cancelEditing = useThemeStore((s) => s.cancelEditing);
  const updateDraftPalette = useThemeStore((s) => s.updateDraftPalette);
  const updateDraftTokens = useThemeStore((s) => s.updateDraftTokens);
  const updateDraftPanelOverrides = useThemeStore((s) => s.updateDraftPanelOverrides);
  const updateDraftMeta = useThemeStore((s) => s.updateDraftMeta);
  const saveDraftAs = useThemeStore((s) => s.saveDraftAs);
  const deleteUserTheme = useThemeStore((s) => s.deleteUserTheme);
  const importThemeFromJson = useThemeStore((s) => s.importThemeFromJson);

  const [error, setError] = useState<string | null>(null);

  const editing = draft != null;
  const working = (draft ?? activeDoc) as ThemeDocument | null;

  // User themes edit implicitly: the controls stay live in view mode and the
  // first change starts the draft (the toolbar flips to Save/Cancel). Only
  // built-in themes are truly read-only.
  const activeIsBuiltin = themes.find((t) => t.name === activeName)?.source === "builtin";
  const readOnly = !editing && activeIsBuiltin;

  // Clicking around a read-only built-in must not feel broken: explain and
  // point at the fix. Rate-limited so a burst of clicks yields one toast.
  const lastHintRef = useRef(0);
  const onReadOnlyPointerDown = (e: React.PointerEvent) => {
    if (!readOnly) return;
    // Live controls (section headers, a panel whose data query failed, ...)
    // handle their own clicks - no hint for those.
    const target = e.target as HTMLElement;
    if (target.closest("button:enabled, select:enabled, input:enabled, textarea:enabled")) return;
    const now = Date.now();
    if (now - lastHintRef.current < 4000) return;
    lastHintRef.current = now;
    notify.info("Built-in themes are read-only. Use New to create an editable copy.");
  };

  const groups = useMemo(() => {
    const map = new Map<string, typeof TOKEN_CONTRACT[number][]>();
    for (const t of TOKEN_CONTRACT) {
      const list = map.get(t.group) ?? [];
      list.push(t);
      map.set(t.group, list);
    }
    return Array.from(map.entries());
  }, []);

  if (!working) {
    return (
      <div className="legit-panel">
        <div className="legit-panel__body">Loading themes…</div>
      </div>
    );
  }

  const setMeta = (patch: { name?: string; author?: string; description?: string; laneChipFilters?: ThemeDocument["laneChipFilters"] }) => {
    if (readOnly) return;
    if (!draft) startEditing();
    updateDraftMeta(patch);
  };

  const setPaletteValue = (name: string, value: string) => {
    if (!draft) startEditing();
    const current = (draft ?? activeDoc)!;
    updateDraftPalette({ ...current.palette, [name]: value });
  };

  const renamePaletteEntry = (oldName: string, newName: string) => {
    const current = (draft ?? activeDoc)!;
    const patch = draftOps.renamePaletteEntry(current, oldName, newName);
    if (!patch) return;
    if (!draft) startEditing();
    updateDraftPalette(patch.palette);
    updateDraftTokens(patch.tokens);
    if (patch.panelOverrides) updateDraftPanelOverrides(patch.panelOverrides);
  };

  const removePaletteEntry = (name: string) => {
    const current = (draft ?? activeDoc)!;
    // Null while a token or panel override still references the entry (the UI
    // also disables the button).
    const palette = draftOps.removePaletteEntry(current, name);
    if (!palette) return;
    if (!draft) startEditing();
    updateDraftPalette(palette);
  };

  const addPaletteEntry = () => {
    if (!draft) startEditing();
    const current = (draft ?? activeDoc)!;
    updateDraftPalette(draftOps.addPaletteEntry(current).palette);
  };

  const setTokenBinding = (token: string, paletteRef: string, filter: TokenFilterId | null) => {
    if (!draft) startEditing();
    const current = (draft ?? activeDoc)!;
    updateDraftTokens({ ...current.tokens, [token]: makeBinding(paletteRef, filter) });
  };

  // ref null = back to "inherit" (the override is removed).
  const setPanelOverride = (
    panelId: string,
    token: string,
    paletteRef: string | null,
    filter: TokenFilterId | null,
  ) => {
    if (readOnly) return;
    if (!draft) startEditing();
    const current = (draft ?? activeDoc)!;
    updateDraftPanelOverrides(
      setPanelOverrideBinding(
        current.panelOverrides,
        panelId,
        token,
        paletteRef ? makeBinding(paletteRef, filter) : null,
      ),
    );
  };

  // Reset a token to its built-in default by dropping the theme's override, so
  // it inherits the default binding the same way an unset token does (mirrors
  // resolveTheme) — rather than writing a redundant explicit copy of the default.
  const resetToken = (token: string) => {
    if (!draft) startEditing();
    const current = (draft ?? activeDoc)!;
    updateDraftTokens(draftOps.resetToken(current, token));
  };

  // Saves under the draft's name — rename via the Metadata "Name" field.
  const onSave = async () => {
    setError(null);
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) {
      setError("Theme name is required");
      return;
    }
    // Built-ins are read-only; a user theme under the same name would shadow
    // (or ambiguously duplicate) the shipped one.
    if (themes.some((t) => t.name === name && t.source === "builtin")) {
      setError(`"${name}" is a built-in theme — choose a different name.`);
      return;
    }
    const result = validateTheme({ ...draft, name });
    if (!result.ok) {
      setError(result.errors.map((e) => `${e.field}: ${e.message}`).join("\n"));
      return;
    }
    try {
      await saveDraftAs(name);
    } catch (e) {
      setError(formatAppError(e));
    }
  };

  const onExport = async () => {
    if (!working) return;
    const path = await saveDialog({
      defaultPath: `${working.name}.legit-theme.json`,
      filters: [{ name: "LeGit Theme", extensions: ["legit-theme.json", "json"] }],
    });
    if (!path) return;
    try {
      await writeTextFile(path, JSON.stringify(working, null, 2));
    } catch (e) {
      setError(formatAppError(e));
    }
  };

  const onImport = async () => {
    setError(null);
    const path = await openDialog({
      multiple: false,
      filters: [{ name: "LeGit Theme", extensions: ["json"] }],
    });
    if (typeof path !== "string") return;
    try {
      const text = await readTextFile(path);
      const json = JSON.parse(text);
      const result = validateTheme(json);
      if (!result.ok) {
        setError(result.errors.map((e) => `${e.field}: ${e.message}`).join("\n"));
        return;
      }
      const fileStem = path.replace(/^.*[/\\]/, "").replace(/\.legit-theme\.json$/i, "");
      await importThemeFromJson(json, fileStem || (json as ThemeDocument).name);
    } catch (e) {
      setError(formatAppError(e));
    }
  };

  const onDeleteUserTheme = async (name: string) => {
    // Global destructive-confirmation setting: when off, delete immediately.
    const ok = await confirmDestructiveAction({
      title: "Delete theme",
      message: "Deletes the user theme file. Built-in themes are unaffected.",
      detail: name,
      confirmLabel: "Delete theme",
    });
    if (!ok) return;
    try {
      await deleteUserTheme(name);
    } catch (e) {
      setError(formatAppError(e));
    }
  };

  const isUserTheme = (n: string) => themes.find((t) => t.name === n)?.source === "user";

  const themePicker = partitionThemes(themes);

  return (
    <div className="legit-panel">
      <div className="legit-panel__toolbar" style={{ flexWrap: "wrap" }}>
        <label>
          Theme:&nbsp;
          <select value={activeName ?? ""} onChange={(e) => setActive(e.target.value)}>
            {themePicker.builtin.map((t) => (
              <option key={`${t.source}:${t.name}`} value={t.name}>
                {`${t.name} (built-in)`}
              </option>
            ))}
            {themePicker.builtin.length > 0 && themePicker.user.length > 0 && (
              <option value="─separator─" disabled>
                ────────────
              </option>
            )}
            {themePicker.user.map((t) => (
              <option key={`${t.source}:${t.name}`} value={t.name}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        {!editing ? (
          <>
            {/* Built-in themes are read-only — duplicate via New to customise. */}
            {activeName && isUserTheme(activeName) ? (
              <button onClick={startEditing}>Edit</button>
            ) : (
              <button
                disabled
                title="Built-in themes can't be edited — use New to create an editable copy"
              >
                Edit
              </button>
            )}
            <button onClick={startNewTheme}>New</button>
          </>
        ) : (
          <>
            <Button variant="primary" onClick={onSave} disabled={!draftDirty}>
              Save
            </Button>
            <button onClick={cancelEditing}>Cancel</button>
          </>
        )}
        <button onClick={onImport}>Import…</button>
        <button onClick={onExport}>Export…</button>
        {activeName && isUserTheme(activeName) && (
          <Button variant="danger" onClick={() => onDeleteUserTheme(activeName)}>
            Delete
          </Button>
        )}
      </div>
      <div
        className="legit-panel__body"
        onPointerDown={onReadOnlyPointerDown}
        // No top padding on the scroller: the sticky group headers pin flush
        // against the top edge (see SettingsGroup); the spacer below scrolls
        // away with the content instead.
        style={{ paddingTop: 0 }}
      >
        <div style={{ height: "calc(var(--ui-font-size) * 0.667)" }} />
        {error && <pre className="legit-error">{error}</pre>}

        <SettingsGroup id="theme-editor.metadata" title="Metadata">
          <div
            style={{ display: "grid", gap: "0.5em", gridTemplateColumns: "120px 1fr", marginBottom: "1em" }}
          >
            <label>Name</label>
            <input
              value={working.name}
              onChange={(e) => setMeta({ name: e.target.value })}
              disabled={readOnly}
            />
            <label>Author</label>
            <input
              value={working.author ?? ""}
              onChange={(e) => setMeta({ author: e.target.value })}
              disabled={readOnly}
            />
            <label>Description</label>
            <input
              value={working.description ?? ""}
              onChange={(e) => setMeta({ description: e.target.value })}
              disabled={readOnly}
            />
          </div>
        </SettingsGroup>

        <ContrastSection working={working} />

        <SettingsGroup id="theme-editor.palette" title="Palette">
          <PaletteEditor
            palette={working.palette}
            usedNames={draftOps.paletteRefsInUse(working)}
            disabled={readOnly}
            onChange={setPaletteValue}
            onRename={renamePaletteEntry}
            onRemove={removePaletteEntry}
            onAdd={addPaletteEntry}
          />
        </SettingsGroup>

        <SettingsGroup id="theme-editor.tokens" title="Tokens" defaultOpen={false}>
        {groups.map(([group, tokens]) => (
          <div key={group} style={{ marginBottom: "1em" }}>
            <div style={{ fontWeight: 600, marginBottom: "0.333em" }}>{group}</div>
            {group === "Refs" && (
              <div style={{ margin: "0.167em 0 0.667em" }}>
                {/* The on/off toggle is a GLOBAL setting (Global Settings →
                    Commits graph); the theme owns only how the chip parts
                    derive from the lane colour. */}
                <div style={{ color: "var(--subtle-fg)", marginBottom: "0.5em" }}>
                  Used while "Color branch chips by graph lane" is enabled in
                  Global Settings → Commits graph.
                </div>
                {(
                  [
                    ["fg", "branch chip foreground"],
                    ["border", "branch chip border"],
                    ["bg", "branch chip background"],
                  ] as const
                ).map(([part, partLabel]) => (
                    // Same grid/height/spacing as the token rows below, with
                    // the filter dropdown in the token rows' filter column.
                    <div
                      key={part}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "1fr 1fr 0.6fr 20px 24px",
                        alignItems: "center",
                        gap: "0.5em",
                        padding: "0.167em 0",
                      }}
                      title="Applied to the row's graph lane colour while the toggle is on."
                    >
                      <span style={{ fontFamily: "ui-monospace, monospace", fontSize: "var(--fz-md)" }}>
                        {partLabel}
                      </span>
                      <span />
                      <select
                        id={`lane-chip-filter-${part}`}
                        value={effectiveLaneChipFilters(working.laneChipFilters)[part] ?? ""}
                        onChange={(e) =>
                          setMeta({
                            laneChipFilters: {
                              ...effectiveLaneChipFilters(working.laneChipFilters),
                              [part]: e.target.value === "" ? null : (e.target.value as TokenFilterId),
                            },
                          })
                        }
                        disabled={readOnly}
                      >
                        <option value="">Lane color</option>
                        {TOKEN_FILTERS.map((f) => (
                          <option key={f.id} value={f.id}>
                            {f.label}
                          </option>
                        ))}
                      </select>
                      <span />
                      <span />
                    </div>
                  ))}
              </div>
            )}
            {tokens.map((t) => {
              // Show the *effective* binding, mirroring resolveTheme: a token
              // missing from this theme (or pointing at a missing palette
              // entry) renders with the built-in default's binding — the
              // dropdown must say so instead of defaulting to its first
              // option, which silently misreads as an explicit choice.
              const bound = working.tokens[t.name];
              const boundValid =
                bound !== undefined && working.palette[bindingRef(bound)] !== undefined;
              const current = boundValid ? bound : DEFAULT_THEME.tokens[t.name];
              const isFallback = !boundValid;
              const currentRef = current ? bindingRef(current) : "";
              const currentFilter = current ? bindingFilter(current) : null;
              const color = current
                ? resolveBindingColor(current, { ...DEFAULT_THEME.palette, ...working.palette })
                : undefined;
              return (
                <div
                  key={t.name}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr 0.6fr 20px 24px",
                    alignItems: "center",
                    gap: "0.5em",
                    padding: "0.167em 0",
                    // Dimmed while the theme has no explicit binding — the
                    // shown value is the built-in default fallback. Picking
                    // anything makes it explicit.
                    opacity: isFallback ? 0.65 : 1,
                  }}
                  title={
                    isFallback
                      ? `${t.documentation}\n\nNot set in this theme — showing the built-in default. Selecting a value binds it explicitly.`
                      : t.documentation
                  }
                >
                  <span style={{ fontFamily: "ui-monospace, monospace", fontSize: "var(--fz-md)" }}>
                    {t.name}
                  </span>
                  <select
                    value={currentRef}
                    onChange={(e) => setTokenBinding(t.name, e.target.value, currentFilter)}
                    disabled={readOnly}
                  >
                    {!working.palette[currentRef] && (
                      // The default binding references a palette entry this
                      // theme doesn't define — representable but not pickable.
                      <option value={currentRef} disabled>
                        {currentRef} (built-in)
                      </option>
                    )}
                    {Object.keys(working.palette).map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                  <select
                    value={currentFilter ?? ""}
                    title="Derive a variant of the palette colour (e.g. a hover shade) instead of adding another palette entry"
                    onChange={(e) =>
                      setTokenBinding(
                        t.name,
                        currentRef,
                        (e.target.value || null) as TokenFilterId | null,
                      )
                    }
                    disabled={readOnly || !currentRef}
                  >
                    <option value="">No filter</option>
                    {TOKEN_FILTERS.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                  {/* Reset to built-in — only when this theme overrides the
                      token; removing the override lets it inherit the default. */}
                  {bound !== undefined ? (
                    <button
                      onClick={() => resetToken(t.name)}
                      disabled={readOnly}
                      title="Reset to built-in default"
                      aria-label={`Reset ${t.name} to built-in default`}
                      style={{
                        width: 20,
                        height: 20,
                        padding: 0,
                        lineHeight: 1,
                        fontSize: "var(--fz-md)",
                        background: "transparent",
                        border: "1px solid var(--panel-border)",
                        borderRadius: 3,
                        color: "var(--subtle-fg)",
                        cursor: readOnly ? "default" : "pointer",
                      }}
                    >
                      ↺
                    </button>
                  ) : (
                    <span />
                  )}
                  <span
                    aria-hidden
                    style={{
                      display: "inline-block",
                      width: 16,
                      height: 16,
                      borderRadius: 3,
                      border: "1px solid var(--panel-border)",
                      background: color ?? "transparent",
                    }}
                  />
                </div>
              );
            })}
          </div>
        ))}
        </SettingsGroup>

        <PanelOverridesSection working={working} readOnly={readOnly} onSet={setPanelOverride} />
      </div>
    </div>
  );
}
