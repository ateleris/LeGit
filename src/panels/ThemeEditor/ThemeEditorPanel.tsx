import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatAppError } from "../../lib/types";
import { useThemeStore } from "../../store/themes";
import { notify } from "../../store/notifications";
import { confirmDialog } from "../../store/confirm";
import { useConfirmDestructive } from "../../store/settings";
import { contrastRatio, wcagBadge, type WcagBadge } from "../../theme/contrast";
import { DEFAULT_THEME } from "../../theme/defaults";
import { CONTRAST_PAIRS, TOKEN_CONTRACT, type ContrastPair } from "../../theme/tokens";
import {
  bindingFilter,
  bindingRef,
  makeBinding,
  resolveBindingColor,
  TOKEN_FILTERS,
  withRef,
} from "../../theme/filters";
import { validateTheme } from "../../theme/validate";
import type { ThemeDocument, ThemeTokenBinding, TokenFilterId } from "../../lib/types";
import { Button } from "../shared/buttons";
import { ChevronDownIcon } from "../../icons";
import { SettingsGroup } from "../Settings/primitives";

/**
 * The binding a token actually renders with (mirrors resolveTheme): the
 * theme's own binding when it exists and points at a defined palette entry,
 * otherwise the built-in default's binding.
 */
function effectiveBinding(working: ThemeDocument, token: string): ThemeTokenBinding | undefined {
  const b = working.tokens[token];
  return b !== undefined && working.palette[bindingRef(b)] !== undefined
    ? b
    : DEFAULT_THEME.tokens[token];
}

/** A pair's base surface stack as an array (nearest-first; empty for an opaque bg). */
function baseTokens(pair: ContrastPair): readonly string[] {
  return pair.base === undefined ? [] : typeof pair.base === "string" ? [pair.base] : pair.base;
}

