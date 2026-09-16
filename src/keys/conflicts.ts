import { reverseIndex, type Keymap } from "./keymap";
import type { Command } from "./registry";

/**
 * Conflict detection for the Keyboard Shortcuts panel, computed from `scope`
 * alone (`when` is undecidable; see the design doc). Same scope + same chord
 * is a HARD conflict the panel refuses to leave ambiguous; a different scope
 * sharing the chord is legal shadowing, shown as a hint.
 */
export interface BindingConflicts {
  hard: Command[];
  shadows: Command[];
}

export function findConflicts(
  chord: string,
  selfId: string,
  commands: readonly Command[],
  keymap: Keymap,
): BindingConflicts {
  const self = commands.find((c) => c.id === selfId);
  const bound = reverseIndex(keymap).get(chord) ?? [];
  const hard: Command[] = [];
  const shadows: Command[] = [];
  for (const id of bound) {
    if (id === selfId) continue;
    const other = commands.find((c) => c.id === id);
    if (!other) continue;
    (other.scope === self?.scope ? hard : shadows).push(other);
  }
  return { hard, shadows };
}
