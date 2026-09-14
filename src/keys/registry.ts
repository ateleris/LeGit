import { toggleMaximizeActivePanel } from "../store/dockview";
import type { Keymap } from "./keymap";

/**
 * Command registry (design/2026-08-24-keyboard-shortcuts-system.md §1).
 * Every nameable action is a declared Command; the keymap, tooltips, the
 * Keyboard Shortcuts panel and the future palette are all generated from it.
 *
 * Command ids are a USER-FACING CONTRACT (persisted keymaps reference them):
 * adding is safe; renaming or removing breaks user keymaps silently. A rename
 * lands with an entry in COMMAND_ID_ALIASES, applied when a user keymap loads.
 * Enforced by registry.test.ts.
 */

export type Scope = "global" | "repo" | `panel:${string}`;

export interface KeyContext {
  repoActive: boolean;
  focusPanel: string | null;
}

export interface Command {
  id: string;
  title: string;
  scope: Scope;
  /** Canonical chord strings; [] = command exists, no default key. */
  defaultBinding: readonly string[];
  /** Runtime gate within the scope; never part of conflict detection. */
  when?: (ctx: KeyContext) => boolean;
  /** May fire while a text input has focus (§4 input guard). */
  allowInInput?: boolean;
  run: (ctx: KeyContext) => void;
}

/** old id -> current id, applied when a user keymap loads. Append-only. */
export const COMMAND_ID_ALIASES: Readonly<Record<string, string>> = {};

export const COMMANDS: readonly Command[] = [
  {
    id: "panel.toggleMaximize",
    title: "Maximize panel",
    scope: "global",
    defaultBinding: ["Mod+Shift+M"],
    run: () => {
      toggleMaximizeActivePanel();
    },
  },
];

export function defaultKeymap(): Keymap {
  return Object.fromEntries(COMMANDS.map((c) => [c.id, c.defaultBinding]));
}

export function commandById(id: string): Command | undefined {
  return COMMANDS.find((c) => c.id === id);
}