export function ThemeEditorPanel() {
  const confirmDestructive = useConfirmDestructive();
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

  const setMeta = (patch: { name?: string; author?: string; description?: string }) => {
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
    if (!newName || oldName === newName) return;
    if (!draft) startEditing();
    const current = (draft ?? activeDoc)!;
    const palette = { ...current.palette };
    palette[newName] = palette[oldName];
    delete palette[oldName];
    const tokens = { ...current.tokens };
    for (const [tk, binding] of Object.entries(tokens)) {
      if (bindingRef(binding) === oldName) tokens[tk] = withRef(binding, newName);
    }
    updateDraftPalette(palette);
    updateDraftTokens(tokens);
  };

  const removePaletteEntry = (name: string) => {
    const current = (draft ?? activeDoc)!;
    // Guard: never remove a palette entry a token still references (it would
    // leave the binding dangling). The UI also disables the button.
    if (Object.values(current.tokens).some((b) => bindingRef(b) === name)) return;
    if (!draft) startEditing();
    const palette = { ...(draft ?? activeDoc)!.palette };
    delete palette[name];
    updateDraftPalette(palette);
  };

  const addPaletteEntry = () => {
    if (!draft) startEditing();
    const current = (draft ?? activeDoc)!;
    let base = "new-color";
    let i = 1;
    while (current.palette[base]) base = `new-color-${++i}`;
    updateDraftPalette({ ...current.palette, [base]: "#000000" });
  };

  const setTokenBinding = (token: string, paletteRef: string, filter: TokenFilterId | null) => {
    if (!draft) startEditing();
    const current = (draft ?? activeDoc)!;
    updateDraftTokens({ ...current.tokens, [token]: makeBinding(paletteRef, filter) });
  };

  // Reset a token to its built-in default by dropping the theme's override, so
  // it inherits the default binding the same way an unset token does (mirrors
  // resolveTheme) — rather than writing a redundant explicit copy of the default.
  const resetToken = (token: string) => {
    if (!draft) startEditing();
    const current = (draft ?? activeDoc)!;
    const next = { ...current.tokens };
    delete next[token];
    updateDraftTokens(next);
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
    if (confirmDestructive) {
      const ok = await confirmDialog({
        title: "Delete theme",
        message: "Deletes the user theme file. Built-in themes are unaffected.",
        detail: name,
        confirmLabel: "Delete theme",
      });
      if (!ok) return;
    }
    try {
      await deleteUserTheme(name);
    } catch (e) {
      setError(formatAppError(e));
    }
  };

  const isUserTheme = (n: string) => themes.find((t) => t.name === n)?.source === "user";

  return (
    <div className="legit-panel">
      <div className="legit-panel__toolbar" style={{ flexWrap: "wrap" }}>
        <label>
          Theme:&nbsp;
          <select value={activeName ?? ""} onChange={(e) => setActive(e.target.value)}>
            {themes.map((t) => (
              <option key={`${t.source}:${t.name}`} value={t.name}>
                {t.source === "builtin" ? `${t.name} (built-in)` : t.name}
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
      <div className="legit-panel__body" onPointerDown={onReadOnlyPointerDown}>
        {error && <pre className="legit-error">{error}</pre>}

        <SettingsGroup id="theme-editor.metadata" title="Metadata">
          <div
            style={{ display: "grid", gap: 6, gridTemplateColumns: "120px 1fr", marginBottom: 12 }}
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
            usedNames={new Set(Object.values(working.tokens).map(bindingRef))}
            disabled={readOnly}
            onChange={setPaletteValue}
            onRename={renamePaletteEntry}
            onRemove={removePaletteEntry}
            onAdd={addPaletteEntry}
          />
        </SettingsGroup>

        <SettingsGroup id="theme-editor.tokens" title="Tokens" defaultOpen={false}>
        {groups.map(([group, tokens]) => (
          <div key={group} style={{ marginBottom: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>{group}</div>
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
                    gap: 6,
                    padding: "2px 0",
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
      </div>
    </div>
  );
}

/**
 * The WCAG contrast section. Ratios are computed against what actually
 * renders: effective bindings resolved over the merged palette, with
 * translucent backgrounds composited over their `base` surface. Failing pairs
 * sort first within their group, and the header caption summarises the result
 * so the (collapsed-by-default) section is informative without expanding it.
 */
function ContrastSection({ working }: { working: ThemeDocument }) {
  const rows = useMemo(() => {
    const mergedPalette = { ...DEFAULT_THEME.palette, ...working.palette };
    const resolve = (token: string) => {
      const b = effectiveBinding(working, token);
      return b ? resolveBindingColor(b, mergedPalette) : undefined;
    };
    return CONTRAST_PAIRS.map((pair) => {
      const fg = resolve(pair.fg);
      const bg = resolve(pair.bg);
      const base = baseTokens(pair).map(resolve);
      const ratio =
        fg && bg && base.every((c) => c !== undefined)
          ? contrastRatio(fg, bg, base as string[])
          : null;
      // Below the pair's own floor (AA by default) — distinct from the badge,
      // which always names the absolute WCAG tier. Advisory pairs have no
      // floor: informational only.
      const below = !pair.advisory && ratio !== null && ratio < (pair.minRatio ?? 4.5);
      return { pair, ratio, badge: wcagBadge(ratio), below };
    });
  }, [working]);

  const failing = rows.filter((r) => r.below).length;
  const enforced = rows.filter((r) => !r.pair.advisory).length;
  const caption =
    failing > 0
      ? `${failing} of ${enforced} pairs below target`
      : `all ${enforced} pairs meet their target`;

  const grouped = useMemo(() => {
    const map = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = map.get(row.pair.group) ?? [];
      list.push(row);
      map.set(row.pair.group, list);
    }
    // Below-target pairs first within each group (stable otherwise).
    for (const list of map.values()) {
      list.sort((a, b) => Number(b.below) - Number(a.below));
    }
    return Array.from(map.entries());
  }, [rows]);

  const badgeClass = (below: boolean, badge: WcagBadge, advisory: boolean | undefined) =>
    below ? "legit-error" : advisory || badge === "n/a" ? "legit-subtle" : "legit-success";
  const cssVar = (token: string) => `var(--${token.replace(/\./g, "-")})`;

  return (
    <SettingsGroup id="theme-editor.contrast" title="Contrast (WCAG)" caption={caption} defaultOpen={false}>
      {grouped.map(([group, list]) => {
        const groupBelow = list.filter((r) => r.below).length;
        return (
        <ContrastGroup
          key={group}
          id={group}
          title={group}
          caption={groupBelow > 0 ? `${groupBelow} below target` : undefined}
          // Syntax highlighting is opt-in in the diff viewer, so its (large)
          // group starts collapsed.
          defaultOpen={group !== "Syntax highlighting"}
        >
          {list.map(({ pair, ratio, badge, below }) => (
            <div
              key={pair.label}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "2px 0",
              }}
            >
              {/* The sample nests inside the pair's base surface(s), deepest
                  outermost, so translucent backgrounds preview as they
                  composite in the real UI. */}
              <span style={{ borderRadius: 3, minWidth: 100, textAlign: "center" }}>
                {baseTokens(pair).reduceRight(
                  (child, baseToken) => (
                    <span
                      style={{ display: "block", background: cssVar(baseToken), borderRadius: 3 }}
                    >
                      {child}
                    </span>
                  ),
                  <span
                    style={{
                      display: "block",
                      background: cssVar(pair.bg),
                      color: cssVar(pair.fg),
                      padding: "2px 8px",
                      borderRadius: 3,
                    }}
                  >
                    Sample
                  </span>,
                )}
              </span>
              <span style={{ flex: 1 }}>{pair.label}</span>
              <span className="legit-subtle">{ratio ? ratio.toFixed(2) : "—"}</span>
              <span
                className={badgeClass(below, badge, pair.advisory)}
                title={
                  pair.advisory
                    ? "advisory: no required floor (word highlights are character-level emphasis)"
                    : `target: at least ${pair.minRatio ?? 4.5}:1`
                }
              >
                {badge}
              </span>
            </div>
          ))}
        </ContrastGroup>
        );
      })}
    </SettingsGroup>
  );
}

/**
 * A collapsible group inside the Contrast section. Same persistence pattern
 * as `SettingsGroup`, but styled as the section's inner group headings so the
 * two-level hierarchy stays readable.
 */
function ContrastGroup({
  id,
  title,
  caption,
  defaultOpen = true,
  children,
}: {
  id: string;
  title: string;
  caption?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const key = `legit.theme-editor.contrast-group.${id}`;
  const [open, setOpen] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      if (stored === "collapsed") return false;
      if (stored === "expanded") return true;
      return defaultOpen;
    } catch {
      return defaultOpen;
    }
  });
  const toggle = () =>
    setOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(key, next ? "expanded" : "collapsed");
      } catch {
        /* private mode / quota — the toggle still works for the session */
      }
      return next;
    });

  return (
    <div style={{ marginBottom: 12 }}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          background: "transparent",
          border: "none",
          padding: "2px 0",
          cursor: "pointer",
          color: "var(--panel-fg)",
          fontWeight: 600,
        }}
      >
        <ChevronDownIcon
          size="1em"
          style={{
            flexShrink: 0,
            transform: open ? "none" : "rotate(-90deg)",
            transition: "transform 0.12s",
          }}
        />
        <span>{title}</span>
        {caption && (
          <span className="legit-error" style={{ fontWeight: 400 }}>
            {caption}
          </span>
        )}
      </button>
      {open && <div style={{ marginTop: 4 }}>{children}</div>}
    </div>
  );
}

