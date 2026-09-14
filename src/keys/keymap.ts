import { create } from "zustand";

/**
 * Keymap data model (design/2026-08-24-keyboard-shortcuts-system.md §2).
 * A keymap maps CommandId -> Chord[] (canonical chord strings). User keymaps
 * persist as DIFFS from the shipped defaults: an absent entry inherits the
 * default, an empty array is explicitly unbound. Unknown command ids are kept,
 * never dropped, so downgrading and upgrading does not destroy bindings.
 */

export type Keymap = Record<string, readonly string[]>;

export function applyKeymapDiff(defaults: Keymap, diff: Keymap): Keymap {
  return { ...defaults, ...diff };
}

export function diffFromDefaults(defaults: Keymap, effective: Keymap): Keymap {
  const diff: Record<string, readonly string[]> = {};
  for (const [id, chords] of Object.entries(effective)) {
    const base = defaults[id];
    if (base === undefined || !sameBindings(base, chords)) diff[id] = chords;
  }
  return diff;
}

function sameBindings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((chord, i) => chord === b[i]);
}

/** chord -> command ids bound to it, in keymap iteration order. */
export function reverseIndex(keymap: Keymap): Map<string, string[]> {
  const idx = new Map<string, string[]>();
  for (const [id, chords] of Object.entries(keymap)) {
    for (const chord of chords) {
      const list = idx.get(chord);
      if (list) list.push(id);
      else idx.set(chord, [id]);
    }
  }
  return idx;
}

interface KeymapStore {
  defaults: Keymap;
  diff: Keymap;
  effective: Keymap;
  byChord: Map<string, string[]>;
  /** Replace the defaults (registry-derived) and clear the diff. */
  reset: (defaults: Keymap) => void;
  setDiff: (diff: Keymap) => void;
}

function derive(defaults: Keymap, diff: Keymap) {
  const effective = applyKeymapDiff(defaults, diff);
  return { defaults, diff, effective, byChord: reverseIndex(effective) };
}

export const useKeymapStore = create<KeymapStore>((set) => ({
  ...derive({}, {}),
  reset: (defaults) => set(derive(defaults, {})),
  setDiff: (diff) => set((s) => derive(s.defaults, diff)),
}));
