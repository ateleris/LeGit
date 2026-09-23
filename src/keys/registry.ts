import { summonGlobalPanel } from "../layout/globalSummon";
import { formatAppError } from "../lib/errors";
import { toggleMaximizeActivePanel } from "../store/dockview";
import { useLayoutsStore } from "../store/layouts";
import { notify } from "../store/notifications";
import { useRepoStore } from "../store/repos";
import { hasCommandAction, runCommandAction } from "./actions";
import type { Keymap } from "./keymap";
import { stepRepoTab } from "./repoTabCycle";

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
  /**
   * "widget": the owning widget matches the chord itself (only while it has
   * focus), so plain keys never get stolen from focused buttons/trees; the
   * dispatcher skips the command, the panel still lists and rebinds it.
   */
  handledBy?: "widget";
  run: (ctx: KeyContext) => void;
}

/** old id -> current id, applied when a user keymap loads. Append-only. */
export const COMMAND_ID_ALIASES: Readonly<Record<string, string>> = {};

/** A command performed by a handler a mounted surface registers (actions.ts):
 * inert while that surface is closed. */
function delegated(
  id: string,
  title: string,
  scope: Scope,
  defaultBinding: readonly string[],
  allowInInput?: boolean,
): Command {
  return {
    id,
    title,
    scope,
    defaultBinding,
    allowInInput,
    when: () => hasCommandAction(id),
    run: () => {
      runCommandAction(id);
    },
  };
}

function activateRepoTab(index: number): void {
  const { openRepos, setActive } = useRepoStore.getState();
  const repo = openRepos[index];
  if (repo) setActive(repo.id);
}

export const LAYOUT_SHORTCUT_SLOTS = 9;

// Deliberately unbound: every modifier+digit default composes differently
// per layout (Shift+1 is "!" on German, "+" on Swiss; Ctrl+Alt is AltGr) -
// users bind their own key, and capture records their layout's spelling.
const layoutCommands: Command[] = Array.from({ length: LAYOUT_SHORTCUT_SLOTS }, (_, i) => ({
  id: `app.applyLayout${i + 1}`,
  title: `Apply saved layout ${i + 1}`,
  scope: "global" as const,
  defaultBinding: [],
  when: () => useLayoutsStore.getState().layouts.length > i,
  run: () => {
    const { layouts, apply } = useLayoutsStore.getState();
    const name = layouts[i]?.name;
    if (!name) return;
    apply(name).catch((e) => notify.error(formatAppError(e)));
  },
}));

const repoTabCommands: Command[] = Array.from({ length: 9 }, (_, i) => ({
  id: `app.repoTab${i + 1}`,
  title: `Go to repository tab ${i + 1}`,
  scope: "global" as const,
  defaultBinding: [`Mod+${i + 1}`],
  allowInInput: true,
  when: () => useRepoStore.getState().openRepos.length > i,
  run: () => activateRepoTab(i),
}));

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
  // Deliberately unbound: the git actions and panel summons get no default
  // key; users who want one bind it in the Keyboard Shortcuts panel.
  delegated("repo.fetch", "Fetch", "repo", []),
  delegated("repo.pull", "Pull", "repo", []),
  delegated("repo.push", "Push", "repo", []),
  delegated("repo.commit", "Commit", "repo", [], true),
  delegated("repo.refresh", "Refresh repository data", "repo", ["F5"], true),
  {
    id: "app.globalSettings",
    title: "Global Settings",
    scope: "global",
    defaultBinding: [],
    run: () => summonGlobalPanel("global-settings"),
  },
  {
    id: "app.keyboardShortcuts",
    title: "Keyboard Shortcuts",
    scope: "global",
    defaultBinding: [],
    allowInInput: true,
    run: () => summonGlobalPanel("keyboard-shortcuts"),
  },
  {
    id: "app.nextRepoTab",
    title: "Recently used repository tab",
    scope: "global",
    defaultBinding: ["Ctrl+Tab"],
    allowInInput: true,
    when: () => useRepoStore.getState().openRepos.length > 1,
    run: () => stepRepoTab(1),
  },
  {
    id: "app.prevRepoTab",
    title: "Recently used repository tab (reverse)",
    scope: "global",
    defaultBinding: ["Ctrl+Shift+Tab"],
    allowInInput: true,
    when: () => useRepoStore.getState().openRepos.length > 1,
    run: () => stepRepoTab(-1),
  },
  // Issue #21. In a text input Mod+A stays native select-all: the input guard
  // reserves the text-editing vocabulary, no special case needed.
  delegated("workingChanges.selectAll", "Select all files in the focused list", "panel:working-changes", ["Mod+A"]),
  delegated(
    "workingChanges.discardSelected",
    "Discard selected files",
    "panel:working-changes",
    ["Delete"],
  ),
  {
    id: "workingChanges.toggleStage",
    title: "Stage or unstage the selected files",
    scope: "panel:working-changes",
    defaultBinding: ["Space"],
    handledBy: "widget",
    // Matched and executed by the focused FileTree (toggleStageChords);
    // registered here so the panel lists it and rebinds apply live.
    run: () => {},
  },
  ...repoTabCommands,
  ...layoutCommands,
];

export function defaultKeymap(): Keymap {
  return Object.fromEntries(COMMANDS.map((c) => [c.id, c.defaultBinding]));
}

export function commandById(id: string): Command | undefined {
  return COMMANDS.find((c) => c.id === id);
}
