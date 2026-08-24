# Keyboard shortcuts system

Status: proposed 2026-08-24 (approach discussed with Simon in session; this
note is the agreed plan). Replaces the survey-only backlog entry from
2026-08-19. First user demand: issue
[#21](https://github.com/ateleris/LeGit/issues/21) (Ctrl+A select-all in
Working Changes), filed one day after going public.

## Starting point (2026-08-19 survey)

The app has no global shortcuts, no native menu accelerators, no command
palette, no configurable keymap. Every key handler is local, focus-scoped,
and hard-coded inline (~25 sites): Enter-submit in forms, Enter/Esc inline
renames, Esc-dismiss in six overlays (two menus lack it), Commits
type-to-jump (+ Alt+arrows), full arrow-nav in the shared FileTree, Console
history/Ctrl+C/pager keys, Ctrl+S in editable CodeMirror panes. One true
global shortcut exists (Ctrl+Shift+M maximize). Escape handling is
first-come-first-served across overlays instead of arbitrated.

## Goals

- One arbitration point for all shortcut keydowns (fixes the Escape
  overload; makes conflicts impossible by construction).
- Commands as data, keys as data: enables tooltips, a generated help
  overlay, and later user remapping + a command palette without rework.
- Never fight text editing: typing in an input must behave like every
  other desktop app.
- Testable as pure functions, enforced by a contract test.

Non-goals (v1): multi-chord sequences (Ctrl+K Ctrl+S), user remapping UI,
command palette, vim mode. The design must not preclude the first three.

## Architecture

Commands first, keys second - three separated layers plus a dispatcher.

### 1. Command registry (`src/keys/registry.ts`)

Every action is a declared `Command`, analogous to the panel registry:

```ts
interface Command {
  id: string;              // "repo.fetch", "workingChanges.selectAll"
  title: string;           // "Fetch" - tooltip / help overlay / palette text
  scope: "global" | "repo" | `panel:${PanelId}`;
  defaultBinding: Chord | null;  // null = command exists, no default key
  when?: (ctx: KeyContext) => boolean;  // fine-grained gate within the scope
  allowInInput?: boolean;  // may fire while a text input has focus
  run: (ctx: KeyContext) => void;  // resolves stores/summons at dispatch time
}
```

`scope: "repo"` = needs an active repo (disabled otherwise); `panel:` =
only while that panel owns focus.

### 2. Keymap

A plain `commandId -> chord` map, shipped as defaults. Because it is data:

- Tooltips and menu entries render the binding automatically
  ("Fetch  Ctrl+Shift+F") via one shared formatter.
- A help overlay (Mod+/) is GENERATED from the registry - never
  hand-maintained.
- Phase 3 remapping = a user JSON file merged over the defaults,
  validated on load (the `.legit-theme.json` playbook).

Chords are stored platform-neutral (`"Mod+Shift+F"`); `Mod` renders/matches
as Ctrl on Windows/Linux and Cmd on macOS, decided in exactly one place.

### 3. Dispatcher + context stack

One window-level `keydown` listener in capture phase. Resolution walks the
active context stack top-down; the first context claiming the chord wins:

```
dialog  >  menu/popover  >  focused panel  >  repo  >  global
```

- Overlays/dialogs push a layer onto a dismissable stack on mount and pop
  on unmount. Escape always closes exactly the topmost layer. This stack
  is shared infrastructure with the planned `useDismissable` from the
  v1.1.0 frontend-consolidation batch: build them together.
