import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { useMemo, useState } from "react";
import { formatAppError } from "../../lib/types";
import { useThemeStore } from "../../store/themes";
import { contrastRatio, wcagBadge } from "../../theme/contrast";
import { CONTRAST_PAIRS, PALETTE_CONTRACT, TOKEN_CONTRACT } from "../../theme/tokens";
import { validateTheme } from "../../theme/validate";
import type { ThemeDocument } from "../../lib/types";

export function ThemeEditorPanel() {
  const themes = useThemeStore((s) => s.themes);
  const activeName = useThemeStore((s) => s.activeThemeName);
  const activeDoc = useThemeStore((s) => s.activeDocument);
  const draft = useThemeStore((s) => s.draft);
  const draftDirty = useThemeStore((s) => s.draftDirty);
  const setActive = useThemeStore((s) => s.setActive);
  const startEditing = useThemeStore((s) => s.startEditing);
  const cancelEditing = useThemeStore((s) => s.cancelEditing);
  const updateDraftPalette = useThemeStore((s) => s.updateDraftPalette);
  const updateDraftTokens = useThemeStore((s) => s.updateDraftTokens);
  const updateDraftMeta = useThemeStore((s) => s.updateDraftMeta);
  const saveDraftAs = useThemeStore((s) => s.saveDraftAs);
  const deleteUserTheme = useThemeStore((s) => s.deleteUserTheme);
  const importThemeFromJson = useThemeStore((s) => s.importThemeFromJson);

  const [error, setError] = useState<string | null>(null);
  const [saveName, setSaveName] = useState("");

  const editing = draft != null;
  const working = (draft ?? activeDoc) as ThemeDocument | null;

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
    for (const [tk, ref] of Object.entries(tokens)) {
      if (ref === oldName) tokens[tk] = newName;
    }
    updateDraftPalette(palette);
    updateDraftTokens(tokens);
  };

  const removePaletteEntry = (name: string) => {
    if (!draft) startEditing();
    const current = (draft ?? activeDoc)!;
    const palette = { ...current.palette };
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

  const setTokenBinding = (token: string, paletteRef: string) => {
    if (!draft) startEditing();
    const current = (draft ?? activeDoc)!;
    updateDraftTokens({ ...current.tokens, [token]: paletteRef });
  };

  const onSave = async () => {
    setError(null);
    if (!draft) return;
    const name = saveName.trim() || draft.name;
    if (!name) {
      setError("Theme name is required");
      return;
    }
    const result = validateTheme({ ...draft, name });
    if (!result.ok) {
      setError(result.errors.map((e) => `${e.field}: ${e.message}`).join("\n"));
      return;
    }
    try {
      await saveDraftAs(name);
      setSaveName("");
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
    if (!window.confirm(`Delete theme "${name}"?`)) return;
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
                {t.name}
              </option>
            ))}
          </select>
        </label>
        {!editing ? (
          <button onClick={startEditing}>Edit</button>
        ) : (
          <button onClick={cancelEditing}>Cancel</button>
        )}
        <button onClick={onImport}>Import…</button>
        <button onClick={onExport}>Export…</button>
        {activeName && isUserTheme(activeName) && (
          <button className="danger" onClick={() => onDeleteUserTheme(activeName)}>
            Delete
          </button>
        )}
      </div>
      <div className="legit-panel__body">
        {error && <pre className="legit-error">{error}</pre>}

        {editing && (
          <div
            style={{
              display: "flex",
              gap: 6,
              alignItems: "center",
              padding: "6px 0",
              marginBottom: 12,
              borderBottom: "1px solid var(--panel-border)",
            }}
          >
            <input
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              placeholder={`Save as… (default: ${draft?.name ?? ""})`}
              style={{ flex: 1 }}
            />
            <button className="primary" onClick={onSave} disabled={!draftDirty && !saveName.trim()}>
              Save
            </button>
          </div>
        )}

        <SectionTitle>Metadata</SectionTitle>
        <div style={{ display: "grid", gap: 6, gridTemplateColumns: "120px 1fr", marginBottom: 12 }}>
          <label>Name</label>
          <input
            value={working.name}
            onChange={(e) => editing && updateDraftMeta({ name: e.target.value })}
            disabled={!editing}
          />
          <label>Author</label>
          <input
            value={working.author ?? ""}
            onChange={(e) => editing && updateDraftMeta({ author: e.target.value })}
            disabled={!editing}
          />
          <label>Description</label>
          <input
            value={working.description ?? ""}
            onChange={(e) => editing && updateDraftMeta({ description: e.target.value })}
            disabled={!editing}
          />
        </div>

        <SectionTitle>Contrast (WCAG)</SectionTitle>
        <div style={{ marginBottom: 12 }}>
          {CONTRAST_PAIRS.map((pair) => {
            const fgPal = working.tokens[pair.fg];
            const bgPal = working.tokens[pair.bg];
            const fg = fgPal && working.palette[fgPal];
            const bg = bgPal && working.palette[bgPal];
            const ratio = fg && bg ? contrastRatio(fg, bg) : null;
            const badge = wcagBadge(ratio);
            return (
              <div
                key={pair.label}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "2px 0",
                }}
              >
                <span
                  style={{
                    background: `var(--${pair.bg.replace(/\./g, "-")})`,
                    color: `var(--${pair.fg.replace(/\./g, "-")})`,
                    padding: "2px 8px",
                    borderRadius: 3,
                    minWidth: 100,
                    textAlign: "center",
                  }}
                >
                  Sample
                </span>
                <span style={{ flex: 1 }}>{pair.label}</span>
                <span className="legit-subtle">{ratio ? ratio.toFixed(2) : "—"}</span>
                <span className={badge === "Fail" ? "legit-error" : "legit-success"}>{badge}</span>
              </div>
            );
          })}
        </div>

        <SectionTitle>Palette</SectionTitle>
        <PaletteEditor
          palette={working.palette}
          contractNames={new Set(PALETTE_CONTRACT.map((p) => p.name))}
          disabled={!editing}
          onChange={setPaletteValue}
          onRename={renamePaletteEntry}
          onRemove={removePaletteEntry}
          onAdd={addPaletteEntry}
        />

        <SectionTitle>Tokens</SectionTitle>
        {groups.map(([group, tokens]) => (
          <div key={group} style={{ marginBottom: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>{group}</div>
            {tokens.map((t) => {
              const current = working.tokens[t.name];
              const color = current ? working.palette[current] : undefined;
              return (
                <div
                  key={t.name}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr 24px",
                    alignItems: "center",
                    gap: 6,
                    padding: "2px 0",
                  }}
                  title={t.documentation}
                >
                  <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}>
                    {t.name}
                  </span>
                  <select
                    value={current ?? ""}
                    onChange={(e) => setTokenBinding(t.name, e.target.value)}
                    disabled={!editing}
                  >
                    {Object.keys(working.palette).map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
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
      </div>
    </div>
  );
}

interface PaletteEditorProps {
  palette: Record<string, string>;
  contractNames: Set<string>;
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
          contract={p.contractNames.has(name)}
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
  contract: boolean;
  disabled: boolean;
  onChange: (name: string, value: string) => void;
  onRename: (oldName: string, newName: string) => void;
  onRemove: (name: string) => void;
}

function PaletteRow(p: PaletteRowProps) {
  const [rename, setRename] = useState(p.name);
  return (
    <div className="palette-row">
      <input
        className="palette-row__name"
        value={rename}
        disabled={p.disabled || p.contract}
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
      <input
        type="color"
        className="palette-row__picker"
        disabled={p.disabled}
        value={hexForPicker(p.value)}
        onChange={(e) => p.onChange(p.name, e.target.value)}
      />
      <button
        className="palette-row__delete"
        disabled={p.disabled || p.contract}
        title={p.contract ? "Required palette entry — cannot remove" : "Remove palette colour"}
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

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        textTransform: "uppercase",
        letterSpacing: 0.5,
        color: "var(--subtle-fg)",
        marginBottom: 6,
        marginTop: 4,
      }}
    >
      {children}
    </div>
  );
}
