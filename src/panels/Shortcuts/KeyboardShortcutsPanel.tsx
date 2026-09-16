import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { captureChord, formatChord } from "../../keys/chord";
import { findConflicts } from "../../keys/conflicts";
import { diffFromDefaults, useKeymapStore, type Keymap } from "../../keys/keymap";
import {
  KEYBINDINGS_VERSION,
  applyCommandAliases,
  parseKeybindingsImport,
  setAndPersistDiff,
} from "../../keys/persistence";
import { COMMANDS, COMMAND_ID_ALIASES, type Command, type Scope } from "../../keys/registry";
import { confirmDialog } from "../../store/confirm";
import { useLayer } from "../../store/layers";
import { notify } from "../../store/notifications";
import { useConfirmDestructive } from "../../store/settings";

/**
 * The Keyboard Shortcuts panel (design/2026-08-24-keyboard-shortcuts-system.md):
 * GENERATED from the command registry, never hand-maintained. Searchable,
 * grouped by scope; every row edits its bindings in place via press-a-key
 * capture. Hard conflicts (same scope) are refused or resolved by unbinding
 * the other command; cross-scope shadowing is a hint, not an error.
 */

const SCOPE_ORDER: Scope[] = ["global", "repo"];

function scopeTitle(scope: Scope): string {
  if (scope === "global") return "Global";
  if (scope === "repo") return "Repository";
  return scope.slice("panel:".length);
}

const chipStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.333em",
  padding: "0.1em 0.5em",
  background: "var(--input-bg)",
  border: "1px solid var(--panel-border)",
  borderRadius: 4,
  fontSize: "var(--fz-sm)",
  whiteSpace: "nowrap",
};

const ghostButton: React.CSSProperties = {
  background: "none",
  border: "none",
  padding: 0,
  cursor: "pointer",
  color: "var(--subtle-fg)",
  fontSize: "var(--fz-sm)",
};