- Panels contribute their `panel:` scope while focused (tracked from
  dockview's active panel + DOM focus).
- The resolver is a pure function:
  `resolve(chord, contextStack, keymap) -> commandId | null`.

### 4. Input guard

When focus is in an input, textarea, contenteditable, or CodeMirror
editor, only bindings with `allowInInput: true` fire (Mod+Enter, Esc,
F-keys). Plain keys and single letters never do, and native text-editing
vocabulary (Mod+C/V/X/A/Z...) is never intercepted there. CodeMirror panes
keep their own keymaps; the dispatcher competes only for allowlisted
chords.

## Default bindings (v1 seed set)

### Global / repo scope

| Chord | Command | Rationale |
| --- | --- | --- |
| Mod+Enter | Commit | universal composer convention; `allowInInput` (works from the message box) |
| Mod+Shift+F | Fetch | Fork/Tower convention |
| Mod+Shift+L | Pull | pu**ll** |
| Mod+Shift+P | Push | SourceTree/Tower convention - see open question below |
| F5 | Refresh repo data | platform convention (block the WebView's own reload in prod builds) |
| Mod+1..9 | Activate repo tab N | browser convention |
| Ctrl+Tab / Ctrl+Shift+Tab | Next / previous repo tab | browser convention |
| Mod+Shift+M | Maximize panel | already shipped; migrates into the registry unchanged |
| Mod+, | Global Settings | desktop convention |
| Mod+F | Find in focused panel | diff/file view: enable CodeMirror `searchKeymap`; Commits: focus the search bar |
| F1 | Shortcuts help overlay | discoverability; overlay content generated from the registry; layout-independent (Mod+/ rejected, see key-choice guidelines) |
| Esc | Dismiss topmost layer | unified via the dismissable stack |

### Panel scope

Commits:

| Chord | Command |
| --- | --- |
| ArrowUp/ArrowDown | Row navigation (the survey's most glaring gap; coexists with type-to-jump) |
| Enter | Open Commit Details for the selected row |
| Mod+C | Copy selected commit SHA (list focused, not in an input) |
| Menu key / Shift+F10 | Open the row context menu |

Working Changes:

| Chord | Command |
| --- | --- |
| ArrowUp/ArrowDown | Navigate file rows |
| Space | Stage/unstage the selected files |
| Mod+A | Select all files in the focused list (issue #21, see below) |
| Del | Discard selected (through the central confirm dialog, respecting the confirm-destructive setting) |
| Enter | Open the diff for the selected file |

Refs:

| Chord | Command |
| --- | --- |
| F2 | Inline rename (drives the existing `InlineRenameInput`) |
| Del | Delete selected ref (central confirm) |

Diff:

| Chord | Command |
| --- | --- |
| Alt+ArrowDown/ArrowUp | Next / previous hunk |

Rules of thumb encoded above: single letters only in focused-list contexts
(and even then v1 sticks to Space/arrows/F-keys); F2/F5/Del/Menu-key follow
platform conventions; nothing overrides OS text editing.

### Key-choice guidelines (layout independence)

Bindings must work on non-US layouts - German QWERTZ is the reference
check (Simon's layout). Concretely:

- Allowed chord keys: letters, digits, F-keys, arrows, Enter, Space,
  Tab, Escape, Delete, Backspace, comma, period, plus/minus.
- Avoid punctuation that moves across layouts or hides behind
  Shift/AltGr there: `/` (Shift+7 on QWERTZ), `[ ] { } \ | @ ~` (AltGr),
  `; ' \``. A chord like Mod+/ silently becomes a three-key contortion.
- Never use AltGr (right Alt) in a chord: on Windows it reports as
  Ctrl+Alt, so an AltGr character chord is ambiguous with Ctrl+Alt
  bindings.
- Matching uses `KeyboardEvent.key` (character-based, layout-aware), so
  letter chords follow the user's layout the way OS shortcuts do - which
  is exactly why punctuation chords are unreliable and stay banned.
- The contract test enforces the allowed-key list, so a layout-hostile
  default cannot land unnoticed.

### Issue #21: Ctrl+A in Working Changes

`workingChanges.selectAll` selects every file in the focused list. The
panel's `Selection { section, paths }` model already supports it (the
command is a state update). Semantics:

- In a text input (commit message), Mod+A stays native select-all - the
  input guard handles this with no special case.
- With a file list focused: select all in that list.
- With neither list focused: if a selection already lives in a section,
  select all there; otherwise default to the UNSTAGED list (staging is the
  dominant flow, and "Ctrl+A then Space" = stage everything).

Dependency pulled into phase 1: the two lists must be real focus targets
(container `tabindex` + which-section-owns-focus tracking) so "focused
list" is answerable. Full roving tabindex on rows stays phase 2.

## What stays OUT of the registry

Focus-local input behavior that a user would not name as an action:
Enter/Esc in inline renames, Enter-submit in forms, Console
history/pager keys, FileTree arrow-walking, CodeMirror editing keys.
These remain local handlers; routing them through a global dispatcher adds
indirection for zero benefit. The registry holds nameable actions - which
is exactly the future palette/remap surface.

## Testing

- `resolve()` unit tests: priority order, input guard, `when` gates,
  platform Mod mapping, Escape topmost-layer selection.
- Registry contract test (theme-contract style): no two commands in
  overlapping contexts share a chord; every `defaultBinding` parses; every
  panel scope names a real panel id.
- Existing behaviors that migrate (Ctrl+Shift+M, overlay Escape) get their
  bindings asserted so the migration cannot silently drop them.
- E2E: at most one smoke spec (e.g. Mod+Enter commits) - the unit seam
  covers the logic.

## Phasing

1. **Phase 1** - registry, dispatcher, context/dismissable stack, input
   guard, platform formatter; seed bindings above (incl. #21); Escape
   unification; tooltip labels; generated help overlay; resolver +
   contract tests. Roughly one focused session.
2. **Phase 2** - focus-management debt: roving tabindex on panel lists,
   focus trap in dialogs, keyboard hunk staging in the diff (needs a
   focused-hunk concept), Working Changes/Interactive Rebase keyboard
   coverage.
3. **Phase 3** (demand-driven) - user keymap file (validated, collisions
   surfaced in settings) and a command palette (Mod+Shift+P or Mod+P;
   both are nearly free once commands are data).

## Open question

Mod+Shift+P is contested: SourceTree/Tower use it for Push, VS Code/Zed
for the command palette. v1 gives it to Push (palette does not exist yet).
If phase 3 adds the palette, either the palette takes Mod+P or Push moves;
decide then - remapping is data by that point.
