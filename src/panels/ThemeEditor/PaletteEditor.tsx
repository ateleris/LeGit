import { useEffect, useRef, useState } from "react";

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

export function PaletteEditor(p: PaletteEditorProps) {
  return (
    <div style={{ marginBottom: "1em" }}>
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
      <button onClick={p.onAdd} disabled={p.disabled} style={{ marginTop: "0.333em" }}>
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
