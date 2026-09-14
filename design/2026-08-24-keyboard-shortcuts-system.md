# Keyboard shortcuts system

Status: proposed 2026-08-24; revised 2026-09-14 after agreeing that **full
user rebinding is a product goal, not a demand-driven extra**. The revision
keeps the original architecture (commands as data, keys as data, one
dispatcher) and changes three things: the phase order, the keymap data
model, and the addition of a dedicated global panel. Replaces the
survey-only backlog entry from 2026-08-19. First user demand: issue
[#21](https://github.com/ateleris/LeGit/issues/21) (Ctrl+A select-all in
Working Changes), filed one day after going public.

Updated again 2026-09-14 after the frontend-consolidation batch landed:
`useDismissable` now exists (stopPropagation-based) with four of the
surveyed overlay sites routed through it, and the context-menu Escape bug
below is already fixed. Phase 1 is therefore a migration of that hook onto
the layer stack, not a greenfield build; the survey below reflects the
post-batch state.

## Starting point (2026-08-19 survey, updated post-consolidation 2026-09-14)

Nothing of the keys layer is implemented: there is no `src/keys/` and no
layer stack. The app has ~452 `onClick` handlers in `src/panels` (the
eventual size of the nameable-command surface).

The frontend-consolidation batch changed the overlay landscape. The shared
`useDismissable` (`src/panels/shared/useDismissable.ts`) now owns Escape +
click-outside for `Popover`, `CaretDropdown`, `RepoAddMenu`, `ViewMenu` and
`RepoOverflowMenu`; `PanelContextMenu`, `LaneLockIndicator` and `RefsCell`
render through `Popover`. The hook consumes Escape via a per-overlay
`document` bubble listener that calls `stopPropagation`, and marks portaled
submenus with `MENU_LAYER_ATTR` for click-outside insideness.

The sites still registering their own keydown listener:

| Site | Registers | Escape behaviour |
| --- | --- | --- |
| `AppLayout` (Ctrl+Shift+M, maximize) | `window`, bubble | exits maximize when `isUnclaimedEscape` |
| `ConfirmDialogHost` | `document`, **capture** | `stopPropagation` + cancel |
| `AskpassPrompt` / `CredentialPrompt` | `document`, bubble | close |
| `useDismissable` (shared, one per open overlay) | `document`, bubble | `stopPropagation` + close |

Escape is still first-come-first-served, arbitrated by a heuristic
(`isUnclaimedEscape` in `store/dockview.ts`) that infers "nobody else
handled this" from `defaultPrevented` plus the target's tag name, and by
each overlay's listener remembering to call `stopPropagation`.

**Bug this produced (found 2026-09-14, since fixed):** `PanelContextMenu`
did not stop propagation, so pressing Escape to close the commits context
menu while a panel was maximized also un-maximized the panel. Routing the
menu through `Popover`/`useDismissable` fixed it, pinned by the
"maximize-exit contract" test in `useDismissable.test.tsx`; that test must
survive the layer-stack migration. The mechanism is still the heuristic,
though: correctness depends on every overlay calling `stopPropagation`
before `AppLayout`'s listener runs. The layer stack replaces that with
structure ("Escape pops exactly the topmost layer").

The rest is focus-local and stays that way: Enter-submit in ~15 forms,
Enter/Esc inline renames (`InlineRenameInput`), Commits type-to-jump plus
Alt+arrows (`CommitsPanel`), full arrow-nav in the shared `FileTree`,
Console history / Ctrl+C / pager keys, CodeMirror keymaps in `DiffEditor`
and `MergeView`. Multi-select is mouse modifier state
(`CommitsPanel` `modifiers`, `FileTree` `toggle`/`range`), never a keydown,
so the dispatcher cannot affect it.

## Goals

- One arbitration point for all shortcut keydowns (fixes the Escape
  overload; makes conflicts impossible by construction).
- Commands as data, keys as data: tooltips, a generated help surface,
  **user remapping**, and later a command palette, with no rework.
- **Every nameable action is rebindable from a UI**, game-style: a global
  Keyboard Shortcuts panel with press-a-key capture, conflict reporting,
  per-binding reset, and import/export.
- Never fight text editing: typing in an input behaves like every other
  desktop app.
