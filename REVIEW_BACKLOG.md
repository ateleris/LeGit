# Review Backlog

Findings of the architecture / streamlining review of 2026-09-23 (core crate,
Tauri backend + host crates, frontend data layer, panels). Each item lists the
evidence, the problem, and the proposed change. Line numbers reflect the tree at
commit `0df3af2` and will drift.

Effort: **S** = hours, **M** = a day or two, **L** = multi-day.

---

## 1. Rust core (`crates/legit-core`)

- [ ] **A7 Restore the format-constant contract** (S)
  - Inline format strings: `mod.rs:390, 415, 585, 2019, 2455`,
    `submodules.rs:332`; four different stash-list formats (`%H`, `%H %gd`,
    `%H %s`, `STASH_FORMAT`).
  - Pure parsers outside `parsers/`: `classify_repo_files`,
    `parse_ls_tree_files`, `filter_paths` (3045-3130), `find_stash_selector`,
    `filter_containing_refs`, `parse_author_fields`,
    `parse_lfs_download_failure` (3726), and in `line_endings.rs`
    `parse_check_attr_z`, `parse_cat_file_batch`, `parse_autocrlf`.
  - `format!("--format={}", X)` repeated 7x: export ready-made arg constants.

---

## 2. Tauri backend (`src-tauri`, `legit-host`, `legit-proto`, `legit-agent`, `legit-watch`)

- [ ] **B2 Hot-swap the runner on a per-repo git path change** (S-M)
  - `set_repo_git_path` (`git_setup.rs:125-135`) drops and rebuilds the
    session, which gives the repo a new id under the frontend
    (`RepoSession::new` mints a UUID). Swap the runner behind the existing
    `Arc<RwLock<Arc<dyn GitExecutor>>>` (`state.rs:631-636`) instead, as the
    global git path change already does.

- [ ] **B6 Replace ~40 single-field global-settings setters with a patch command** (M)
  - `persistence.rs:44-537`: three-line `mutate_global` commands, each also
    needing `collect_commands!`, `commands.ts`, `types.ts` and store entries
    (`store/settings.ts` imports 35 setters, near-identical bodies 269-330).
  - Fix: `patch_global_settings(partial)` with clamping in Rust + generic
    `setSetting(key, value)` in the store. Same shape as
    `patch_repo_settings`.

- [ ] **B10 Remove dead `AppState.hosts`** (S)
  - Only read by `local_host()` (`state.rs:864-871`), never inserted into
    (WSL hosts live in `wsl_hosts`). Replace with a `local_host` field. Fix the
    stale `RepoSession.locator` doc ("Today always `Local`", `state.rs:625`).

- [ ] **B12 `watcher::all_domains()` hand-lists `ChangeDomain`** (S)
  - `watcher.rs:58-70`; make it `ChangeDomain::ALL` in `legit-watch` so a new
    domain cannot be missed.

---

## 3. Frontend data layer (`src/lib`, `src/store`, `src/keys`)

- [ ] **C1 Replace the hand-mirrored types with the generated ones** (M)
  - `bindings.ts` is committed, a `cargo test` snapshot keeps it current, and
    `bindingsParity.ts` makes tsc fail when one of the 122 shared types
    drifts. Remaining: turn `types.ts` definitions into re-exports of the
    generated types (keeping only frontend-only types), and register events
    with `collect_events!` so the 15 hand-typed event payloads
    (`lib/events.ts`) are generated too.

- [ ] **C2 Replace `commands.ts` pass-through wrappers** (M, after C1)
  - 1283 lines; 246 `invoke` names vs 265 generated commands; header
    (`commands.ts:1-5`) already calls it the seam bindings will replace.
  - Fix: one `unwrap(p: Promise<Result<T, AppError>>)` adapter plus
    `export const api = wrap(commands)`. Keep hand-written functions only where
    they add value (arg defaults like `repoInit`, the
    `GLOBAL_/WSL_GIT_CONFIG_COMMANDS` maps at 131-153 pinned by the isolation
    test).
  - `repo_search_paths` is registered (`lib.rs:271`,
    `commands/inspect.rs:53`) but has no frontend caller: delete or wire.

---

## 4. Panels (`src/panels`)

- [ ] **D4 Break up `CommitsPanel.tsx`** (L)
  - One 1810-line function (123-1936). Inline row renderer (1488-1930) in the
    virtualizer map; bulk right-click business logic in `onContextMenu`
    (1502-1560); hooks placed above the no-repo early return with a crash
    warning comment (955-958); `RefsCell` gets ~40 props, 30 callbacks
    (`cells/RefsCell.tsx:104`).
  - Extract: guard component + `CommitsPanelBody({repo})` (removes hook-order
    hazard); memoized `CommitRow`; pure tested `bulkMenuPlan()` in
    `multiSelect.ts`; `useQuickJump` (959-1110); `useColumnLayout`
    (985-1054); `useGraphModel` (edge/span memos, 739-806); inline-edit state
    hook for rename/reword/create-branch/create-tag (386-698);
    `RefActionsContext` instead of callback props.