export function KeyboardShortcutsPanel() {
  const defaults = useKeymapStore((s) => s.defaults);
  const diff = useKeymapStore((s) => s.diff);
  const effective = useKeymapStore((s) => s.effective);
  const confirmDestructive = useConfirmDestructive();
  const [query, setQuery] = useState("");
  /** Command id currently recording a new key, if any. */
  const [capturing, setCapturing] = useState<string | null>(null);

  const apply = useCallback(
    (newEffective: Keymap) => {
      void setAndPersistDiff(diffFromDefaults(defaults, newEffective));
    },
    [defaults],
  );

  const removeChord = (id: string, chord: string) =>
    apply({ ...effective, [id]: (effective[id] ?? []).filter((c) => c !== chord) });

  const resetCommand = (id: string) => {
    const next = { ...diff } as Record<string, readonly string[]>;
    delete next[id];
    void setAndPersistDiff(next);
  };

  const onCaptured = async (id: string, chord: string) => {
    setCapturing(null);
    const { hard } = findConflicts(chord, id, COMMANDS, effective);
    const withChord = (base: Keymap): Keymap => ({
      ...base,
      [id]: [...(base[id] ?? []).filter((c) => c !== chord), chord],
    });
    if (hard.length > 0) {
      const ok = await confirmDialog({
        title: "Shortcut conflict",
        message: `${formatChord(chord)} is already bound to "${hard[0].title}" in the same scope.`,
        confirmLabel: "Rebind and unbind other",
        danger: false,
      });
      if (!ok) return;
      const cleared: Record<string, readonly string[]> = { ...effective };
      for (const other of hard) {
        cleared[other.id] = (cleared[other.id] ?? []).filter((c) => c !== chord);
      }
      apply(withChord(cleared));
      return;
    }
    apply(withChord(effective));
  };

  const onResetAll = async () => {
    if (confirmDestructive) {
      const ok = await confirmDialog({
        title: "Reset all shortcuts",
        message: "Reset every shortcut to its default binding?",
        detail: "This also removes bindings saved for unknown commands.",
        confirmLabel: "Reset all",
      });
      if (!ok) return;
    }
    await setAndPersistDiff({});
  };

  const onExport = async () => {
    try {
      const path = await saveDialog({
        defaultPath: "legit-keybindings.json",
        filters: [{ name: "LeGit Keybindings", extensions: ["json"] }],
      });
      if (!path) return;
      const bindings = Object.fromEntries(
        Object.entries(diff).map(([id, chords]) => [id, [...chords]]),
      );
      await writeTextFile(path, JSON.stringify({ version: KEYBINDINGS_VERSION, bindings }, null, 2));
      notify.success("Keybindings exported");
    } catch (e) {
      notify.error(`Export failed: ${(e as Error).message}`);
    }
  };

  const onImport = async () => {
    try {
      const path = await openDialog({
        multiple: false,
        filters: [{ name: "LeGit Keybindings", extensions: ["json"] }],
      });
      if (typeof path !== "string") return;
      const parsed = parseKeybindingsImport(await readTextFile(path));
      if (!parsed.ok) {
        notify.error(`Cannot import keybindings: ${parsed.error}`);
        return;
      }
      const ok = await confirmDialog({
        title: "Import keybindings",
        message: "Replace your current shortcut customizations with the imported file?",
        confirmLabel: "Import",
        danger: false,
      });
      if (!ok) return;
      await setAndPersistDiff(applyCommandAliases(parsed.diff, COMMAND_ID_ALIASES));
      notify.success("Keybindings imported");
    } catch (e) {
      notify.error(`Import failed: ${(e as Error).message}`);
    }
  };

  const q = query.trim().toLowerCase();
  const matches = (cmd: Command) =>
    q === "" ||
    cmd.title.toLowerCase().includes(q) ||
    cmd.id.toLowerCase().includes(q) ||
    (effective[cmd.id] ?? []).some((c) => formatChord(c).toLowerCase().includes(q));

  const groups = useMemo(() => {
    const scopes = [
      ...SCOPE_ORDER,
      ...[...new Set(COMMANDS.map((c) => c.scope))].filter(
        (s) => !(SCOPE_ORDER as string[]).includes(s),
      ),
    ];
    return scopes
      .map((scope) => ({
        scope,
        commands: COMMANDS.filter((c) => c.scope === scope && matches(c)),
      }))
      .filter((g) => g.commands.length > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, effective]);

  const unknownIds = Object.keys(diff).filter((id) => !COMMANDS.some((c) => c.id === id));

  return (
    <div className="legit-panel" style={{ display: "flex", flexDirection: "column" }}>
      <div className="legit-panel__toolbar" style={{ flexWrap: "wrap" }}>
        <input
          type="text"
          placeholder="Search shortcuts…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ flex: "1 1 12em", minWidth: "8em" }}
        />
        <button onClick={() => void onImport()}>Import…</button>
        <button onClick={() => void onExport()}>Export…</button>
        <button onClick={() => void onResetAll()} disabled={Object.keys(diff).length === 0}>
          Reset all
        </button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "0.333em 0 1em" }}>
        {groups.map(({ scope, commands }) => (
          <section key={scope}>
            <div
              style={{
                padding: "0.667em 0.667em 0.25em",
                fontSize: "var(--fz-sm)",
                textTransform: "uppercase",
                letterSpacing: 0.5,
                color: "var(--subtle-fg)",
              }}
            >
              {scopeTitle(scope)}
            </div>
            {commands.map((cmd) => (
              <CommandRow
                key={cmd.id}
                cmd={cmd}
                chords={effective[cmd.id] ?? []}
                customized={cmd.id in diff}
                capturing={capturing === cmd.id}
                onStartCapture={() => setCapturing(cmd.id)}
                onCancelCapture={() => setCapturing(null)}
                onCaptured={(chord) => void onCaptured(cmd.id, chord)}
                onRemove={(chord) => removeChord(cmd.id, chord)}
                onReset={() => resetCommand(cmd.id)}
                effective={effective}
              />
            ))}
          </section>
        ))}

        {unknownIds.length > 0 && q === "" && (
          <section>
            <div
              style={{
                padding: "0.667em 0.667em 0.25em",
                fontSize: "var(--fz-sm)",
                textTransform: "uppercase",
                letterSpacing: 0.5,
                color: "var(--subtle-fg)",
              }}
            >
              Unknown commands
            </div>
            {unknownIds.map((id) => (
              <div key={id} style={rowStyle}>
                <span className="legit-subtle" style={{ flex: 1, minWidth: 0 }} title={id}>
                  {id} (unknown command - kept for another LeGit version)
                </span>
                <span style={{ display: "flex", gap: "0.333em" }}>
                  {(diff[id] ?? []).map((chord) => (
                    <span key={chord} style={chipStyle}>
                      {formatChord(chord)}
                    </span>
                  ))}
                </span>
                <button style={ghostButton} onClick={() => resetCommand(id)} title="Forget this entry">
                  Remove
                </button>
              </div>
            ))}
          </section>
        )}

        {q === "" && (
          <div
            className="legit-subtle"
            style={{ padding: "1em 0.667em 0", fontSize: "var(--fz-sm)", maxWidth: "48em" }}
          >
            Reserved: Escape always dismisses the topmost dialog, menu or overlay and cannot be
            rebound. Text-editing keys (Ctrl+C/V/X/A/Z) are never intercepted while typing, and
            chords the OS or the WebView consumes never reach LeGit. Focus-local behaviour
            (Enter to submit a form, Enter/Escape in an inline rename, arrow keys inside lists)
            is built in, not a rebindable command.
          </div>
        )}
      </div>
    </div>
  );
}

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.667em",
  padding: "0.25em 0.667em",
  fontSize: "var(--fz-md)",
};

