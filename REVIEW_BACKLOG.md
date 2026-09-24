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

1. D4 and D5, one at a time behind existing tests.
2. Section 5 opportunistically (E0 first needs the Windows spaces-in-path
   reveal test).