- [ ] **D5 Shared CodeMirror layer; split `MergeView` and `DiffEditor`** (L)
  - `Merge/MergeView.tsx:323-1100`: ~730-line `useEffect` with fold
    bookkeeping, chunk/gap expansion, alignment spacers, header checkboxes as
    closures; only `mergeExpander.test.tsx` covers it.
  - MergeView imports `baseTheme`, `readOnly`, `plusMinusIcon`,
    `NumberMarker` from the component file `Diff/DiffEditor.tsx:29`, and
    `conflictModel` from `Diff/`.
  - Fix: `panels/codemirror/` (theme, gutters, expanders, syntaxLanguages);
    split `DiffEditor.tsx` (1226 lines) into theme/extensions, `mountInline`,
    `mountSplit` (954-1168), thin component; move `conflictModel` and pure
    `mergeFolds`/`mergeAlign` into `Merge/` with tests.

- [ ] **D6 Settings panel primitives** (M)
  - `GlobalSettingsPanel.tsx` (1442 lines): 18 sections, 19 checkboxes;
    ConfirmDiscard / DetectCaseRenames / CheckoutRemoteFF (1112-1240) are the
    same ~30-line toggle block; 85 `style={{` (most of any file); 16
    wordings of the "writes to:" note; em-dashes in UI copy.
  - Fix: `<SettingToggle scope field label note>` and `<WritesTo scope/>` in
    `Settings/primitives.tsx`; split into per-group files
    (CommitsGraphSection alone is 371-660).

- [ ] **D7 `ThemeEditorPanel` draft logic into pure, tested ops** (M)
  - Main function (48-584) mixes palette mutation (rename auto-rebind
    123-157, delete guard 141-157, `resetToken`) with import/export/save IO.
  - Fix: `themeDraftOps.ts` with unit tests for the CLAUDE.md rules (rename
    rebinds tokens, delete blocked while referenced); own files for
    `ContrastSection`, `PanelOverridesSection`.

- [ ] **D8 `WorkingChangesPanel` data + diff-sync extraction** (M)
  - 6+ inline queries (211-360) -> `useWorkingChangesData`; extract
    `openDiff`/`syncOpenDiff` (389-500).
  - Hand-rolled pending-dim timer (547-555) is `useDelayedFlag(!pendingEmpty)`.

- [ ] **D10 Move app-wide menu primitives out of `Commits/`** (S)
  - `Commits/menu/primitives` has 17 importers, `Commits/menu/PanelContextMenu`
    9 (incl. `shared/*`, ViewMenu, RepoTabBar). Move to `shared/menu/`.
  - `SectionLabel` redefined in `Branches:605`, `Stashes:329`,
    `menu/primitives:103`; `Section` in `CommitDetails:155`,
    `Repositories:142`, `WorkingChanges:1203`. Dedupe.

---

## 5. Streamlining and cleanup (small, opportunistic)

- [ ] **E0 One Explorer invocation for local and WSL reveal** (S, needs a
  Windows test)
  - `reveal_in_file_manager` passes `/select,<path>` through `Command::arg`
    (Rust quotes the WHOLE argument when it has a space);
    `reveal_remote_in_explorer` uses `raw_arg` with quotes around the UNC
    path only, the form Explorer documents. Check on Windows whether the
    local form reveals a file whose path contains a space; if not, switch
    both to the quoted-path form and route them through one function taking
    the app-visible path (local path, or the `\\wsl.localhost\` UNC).
- [ ] **E1 Duplicated OS helpers (Rust)**: three explorer/open/xdg-open spawners
  (`files.rs:277-310`, `editor.rs:263-290`, `browser.rs:77-104`) -> one
  `os_open(target, OpenMode)` or `tauri-plugin-opener`; two quote tokenizers
  (`editor.rs:23`, `profiles.rs:385`); identical `sanitize_theme_name`
  (`persistence.rs:743`) / `sanitize_layout_name` (`layouts.rs:299`), neither
  rejecting Windows reserved names (CON, NUL) or trailing dots.
- [ ] **E3 Dead / test-only exports**: `keys/registry.ts:185` `commandById`
  (unused); `lib/locator.ts:31` `formatWslLocator` and `:44` `hostLabel`
  (tests only); un-export file-local constants. Core re-exports unused
  outside legit-core (`lib.rs:17-23`): `checkin_normalizes`,
  `classify_line_endings_normalized`, `mixed_endings_in_bytes`,
  `ParseError`.
- [ ] **E6 Fixed-px chrome in shared styles**: `shared/segmented.ts:7`
  (`padding: "2px 8px"` + rgba fallback), `shared/fields.ts` (`"0 6px"`,
  `borderRadius: 3`). Convert to em; check why the no-fixed-px test does not
  catch these.
- [ ] **E8 Stale documentation references**: 8 references to a non-existent
  `DESIGN.md`, 12 to `DESIGN-v0.2`; `legit-core/src/lib.rs:4` and
  `types.rs:4` still say "v0.1".

---

## Suggested order

1. B2; B6 with C2; finish C1.
2. Component splits D4-D8, one at a time behind existing tests.
3. Section 5 opportunistically.