function CommandRow({
  cmd,
  chords,
  customized,
  capturing,
  onStartCapture,
  onCancelCapture,
  onCaptured,
  onRemove,
  onReset,
  effective,
}: {
  cmd: Command;
  chords: readonly string[];
  customized: boolean;
  capturing: boolean;
  onStartCapture: () => void;
  onCancelCapture: () => void;
  onCaptured: (chord: string) => void;
  onRemove: (chord: string) => void;
  onReset: () => void;
  effective: Keymap;
}) {
  // Cross-scope shadowing is legal; surface it as a hint under the row.
  const shadowHints = chords.flatMap((chord) => {
    const { shadows } = findConflicts(chord, cmd.id, COMMANDS, effective);
    return shadows.map(
      (other) =>
        `${formatChord(chord)} is also bound to "${other.title}" (${scopeTitle(other.scope)}); the nearest scope wins.`,
    );
  });

  return (
    <div>
      <div style={rowStyle}>
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }} title={cmd.id}>
          {cmd.title}
        </span>
        <span style={{ display: "flex", gap: "0.333em", alignItems: "center" }}>
          {chords.map((chord) => (
            <span key={chord} style={chipStyle}>
              {formatChord(chord)}
              <button
                style={{ ...ghostButton, lineHeight: 1 }}
                aria-label={`Remove ${formatChord(chord)} from ${cmd.title}`}
                onClick={() => onRemove(chord)}
              >
                ×
              </button>
            </span>
          ))}
          {capturing ? (
            <CaptureBox onCaptured={onCaptured} onCancel={onCancelCapture} />
          ) : (
            <button style={ghostButton} onClick={onStartCapture} aria-label={`Add key for ${cmd.title}`}>
              + Add key
            </button>
          )}
        </span>
        <button
          style={{ ...ghostButton, visibility: customized ? "visible" : "hidden" }}
          onClick={onReset}
          title="Reset to default"
        >
          Reset
        </button>
      </div>
      {shadowHints.map((hint) => (
        <div
          key={hint}
          className="legit-subtle"
          style={{ padding: "0 0.667em 0.25em", fontSize: "var(--fz-sm)" }}
        >
          {hint}
        </div>
      ))}
    </div>
  );
}

/**
 * Press-a-key recording. While armed it is a "capture" layer: the dispatcher
 * stands down and THIS listener swallows every keydown (incl. F5/F12 and
 * Escape, which cancels the capture rather than dismissing anything).
 * Modifier-only presses render a live preview; rejected keys show a visible
 * reason and stay armed; a click elsewhere cancels.
 */
function CaptureBox({
  onCaptured,
  onCancel,
}: {
  onCaptured: (chord: string) => void;
  onCancel: () => void;
}) {
  const [preview, setPreview] = useState<string | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const boxRef = useRef<HTMLSpanElement>(null);
  useLayer(true, "capture", onCancel);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const result = captureChord(e);
      if (result.kind === "pending") {
        setReason(null);
        setPreview(result.preview);
      } else if (result.kind === "cancel") {
        onCancel();
      } else if (result.kind === "rejected") {
        setPreview(null);
        setReason(result.reason);
      } else {
        onCaptured(result.chord);
      }
    };
    // Modifier-only preview resets when the modifiers are released unfinished.
    const onKeyUp = (e: KeyboardEvent) => {
      if (!e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) setPreview(null);
    };
    const onMouseDown = (e: MouseEvent) => {
      if (boxRef.current?.contains(e.target as Node)) return;
      onCancel();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKeyUp, true);
    document.addEventListener("mousedown", onMouseDown, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKeyUp, true);
      document.removeEventListener("mousedown", onMouseDown, true);
    };
  }, [onCaptured, onCancel]);

  return (
    <span
      ref={boxRef}
      style={{
        ...chipStyle,
        borderStyle: "dashed",
        color: reason ? "var(--error-fg)" : "var(--subtle-fg)",
      }}
    >
      {reason ?? preview ?? "Press a key…"}
    </span>
  );
}