interface PaletteEditorProps {
  palette: Record<string, string>;
  /** Palette entries currently referenced by a token (not removable). */
  usedNames: Set<string>;
  disabled: boolean;
  onChange: (name: string, value: string) => void;
  onRename: (oldName: string, newName: string) => void;
  onRemove: (name: string) => void;
  onAdd: () => void;
}

function PaletteEditor(p: PaletteEditorProps) {
  return (
    <div style={{ marginBottom: 12 }}>
      {Object.entries(p.palette).map(([name, value]) => (
        <PaletteRow
          key={name}
          name={name}
          value={value}
          inUse={p.usedNames.has(name)}
          disabled={p.disabled}
          onChange={p.onChange}
          onRename={p.onRename}
          onRemove={p.onRemove}
        />
      ))}
      <button onClick={p.onAdd} disabled={p.disabled} style={{ marginTop: 4 }}>
        + Add palette colour
      </button>
    </div>
  );
}

interface PaletteRowProps {
  name: string;
  value: string;
  inUse: boolean;
  disabled: boolean;
  onChange: (name: string, value: string) => void;
  onRename: (oldName: string, newName: string) => void;
  onRemove: (name: string) => void;
}

function PaletteRow(p: PaletteRowProps) {
  const [rename, setRename] = useState(p.name);

  // Local swatch state so dragging in the colour picker stays responsive
  // without re-rendering (and live-applying) the whole theme on every
  // intermediate value. The committed value is applied only on the native
  // `change` event below.
  const [picker, setPicker] = useState(() => hexForPicker(p.value));
  const pickerRef = useRef<HTMLInputElement>(null);
  const commit = useRef(p.onChange);
  commit.current = p.onChange;

  // Keep the swatch in sync when the value changes elsewhere (hex field edit,
  // theme switch) — but not mid-drag.
  useEffect(() => {
    setPicker(hexForPicker(p.value));
  }, [p.value]);

  // `change` fires only when a colour is selected/committed, unlike React's
  // `onChange` (the DOM `input` event) which fires continuously while picking.
  useEffect(() => {
    const el = pickerRef.current;
    if (!el) return;
    const onCommit = () => commit.current(p.name, el.value);
    el.addEventListener("change", onCommit);
    return () => el.removeEventListener("change", onCommit);
  }, [p.name]);

  return (
    <div className="palette-row">
      <input
        className="palette-row__name"
        value={rename}
        disabled={p.disabled}
        title="Rename — token bindings update automatically"
        onChange={(e) => setRename(e.target.value)}
        onBlur={() => {
          if (rename !== p.name && rename.trim().length > 0) p.onRename(p.name, rename.trim());
          else setRename(p.name);
        }}
      />
      <input
        className="palette-row__hex"
        value={p.value}
        disabled={p.disabled}
        onChange={(e) => p.onChange(p.name, e.target.value)}
      />
      {p.disabled ? (
        // A plain swatch instead of a disabled <input type="color">: the
        // WebView mutes disabled colour inputs, which misrepresents the
        // palette entry's actual colour in view mode.
        <span
          className="palette-row__picker palette-row__picker--static"
          style={{ background: p.value }}
          aria-hidden
        />
      ) : (
        <input
          ref={pickerRef}
          type="color"
          className="palette-row__picker"
          value={picker}
          onChange={(e) => setPicker(e.target.value)}
        />
      )}
      <button
        className="palette-row__delete"
        disabled={p.disabled || p.inUse}
        title={p.inUse ? "In use by a token — cannot remove" : "Remove palette colour"}
        aria-label="Remove palette colour"
        onClick={() => p.onRemove(p.name)}
      >
        ×
      </button>
    </div>
  );
}

function hexForPicker(color: string): string {
  // The <input type="color"> only accepts #rrggbb. Map other formats to a sensible fallback.
  const m = color.trim().match(/^#([0-9a-fA-F]{3,8})$/);
  if (!m) return "#000000";
  if (m[1].length === 6 || m[1].length === 8) return `#${m[1].slice(0, 6)}`;
  if (m[1].length === 3 || m[1].length === 4) {
    const ex = m[1]
      .slice(0, 3)
      .split("")
      .map((c) => c + c)
      .join("");
    return `#${ex}`;
  }
  return "#000000";
}
