import { loadKeybindings, saveKeybindings } from "../lib/commands";
import { formatAppError } from "../lib/types";
import { notify } from "../store/notifications";
import { normalizeChord } from "./chord";
import { useKeymapStore, type Keymap } from "./keymap";
import { COMMAND_ID_ALIASES, defaultKeymap } from "./registry";

/**
 * Load/save glue between the keymap store and `keybindings.json`
 * (design/2026-08-24-keyboard-shortcuts-system.md, Persistence). The file
 * stores the DIFF from the shipped defaults; command renames are healed on
 * load via the append-only alias table.
 */

export const KEYBINDINGS_VERSION = 1;

/** Rename aliased command ids in a loaded diff. An entry already present
 * under the new id wins over the aliased old one. */
export function applyCommandAliases(
  diff: Keymap,
  aliases: Readonly<Record<string, string>>,
): Keymap {
  const out: Record<string, readonly string[]> = {};
  for (const [id, chords] of Object.entries(diff)) {
    const target = aliases[id] ?? id;
    if (target !== id && target in diff) continue;
    out[target] = chords;
  }
  return out;
}

/** Reset the store to the shipped defaults, then overlay the persisted user
 * diff. An unreadable file is reported and ignored - never reset on disk. */
export async function initKeymap(): Promise<void> {
  useKeymapStore.getState().reset(defaultKeymap());
  try {
    const file = await loadKeybindings();
    const diff = applyCommandAliases(file.bindings, COMMAND_ID_ALIASES);
    useKeymapStore.getState().setDiff(diff);
  } catch (e) {
    notify.error(`Could not load keybindings: ${formatAppError(e)}`);
  }
}

export type KeybindingsImport = { ok: true; diff: Keymap } | { ok: false; error: string };

/**
 * Validate an imported keybindings file (the same diff-based format as
 * `keybindings.json`). Strict on shape and chord syntax - a broken file is
 * refused whole, never partially applied - while unknown command ids are
 * kept (they may belong to a newer or older LeGit).
 */
export function parseKeybindingsImport(text: string): KeybindingsImport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `not valid JSON: ${(e as Error).message}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "not a keybindings file (expected an object)" };
  }
  const { version, bindings } = parsed as { version?: unknown; bindings?: unknown };
  if (typeof version !== "number" || version > KEYBINDINGS_VERSION) {
    return { ok: false, error: `unsupported keybindings version: ${String(version)}` };
  }
  if (typeof bindings !== "object" || bindings === null || Array.isArray(bindings)) {
    return { ok: false, error: "not a keybindings file (missing bindings map)" };
  }
  const diff: Record<string, string[]> = {};
  for (const [id, chords] of Object.entries(bindings)) {
    if (!Array.isArray(chords)) {
      return { ok: false, error: `bindings for "${id}" must be an array of chords` };
    }
    const normalized: string[] = [];
    for (const chord of chords) {
      const canonical = typeof chord === "string" ? normalizeChord(chord) : null;
      if (!canonical) {
        return { ok: false, error: `invalid chord for "${id}": ${JSON.stringify(chord)}` };
      }
      normalized.push(canonical);
    }
    diff[id] = normalized;
  }
  return { ok: true, diff };
}

/** Apply a new diff to the store and persist it eagerly. */
export async function setAndPersistDiff(diff: Keymap): Promise<void> {
  useKeymapStore.getState().setDiff(diff);
  try {
    await saveKeybindings({
      version: KEYBINDINGS_VERSION,
      bindings: Object.fromEntries(
        Object.entries(diff).map(([id, chords]) => [id, [...chords]]),
      ),
    });
  } catch (e) {
    notify.error(`Could not save keybindings: ${formatAppError(e)}`);
  }
}