- Testable as pure functions, enforced by a contract test.

Non-goals (v1): multi-chord sequences (Ctrl+K Ctrl+S), command palette,
vim mode. The design must not preclude them; the keymap file format
reserves the space-separated sequence syntax so adding chords later does
not migrate user files.

## Architecture

Commands first, keys second: three separated layers plus a dispatcher.

### 1. Command registry (`src/keys/registry.ts`)

Every action is a declared `Command`, analogous to the panel registry:

```ts
interface Command {
  id: CommandId;           // "repo.fetch", "workingChanges.selectAll"
  title: string;           // "Fetch" - tooltip / panel / palette text
  scope: Scope;            // enumerable, see below
  defaultBinding: Chord[]; // [] = command exists, no default key
  when?: (ctx: KeyContext) => boolean;  // runtime gate within the scope
  allowInInput?: boolean;  // may fire while a text input has focus
  run: (ctx: KeyContext) => void;  // resolves stores/summons at dispatch time
}

type Scope = "global" | "repo" | `panel:${PanelId}`;
```

`scope: "repo"` = needs an active repo (disabled otherwise); `panel:` =
only while that panel owns focus.

**`scope` is enumerable data; `when` is not part of conflict detection.**
Overlap between two arbitrary predicates is undecidable, and the panel
must be able to tell the user "this clashes with X". So conflicts are
computed from `scope` alone, and `when` only ever gates dispatch at
runtime. A command whose availability cannot be expressed as a scope does
not get a rebindable binding.

**Command ids are a user-facing contract**, exactly like `TOKEN_CONTRACT`
in `src/theme/tokens.ts`: user keymaps reference ids, so **adding is safe;
renaming or removing breaks user keymaps silently**. Enforced by the
registry contract test. A rename lands with an alias entry
(`old id -> new id`) applied when a user keymap loads; the alias table is
append-only.

### 2. Keymap (`src/keys/keymap.ts`)

A `CommandId -> Chord[]` map. Four decisions, all load-bearing for the
panel and all cheap only if made now:

1. **Bindings are arrays, not a single chord.** Rebinding UIs need
   primary/secondary bindings, and the panel needs the reverse index
   (`chord -> CommandId[]`) to report conflicts at all. Costs nothing in
   the resolver; changing it later migrates every user file.
2. **The keymap is a reactive store, not a frozen const.** Tooltips and
   menu entries render their binding from it and must re-render when the
   user rebinds.
3. **User keymaps store diffs from the defaults**, not a full snapshot, so
   default changes reach existing users and the file stays legible.
4. **`[]` means explicitly unbound; absent means inherit the default.**
   Without that distinction, clearing a shipped binding silently returns
   on next launch. This is the classic rebinding-file bug.

Because the keymap is data:

- Tooltips and menu entries render the binding automatically
  ("Fetch  Ctrl+Shift+F") via one shared formatter.
- The Keyboard Shortcuts panel is GENERATED from the registry, never
  hand-maintained.

Chords are stored platform-neutral (`"Mod+Shift+F"`); `Mod` renders and
matches as Ctrl on Windows/Linux and Cmd on macOS, decided in exactly one
place (`src/keys/chord.ts`).

### 3. Dispatcher + layer stack

One `window`-level `keydown` listener in **capture** phase
(`src/keys/Dispatcher.tsx`, mounted once), so it runs ahead of every
existing `document` listener including `ConfirmDialogHost`'s capture-phase
one.

The layer stack (`src/store/layers.ts`, zustand, pure logic) holds
`{ id, kind: "dialog" | "menu" | "popover" | "mode", onDismiss }`.
Overlays push on mount and pop on unmount through the existing
`src/panels/shared/useDismissable.ts` (built by the frontend-consolidation
batch), which keeps click-outside but loses its own Escape listener: the
dispatcher pops the stack instead. Migrating that one hook migrates every
`Popover`/`CaretDropdown` consumer at once; the dialogs and prompts
(`ConfirmDialogHost`, `AskpassPrompt`, `CredentialPrompt`) push `"dialog"`
layers directly.

Semantics:

- **Escape pops exactly the topmost layer**, and nothing else - whatever
  its kind.
