import { hasBlockingLayer, type Layer } from "../store/layers";
import { parseChord } from "./chord";
import type { Command } from "./registry";

/**
 * Pure chord -> command resolution
 * (design/2026-08-24-keyboard-shortcuts-system.md §3-§4). Escape is handled
 * by the layer stack before this runs; `when` gates dispatch afterwards.
 */

export interface ResolveInput {
  commands: readonly Command[];
  /** Reverse index of the effective keymap (keymap.ts reverseIndex). */
  byChord: ReadonlyMap<string, readonly string[]>;
  layers: readonly Layer[];
  focusPanel: string | null;
  repoActive: boolean;
  editableTarget: boolean;
}

/** Chords the app never claims while a text input has focus. */
const TEXT_EDITING_CHORDS = new Set([
  "Mod+A",
  "Mod+C",
  "Mod+V",
  "Mod+X",
  "Mod+Z",
  "Mod+Y",
  "Mod+Shift+Z",
  "Mod+Shift+V",
]);

const SCOPE_PRIORITY = { panel: 0, repo: 1, global: 2 } as const;

export function resolve(chord: string, input: ResolveInput): Command | null {
  if (hasBlockingLayer(input.layers)) return null;
  if (input.editableTarget && !allowedInInput(chord)) return null;

  const candidateIds = input.byChord.get(chord);
  if (!candidateIds) return null;

  const byId = new Map(input.commands.map((c) => [c.id, c]));
  let best: Command | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const id of candidateIds) {
    const cmd = byId.get(id);
    if (!cmd) continue;
    if (input.editableTarget && !cmd.allowInInput) continue;
    const rank = scopeRank(cmd, input);
    if (rank !== null && rank < bestRank) {
      best = cmd;
      bestRank = rank;
    }
  }
  return best;
}

function scopeRank(cmd: Command, input: ResolveInput): number | null {
  if (cmd.scope === "global") return SCOPE_PRIORITY.global;
  if (cmd.scope === "repo") return input.repoActive ? SCOPE_PRIORITY.repo : null;
  const panelId = cmd.scope.slice("panel:".length);
  return input.focusPanel === panelId ? SCOPE_PRIORITY.panel : null;
}

/**
 * §4: in an editable target only modified chords or F-keys may fire - plain
 * keys and single letters never do - and the native text-editing vocabulary
 * is never claimable.
 */
function allowedInInput(chord: string): boolean {
  if (TEXT_EDITING_CHORDS.has(chord)) return false;
  const p = parseChord(chord);
  if (!p) return false;
  if (p.mod || p.ctrl || p.alt) return true;
  return /^F\d+$/.test(p.key);
}
