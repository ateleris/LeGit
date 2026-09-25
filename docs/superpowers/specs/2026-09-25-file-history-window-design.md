# File History in a separate window - design

## Goal

An opt-in mode where showing a file's history opens a real OS window
(SourceTree's "Log Selected" experience) instead of the docked File History
panel: commit list on the left, the file's diff on the right, fully
disconnected from the main window. Requested by a SourceTree user; the docked
behaviour stays the default and is unchanged.

## Requirements (agreed)

1. **Disjointed.** No selection in the main window affects the popup and no
   selection in the popup affects the main window. This includes the repo:
   the window is pinned to the (repo, file, rev) it was summoned for; repo
   tab switches in the main window do not touch it. Data *freshness* is not
   selection sync: the window keeps refreshing from watcher events, so a new
   commit touching the file appears in its list.
2. **Content: history + diff, nothing else.** Left pane lists the commits
   that touched the file (rename-following, paginated, same as the docked
   panel); clicking a row shows that commit's diff of the file in the right
   pane directly, with no changed-files middleman. Only this file is ever
   shown.
3. **Global setting.** A global checkbox (working label: "Open file history
   in a separate window"). Off (default): today's behaviour, byte for byte.
   On: every file-history summon that carries a file opens/focuses a window
   instead of the docked panel.
4. **Sub-window lifetime.** Closing the main window closes all history
   windows; closing a repo closes that repo's history windows. Popups are
   never OS-owned windows (no forced always-above-main), so they can sit on
   another monitor or behind the app; the coupling is lifetime only.

## Decision history (options rejected)

- **Dockview floating groups**: in-window only, cannot leave the app window.
  Rejected by the requester.
- **Dockview popout groups (`addPopoutGroup`)**: implemented via
  `window.open` with a scriptable same-origin child window, which Tauri/wry
  does not provide. Dead on arrival.
- **Detached remote control** (the docked panel in a window, driving the
  main layout over a cross-window summon bridge): superseded by the
  disjointedness requirement, which makes the bridge unnecessary.
- **Full dockview dock inside the popup**: the popup's two panes are fixed,
  so tabs/drag/layout persistence would all be built and then disabled. The
  same library's `SplitviewReact` (already shipped; `PaneviewReact` precedent
  in RefsPanel) gives the resizable two-pane split without dock semantics.
  If the window ever hosts more tools, swapping the shell's splitter for a
  dock is a contained change.

## Architecture

### Window creation and identity (Rust)

- New command `open_file_history_window(repo_id, path, rev)` in
  `src-tauri/src/commands/`: creates or focuses a `WebviewWindow` whose URL
  is `index.html?window=file-history&repo=<id>&path=<enc>&rev=<enc>`.
- **Label** `fh-<repo_hash>-<hash(path + rev)>`: one window per
  (repo, file, rev); re-summoning the same file focuses the existing window,
  different files coexist. Label derivation is a pure function with a unit
  test. `capabilities/default.json` adds the `fh-*` label pattern next to
  `"main"`.
- **Title** set by Rust at creation: `<filename> - History (<repo name>)`,
  plus a `from <rev>` suffix in browse-at-commit mode.
- **Size**: new windows reuse the last-used history-window size, persisted
  as a command-owned `GlobalSettings` field (excluded from
  `patch_global_settings`, like lane locks); fallback default ~1000x650.
- **Lifetime cascades**: `close_repo` closes all `fh-<repo_hash>-*` windows;
  a window-event hook on the builder closes all `fh-*` windows when the main
  window closes. No OS parent/owner relationship.

### Frontend entry and shell

`src/main.tsx` branches on the `window` query param: the main path is
unchanged; `window=file-history` mounts `HistoryWindowShell` instead of
`App`. The shell:

- boots the query client, settings, theme (`applyTheme`), crash logging and
  per-window focus tracking exactly as the main entry does;
- pins the repo context from the URL (no repo store mirroring; the window
  never follows the main window's active repo);
- runs the repo-change listener for its pinned repo, so watcher broadcasts
  (which reach every window) keep its queries fresh;
- hosts its own `ConfirmDialogHost` and toast host (restore confirmation and
  action errors surface inside the popup, near the pointer);
- renders a `SplitviewReact` with two fixed views: history list left, diff
  right. Split ratio persists in `localStorage` (shared origin across
  windows, so one remembered ratio).

The shell may live under `src/windows/` or `src/panels/`; either respects
the layering rule (`store`/`keys`/`lib`/`layout` never import from it).

### Summon redirect (the single decision point)

`summon("file-history", payload)` in `src/store/summon.ts` consults the new
global setting. Off: current docked path, untouched. On: resolve the active
repo and call `api.openFileHistoryWindow(repoId, path, rev)`; nothing is
added to the dock. All existing entry points (file context menus, Blame's
History button, Search results, the Files panel's browse-at-commit mode)
already funnel through this one summon call. The routing decision is a pure
function with a unit test.

The View menu's File History entry keeps opening the docked placeholder
panel regardless of the setting: a window without a file is meaningless, and
the docked panel remains fully functional either way. Toggling the setting
affects future summons only; an already-docked panel stays until closed.

### Setting

- Rust: `#[serde(default)] pub file_history_opens_window: bool` on
  `GlobalSettings` (`src-tauri/src/state.rs`); bindings regenerate the TS
  type; one-line setter in `store/settings.ts`.
- UI: checkbox in the global settings manifest
  (`globalSettingsManifest.tsx`), in the same group as "Auto-open panels",
  with searchable keywords (window, popup, history, detach).

### Window content

- **History list**: the list/row rendering, query
  (`repoFileHistory`, PAGE_SIZE paging, rename display, `rev` mode) is
  extracted from `FileHistoryPanel` into a shared component taking the repo,
  an `onSelect` callback and a row-menu slot. The docked panel wires today's
  summons and full menu, unchanged in behaviour. The window wires
  `onSelect` to the diff pane; the first row is auto-selected so the window
  never opens empty.
- **Window row menu (reduced)**: copy path / copy SHA, open in external
  editor, "Restore file to this commit" (destructive-confirm gated as
  today). Menu actions whose only meaning is a jump to another main-window
  panel (view at commit, blame, diff-in-main) are omitted: disjointedness
  makes them targetless.
- **Diff pane**: a lean read-only component over the shared rendering
  primitive (`DiffEditor` + the model files in `src/panels/Diff/`), fed a
  `DiffRequest` with `source: {kind: "commit"}` and `oldPath` for rename
  pairing. Inline/split modes and context (chunked/full) toggles reuse the
  same `localStorage` preference keys as the Diff panel, so the user's view
  preference carries over. No staging/editing plumbing: commit diffs are
  read-only by definition. Improvements to diff rendering (syntax
  highlighting, context expansion, split parity) reach both instances
  automatically because they live in the shared primitive.

### Theme, font and settings propagation

`patch_global_settings` (and the theme-activation command) emit a broadcast
event; the shell listens, re-fetches settings and re-applies theme and
`--ui-font-size`. Deliberate v1 limitation: live palette edits in the Theme
Editor preview only in the main window; an open popup catches up on the next
settings change or reopen.

## Edge cases

- **No repo / stale session** (repo closed in a race, app state gone): the
  window renders an error state with the message, never a blank page.
- **File deleted at HEAD**: history still lists the commits (git log --
  follow works for deleted paths); restore stays available.
- **Setting toggled while windows are open**: open windows stay; only future
  summons change routing.
- **Multiple monitors / DPI**: standard per-window WebView2 behaviour;
  nothing special to build.
- **Load**: each window is one extra WebView2 renderer (browser/GPU
  processes shared), roughly an extra browser tab; backend cost near zero
  (same process, same `RepoSession` and watcher).

## Out of scope (v2 candidates, BACKLOG on deferral)

- Generic per-panel "open as window" setting (the shell and redirect are
  built so a panel-id map can replace the single boolean later).
- Cross-window jumps ("open this commit in the main window").
- Live Theme Editor preview across windows.

## Testing

- **Pure decision logic, unit-tested**: window-label derivation (Rust),
  summon routing on/off (TS), first-row auto-select / selection-to-
  `DiffRequest` mapping (TS).
- **Existing gates that cover the change automatically**: bindings staleness
  (`cargo test -p legit-app`), settings-manifest integrity
  (`settingsManifest.test.ts`), no-literal-colors and contrast suites,
  toolbar-height normalization, layering test.
- **Shared-component regression**: the docked panel's flow (summons on row
  click) pinned by a component test so the extraction cannot silently change
  docked behaviour.
- **Manual pass** (interactive-only): window open/focus dedup, close
  cascades on repo close and app close, second-monitor placement, watcher
  freshness in the popup. E2E multiwindow via tauri-driver is attempted only
  if window-handle switching proves workable there; otherwise the manual
  pass is recorded in the PR notes.