- **Blocking is per kind.** `"dialog"` and `"menu"` layers block command
  resolution below them (only the topmost layer's own bindings resolve,
  plus Escape): that is what makes a dialog modal to the keyboard, without
  a focus trap. `"popover"` and `"mode"` layers do NOT block: the
  `RefsCell` flyout opens on hover, so a popover must never disable Fetch,
  and a maximized panel must keep every shortcut working.
- **Maximized-panel state pushes a `"mode"` layer.** A menu opened over a
  maximized panel sits above it, so Escape pops only the menu; a second
  Escape un-maximizes. `isUnclaimedEscape` is deleted.
- **A `"mode"` layer yields Escape to an editable target** (Escape in an
  inline rename inside a maximized panel cancels the rename, not the
  maximize); dialog/menu/popover layers do not (Escape in a dialog's
  textarea cancels the dialog, as before).
- **Every visible transient overlay must be a layer**, because the
  capture-phase dispatcher runs before any local `stopPropagation`: the
  Commits quick-jump overlay pushes a `"popover"` layer while visible, so
  Escape dismisses it rather than un-maximizing the panel beneath.
- Below the blocking layers, resolution order is: focused panel, then
  repo, then global. Panel scope comes from dockview's active panel plus
  DOM focus.
- The resolver is a pure function:
  `resolve(chord, layers, focus, keymap) -> CommandId | null` (Escape is
  handled by the stack before resolution, see below).

**Escape is not a rebindable command.** It is a platform dismissal
primitive handled by the stack before command resolution; the panel lists
it as reserved.

### 4. Input guard

When focus is in an input, textarea, select, contenteditable, or a
CodeMirror editor (`.cm-content`), only bindings with `allowInInput: true`
resolve (Mod+Enter, Esc, F-keys). Plain keys and single letters never do,
and native text-editing vocabulary (Mod+C/V/X/A/Z...) is never
intercepted there. CodeMirror panes keep their own keymaps; the dispatcher
competes only for allowlisted chords.

**The load-bearing rule: the dispatcher calls `preventDefault` /
`stopPropagation` only when it actually dispatched a command.** Every
non-match passes through completely untouched. That single rule is what
protects the ~15 Enter-submit handlers, Commits type-to-jump, Console
Ctrl+C and both CodeMirror keymaps at once: a capture-phase listener that
cancels wrongly kills all of them simultaneously, so this is where the
tests concentrate.

## The Keyboard Shortcuts panel

A global panel (`GLOBAL_PANELS` in `src/panels/registry.tsx`, alongside
Theme Editor and Layouts), summoned by F1 and from the View menu.

**It subsumes the help overlay.** The original plan had a generated F1
overlay in phase 1 and a remap UI much later; with the panel, one surface
does both (searchable, grouped by scope, shows every binding, edits it).
Accepted trade-off: a dockview panel is not modal, so "F1, glance, Esc" is
slightly heavier than an overlay would be. Consistency with Theme Editor
and Layouts wins.

Layout: a search box, then commands grouped by scope (Global, Repo, then
one group per panel), each row = title, binding chips, add/clear/reset.

### Key capture

Recording a binding is a mode, and it is the one thing the dispatcher has
no concept of today:

- While armed, capture **swallows every keydown**, including Escape (which
  cancels capture rather than dismissing anything), F5, F12 and the
  WebView's own chords. Implemented as a `"mode"` layer that the
  dispatcher checks before resolution.
- Modifier-only presses do not complete a capture; they render as a live
  preview ("Ctrl+Shift+...").
- Exits on: a complete chord, Escape (cancel), blur, or click elsewhere.
- Dead keys and IME composition are rejected with a visible reason, not
  silently swallowed.

### `key` vs `code`, and what that means for capture

Matching uses `KeyboardEvent.key` (character-based, layout-aware), so
letter chords follow the user's layout the way OS shortcuts do. With a
capture UI this stops being an internal detail: **capture must emit
byte-identical output to what the matcher compares.** The normalizer
(`src/keys/chord.ts`, unit-tested) handles:

- Shift + letter reporting an uppercase `key`.
- Alt + letter composing a character on some layouts.
- AltGr reporting as Ctrl+Alt on Windows, which makes an AltGr chord
  ambiguous with a Ctrl+Alt binding. AltGr chords are rejected at capture.
- Keys whose `key` is a non-ASCII character: fall back to `code` and label
  the chord by what the user pressed.

Consequence for the layout-independence rules below: they constrain
**shipped defaults only**. A user binds whatever their own layout can
produce, because capture records exactly that.

### Conflicts

Computed from the reverse index over `scope` alone:

- **Same scope, same chord = hard conflict.** The panel refuses to leave
  it ambiguous: it offers "rebind anyway and unbind the other" or cancel.
- **Different scope, same chord = legal shadowing**, shown as a hint, not
  an error ("Ctrl+A is also bound globally to X; the Working Changes
  binding wins while that panel has focus"). Enforcing global uniqueness
  the way a game does would be wrong here: scoping is the point.
- The registry contract test enforces the same rule for shipped defaults,
  so a colliding default cannot land.

### Reserved and non-rebindable

The panel states these rather than failing silently:

- Escape (dismissal primitive, see above).
- Chords the OS or the WebView consumes before the app sees them.
- Text-editing vocabulary while an input has focus (Mod+C/V/X/A/Z and
  friends) is never claimable.
- Focus-local behaviour that is not a nameable action (see "What stays
  OUT" below). The panel says so, so nobody hunts for Enter-to-rename.

### Persistence

A single `<app-data>/keybindings.json` (not file-per-entry like themes and
layouts: there is exactly one active keymap), written through a Tauri
command pair following the `.legit-theme.json` playbook in
`commands/persistence.rs`: strict validation on load, unparseable file
reported and ignored rather than silently reset.

- Global only. A per-repo keymap would be surprising; `RepoSettings` is
  about git behaviour.
- Unknown command ids are **kept on save**, not dropped, so downgrading
  and upgrading again does not destroy bindings. The panel surfaces them
  as "unknown command".
- Per-binding reset and reset-all; import/export like themes and layouts.
  An exported file IS a `keybindings.json` (the same diff-based format), so
  export -> import round-trips unchanged and a file shared across machines
  or app versions behaves exactly like an upgrade: absent entries inherit
  the current defaults, unknown ids are kept.

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
| F1 | Keyboard Shortcuts panel | discoverability; generated from the registry; layout-independent (Mod+/ rejected, see key-choice guidelines); verify in a debug build that WebView2 passes F1 through, like the F5 check |
| Esc | Dismiss topmost layer | the layer stack, not a binding |

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

Deferred but already decided (2026-09-07, with named layouts): Ctrl+Alt+1..9
applies the first N saved layouts in list order via `useLayoutsStore.apply`.

Rules of thumb encoded above: single letters only in focused-list contexts
(and even then v1 sticks to Space/arrows/F-keys); F2/F5/Del/Menu-key follow
platform conventions; nothing overrides OS text editing.

### Key-choice guidelines (layout independence)

**These constrain shipped defaults, not user bindings.** Defaults must work
on non-US layouts; German QWERTZ is the reference check (Simon's layout).

- Allowed chord keys: letters, digits, F-keys, arrows, Enter, Space,
  Tab, Escape, Delete, Backspace, comma, period, plus/minus.
- Avoid punctuation that moves across layouts or hides behind
  Shift/AltGr there: `/` (Shift+7 on QWERTZ), `[ ] { } \ | @ ~` (AltGr),
  `` ; ' ` ``. A chord like Mod+/ silently becomes a three-key contortion.
- Never use AltGr (right Alt) in a chord: on Windows it reports as
  Ctrl+Alt, so an AltGr character chord is ambiguous with Ctrl+Alt
  bindings.
- The contract test enforces the allowed-key list, so a layout-hostile
  default cannot land unnoticed.

### Issue #21: Ctrl+A in Working Changes

`workingChanges.selectAll` selects every file in the focused list. The
panel's `Selection { section, paths }` model already supports it (the
command is a state update). Semantics:

- In a text input (commit message), Mod+A stays native select-all: the
  input guard handles this with no special case.
- With a file list focused: select all in that list.
- With neither list focused: if a selection already lives in a section,
  select all there; otherwise default to the UNSTAGED list (staging is the
  dominant flow, and "Ctrl+A then Space" = stage everything).

Dependency: the two lists must be real focus targets (container `tabindex`
+ which-section-owns-focus tracking) so "focused list" is answerable. That
work sits in phase 2 with the rest of focus management, which is why #21
lands there and not in phase 1.

## What stays OUT of the registry

Focus-local input behaviour that a user would not name as an action:
Enter/Esc in inline renames, Enter-submit in forms, Console history/pager
keys, FileTree arrow-walking, CodeMirror editing keys. These remain local
handlers; routing them through a global dispatcher adds indirection for
zero benefit. The registry holds nameable actions, which is exactly the
future palette surface.

This is the asterisk on "rebind everything", so the panel states the line
explicitly: **rebindable = every nameable action; text editing and
intra-widget navigation are primitives.**

## Growing the command surface

Coverage grows on demand rather than as a big-bang migration of ~452
`onClick` sites. One guard rail, because "on demand" otherwise stalls at
three commands: **a new command lands together with its menu or toolbar
entry rendering its binding from the keymap.** Menus are JSX today
(`Commits/menu/RowMenu.tsx` alone has 22 handlers), so each panel's sweep
is the same work the command palette will need anyway. Track the remaining
panels in BACKLOG.

## Testing

- `chord.test.ts`: parse/format round-trip, platform Mod mapping, the
  capture normalizer (Shift-uppercasing, Alt composition, AltGr rejection,
  `code` fallback).
- `resolve.test.ts`: priority order, layer blocking, input guard, `when`
  gates, unbound (`[]`) versus absent.
- `layers.test.ts`: push/pop, out-of-order unmount, Escape pops the
  topmost layer only, and the regression case above (menu over a maximized
  panel: Escape closes the menu and leaves maximize intact).
- Registry contract test (theme-contract style): ids unique and stable
  (alias table covers every rename), no two commands in the same scope
  share a chord, every `defaultBinding` parses and uses only allowed keys,
  every panel scope names a real panel id.
- Keymap file: diff round-trip, unknown ids preserved, invalid file
  rejected without data loss.
- Existing behaviours that migrate (Ctrl+Shift+M, overlay Escape) get
  their bindings asserted so the migration cannot silently drop them; the
  useDismissable "maximize-exit contract" test is rewritten against the
  stack (menu over maximized panel), never deleted.
- E2E: at most one smoke spec (e.g. Mod+Enter commits); the unit seams
  cover the logic.

## Phasing (revised 2026-09-14)

The original plan front-loaded the seed bindings and deferred remapping to
a demand-driven phase 3. Reversed: the infrastructure lands first and is
proven against existing behaviour, then the panel, then breadth.

1. **Phase 1 - dispatcher and arbitration.** Registry, keymap store and
   file format (all four data-model decisions), pure resolver, layer stack,
   input guard, platform formatter. Migrates: `useDismissable` and all its
   consumers onto the stack (its own Escape listener deleted, click-outside
   kept), the dialog/prompt Escape handlers, Ctrl+Shift+M,
   maximize-exit-on-Escape; `isUnclaimedEscape` deleted. Adds no new
   shortcuts and no user-visible change (the context-menu Escape bug is
   already fixed), so no CHANGELOG entry. Success criterion is that every
   local handler listed in the survey still behaves exactly as before,
   pinned by tests.
2. **Phase 2 - the Keyboard Shortcuts panel.** Key capture, conflict
   reporting, reset, persistence, import/export; F1 summons it. The seed
   bindings above land alongside it, since the panel is what makes them
   discoverable and changeable.
3. **Phase 3 - focus management and breadth.** Roving tabindex on panel
   lists (unblocks issue #21's Ctrl+A), keyboard hunk staging in the diff
   (needs a focused-hunk concept), Interactive Rebase coverage, and the
   per-panel command sweep.
4. **Later - command palette.** Nearly free once commands are data; kept
   out of scope so it does not double phase 2's UI work.

## Open question

Mod+Shift+P is contested: SourceTree/Tower use it for Push, VS Code/Zed
for the command palette. v1 gives it to Push (the palette does not exist
yet). If the palette lands, either it takes Mod+P or Push moves; by then
remapping is data and the panel can show the conflict, so this decides
itself.
