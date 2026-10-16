# Repository Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do NOT use subagent-driven-development.

**Goal:** Named, collapsible, recursively nestable, user-colorable groups of repo tabs in the repo strip, created/dissolved by drag and drop, persisted and synced.

**Architecture:** A `RepoGroupsDoc` item tree (repos and groups, recursive) on `GlobalSettings` becomes the single source of truth for strip order; `currently_open` is rewritten from it after every mutation so restore is untouched. All structural logic is pure Rust functions in a new `repo_groups` module, driven by one `apply_repo_groups_op` command; sync exports a portable remote-URL-keyed projection and imports by wholesale replace + reconcile. The frontend builds a render model from the doc + open repos in a pure TS module and renders groups as background containers behind the tabs, per tab style.

**Tech Stack:** Rust (serde + specta, tauri commands), React + TypeScript (zustand, vitest), CSS in `global.css` keyed off `data-repo-tab-style`.

**Spec:** `design/2026-10-16-repository-groups.md` (read it first; this plan argues from it).

## Global Constraints

- **NEVER commit or push.** No step in this plan commits; leave everything in the working tree. Instruct any dispatched agent likewise.
- No em-dashes and no center-dot separators in any output, including comments and docs.
- Comments: only non-derivable constraints, one line; no history, no restating names.
- Every colour via theme tokens; new tokens go in 4 places + every `themes/*.legit-theme.json`; `noLiteralColors.test.ts` and `contract.test.ts` enforce.
- Every dimension derives from `--ui-font-size` / the `repo_tab_*` settings; fixed px only for hairlines.
- Output-only Rust IPC types must not carry field-level `#[serde(default)]` (specta would emit `?`).
- Bindings are committed artifacts: after any command/type change run `LEGIT_UPDATE_BINDINGS=1 cargo test -p legit-app bindings` (from WSL) and keep `src/lib/bindings.ts` in the tree. `cargo test -p legit-app` fails while stale.
- Verification commands (from WSL): `cargo test -p legit-app`, `cargo test -p legit-core` (unaffected but cheap), `npx tsc --noEmit` directly; vitest through PowerShell interop: `powershell.exe -NoProfile -Command "cd C:\NOT_WORK\LeGit; npx vitest run <paths>"`. Never `npm install` from WSL.
- Depth cap: `MAX_GROUP_DEPTH = 3`, a hardcoded constant (NOT a setting), duplicated as `MAX_GROUP_DEPTH` in `src/panels/repoTabStrip/stripModel.ts` for drag previews; Rust is the enforcement authority.
- CHANGELOG: one Added bullet in `## [Unreleased]` (Task 8).

## Review Focus

Spec-implied failure modes no existing test covers; each line's pinning test is added to the owning task:

1. A malformed or foreign-version synced `repoGroups` value (wrong types, unknown fields, depth beyond this build's cap) must never panic or destroy local groups: import falls back to keeping the local doc for that key; over-deep trees are flattened at the cap. (Task 2 tests `import_groups_tolerates_garbage`, `import_flattens_beyond_depth_cap`.)
2. Duplicate repo references (same locator twice, via sync races or hand-edited files) must collapse to one membership deterministically (first occurrence wins). (Task 1 test `normalize_dedupes_locators`.)
3. A repo opening whose remote key matches pending members in several groups must join exactly one (first in document order) and the other pending copies with that key must be dropped. (Task 1 test `note_repo_opened_joins_first_pending_match_only`.)
4. `SetColor` must accept only `#rgb`/`#rrggbb`/`#rrggbbaa` (or null to reset); anything else is rejected with `AppError::Settings`, so a garbage string can never reach CSS. (Task 1 test `set_color_validates_hex`.)
5. The strip with zero groups must render today's exact DOM (no header layer, no group wrappers) so existing behaviour and CSS are provably unchanged. (Task 5 test `buildStripModel_flat_doc_yields_plain_repo_nodes`, Task 6 keeps `RepoTabBar.test.tsx` green unmodified except for store setup.)

---

### Task 1: Rust groups model (types, normalize, ops)

**Files:**
- Create: `src-tauri/src/repo_groups.rs`
- Modify: `src-tauri/src/lib.rs` (declare `mod repo_groups;`)
- Modify: `src-tauri/src/state.rs` (two `GlobalSettings` fields + lists)
- Modify: `src-tauri/src/sync/model.rs` (never-synced list only, full sync in Task 2)
- Test: unit tests inside `src-tauri/src/repo_groups.rs`

**Interfaces:**
- Consumes: `AppError` (`crate::error`), `Type` (specta), serde.
- Produces (used by Tasks 2 and 3):

```rust
pub const MAX_GROUP_DEPTH: usize = 3;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type, Default)]
pub struct RepoGroupsDoc { pub items: Vec<GroupItem> }

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum GroupItem {
    Repo(GroupRepoRef),
    Group(RepoGroup),
}

/// At least one of the two is Some. locator None = pending member synced
/// from another machine, waiting for a matching repo to open here.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct GroupRepoRef {
    pub locator: Option<String>,
    pub remote_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct RepoGroup {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub collapsed: bool,
    pub items: Vec<GroupItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ItemRef {
    Repo { locator: String },
    Group { id: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum RepoGroupsOp {
    MergeIntoGroup { dragged: ItemRef, target: ItemRef },
    NewGroupWith { item: ItemRef },
    MoveItem { item: ItemRef, parent: Option<String>, index: u32 },
    Ungroup { group_id: String },
    Rename { group_id: String, name: String },
    SetColor { group_id: String, color: Option<String> },
    SetCollapsed { group_id: String, collapsed: bool },
}

pub fn apply_op(
    doc: &RepoGroupsDoc, op: &RepoGroupsOp, open: &[String], new_group_id: &str,
) -> Result<RepoGroupsDoc, AppError>;
pub fn normalize(doc: &RepoGroupsDoc, open: &[String]) -> RepoGroupsDoc;
pub fn flatten_open(doc: &RepoGroupsDoc, open: &[String]) -> Vec<String>;
pub fn note_repo_opened(
    doc: &RepoGroupsDoc, locator: &str, remote_key: Option<&str>,
) -> RepoGroupsDoc;
```

**Semantics (from the spec, pinned by the tests below):**
- `normalize` (run by `apply_op` on its result, and by Task 3's hooks): dedupe repo refs by locator (first wins, spec Review Focus 2); remove ROOT-level repo items whose locator is not in `open` (grouped members persist regardless); dissolve empty groups, cascading upward; append any `open` locator missing from the doc as a root `Repo` item at the end; flatten group levels deeper than `MAX_GROUP_DEPTH` (a group at the cap absorbs its subgroups' members in place).
- `apply_op`:
  - `MergeIntoGroup`: replace `target` in its parent list with a new group `{ id: new_group_id, name: "Group N", color: None, collapsed: false, items: [target, dragged] }` where N = 1 + count of existing groups anywhere in the doc; `dragged` is removed from its old position first. Error if the result would exceed `MAX_GROUP_DEPTH`, if either ref is missing, if dragged == target, or if target is a descendant of dragged.
  - `NewGroupWith`: replace `item` in place with a new group (same id/name rules as `MergeIntoGroup`) holding only `item`. Error on missing ref or depth overflow. (Serves the "New group..." context-menu entry, where there is no drop pair.)
  - `MoveItem`: remove `item`, insert into `parent`'s (None = root) item list at `index` (clamped to len). Error on missing refs, depth overflow, or moving a group into its own descendant.
  - `Ungroup`: replace the group with its items, in place.
  - `Rename`: trimmed, non-empty name, else error.
  - `SetColor`: `Some` must match `^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$` else `AppError::Settings` (Review Focus 4).
  - `SetCollapsed`: set the flag.
- `flatten_open`: depth-first locators of repo items present in `open`, i.e. the `currently_open` order.
- `note_repo_opened`: if a ref with this locator exists, update its `remote_key` (when `Some`); else if `remote_key` matches a PENDING ref (locator None), set that ref's locator - first match in document order only, and drop any other pending refs with the same key (Review Focus 3); else leave the doc unchanged (normalize appends the root item).

**GlobalSettings additions** (`state.rs`): `pub repo_groups: RepoGroupsDoc` and `pub repo_remote_keys: std::collections::BTreeMap<String, String>` (locator -> canonical remote key), both `#[serde(default)]`, both added to `GLOBAL_SETTINGS_COMMAND_OWNED`; add `"repo_remote_keys"` and `"repo_groups"` to `GLOBAL_SETTINGS_NEVER_SYNCED` in `sync/model.rs` (the raw fields never sync; Task 2 adds the portable projection under its own key). Default impl + the `never_synced_keys_all_exist_on_the_struct` test keep passing; `synced_key_list_is_exactly_the_classified_set` must NOT change in this task.

- [ ] **Step 1: Write failing unit tests in `repo_groups.rs`** (module `#[cfg(test)]`), minimum set:
  - `normalize_dedupes_locators`, `normalize_prunes_closed_root_repos_keeps_grouped`, `normalize_dissolves_empty_groups_cascading`, `normalize_appends_unknown_open_repos`, `normalize_flattens_beyond_depth_cap`
  - `merge_creates_group_in_place_with_default_name`, `merge_nested_at_cap_is_rejected`, `merge_rejects_self_and_descendant`
  - `move_item_between_levels_and_clamps_index`, `move_group_into_descendant_rejected`
  - `ungroup_splices_members_in_place`
  - `set_color_validates_hex`, `rename_rejects_empty`, `new_group_with_wraps_item_in_place`
  - `flatten_open_is_depth_first_open_only`
  - `note_repo_opened_refreshes_key`, `note_repo_opened_joins_first_pending_match_only`
- [ ] **Step 2: Run `cargo test -p legit-app repo_groups` - expect compile failure / test failures**
- [ ] **Step 3: Implement the module per the semantics above**
- [ ] **Step 4: Add the `GlobalSettings` fields and list entries; run `cargo test -p legit-app` - all green (the pinned synced-key list must be untouched because both new fields are never-synced)**

### Task 2: Sync projection and reconcile

**Files:**
- Modify: `src-tauri/src/repo_groups.rs` (export/import fns + tests)
- Modify: `src-tauri/src/sync/model.rs` (wire into export/import + pinned list)
- Test: unit tests in both files

**Interfaces:**
- Consumes: Task 1's types.
- Produces:

```rust
pub const REPO_GROUPS_SYNC_KEY: &str = "repoGroups";
pub fn export_groups(doc: &RepoGroupsDoc) -> serde_json::Value;
pub fn import_groups(
    local: &RepoGroupsDoc,
    synced: &serde_json::Value,
    remote_keys: &std::collections::BTreeMap<String, String>,
) -> RepoGroupsDoc;
```

**Semantics (spec "Persistence and sync"):**
- `export_groups`: a portable tree of GROUPS only (root repo items dropped): per group `{ id, name, color, items }` where repo members appear as their `remote_key` string; members with `remote_key: None` are dropped; a remote key appearing in more than one group anywhere is ambiguous and dropped from ALL of them; `collapsed` and locators never exported; empty groups still export (id is identity).
- `import_groups`: the synced projection is authoritative for remote-keyed members: for each synced group (matched to local by `id`), set name/color/nesting, set its remote-keyed member set (add missing as pending or locator-resolved via `remote_keys` - ALL locators mapping to that key join unless they hold a local-only membership elsewhere), remove remote-keyed members absent from the synced group; preserve local-only members (`remote_key: None`), `collapsed`, and the group's strip position; new synced groups append at root end; delete a local group absent from the synced doc iff it would have been exported with at least one member key (local-only groups survive); result is normalized against an empty open-set override - pass through `normalize(doc, open)` where open handling stays the caller's job (Task 3 hook re-normalizes), so `import_groups` itself must not prune root repo items (factor normalize accordingly or skip the root-prune there).
- `sync/model.rs`: `export_synced_settings` inserts `REPO_GROUPS_SYNC_KEY` -> `export_groups(&s.repo_groups)` UNCONDITIONALLY (not gated by `sync_git_profiles`); `import_synced_settings` consumes the key specially (like profiles): `next.repo_groups = import_groups(&local.repo_groups, value, &local.repo_remote_keys)` and the key never flows through the generic merge loop. Add `"repoGroups"` to the pinned `synced_key_list_is_exactly_the_classified_set` expectation.

- [ ] **Step 1: Write failing tests**, in `repo_groups.rs`: `export_drops_local_only_and_ambiguous_keys`, `export_strips_collapsed_and_locators_keeps_empty_groups`, `import_removal_propagates_for_remote_keyed_members`, `import_preserves_local_only_members_collapsed_and_position`, `import_resolves_keys_to_all_matching_locators`, `import_keeps_unmatched_keys_as_pending`, `import_deletes_sync_visible_groups_absent_from_doc_keeps_local_only_groups`, `import_groups_tolerates_garbage` (non-object, members of wrong type: local doc returned unchanged), `import_flattens_beyond_depth_cap`; in `sync/model.rs`: `repo_groups_sync_unconditionally` (export contains `repoGroups` with `sync_git_profiles` false; import applies it), update the pinned key list.
- [ ] **Step 2: Run `cargo test -p legit-app` - expect the new tests to fail**
- [ ] **Step 3: Implement; re-run until green**

### Task 3: Commands and lifecycle hooks

**Files:**
- Create: `src-tauri/src/commands/repo_groups.rs`
- Modify: `src-tauri/src/commands/mod.rs`, `src-tauri/src/lib.rs` (`collect_commands!`)
- Modify: `src-tauri/src/commands/repo.rs` (open/restore/close/order hooks)
- Modify: `src/lib/bindings.ts` (regenerated)
- Test: unit tests beside the hooks + regenerated bindings test

**Interfaces:**
- Consumes: Task 1/2 functions; `AppState::mutate_global`, `state.get_session`, `crate::commands::browser::canonical_remote_key`, `warn_if_bookkeeping_persist_failed`.
- Produces (frontend calls via generated `api`):

```rust
#[tauri::command] #[specta::specta]
pub async fn get_repo_groups(state: tauri::State<'_, AppState>) -> Result<RepoGroupsDoc, AppError>;

#[tauri::command] #[specta::specta]
pub async fn apply_repo_groups_op(
    state: tauri::State<'_, AppState>, op: RepoGroupsOp,
) -> Result<RepoGroupsDoc, AppError>;
```

**Behaviour:**
- `apply_repo_groups_op`: compute `open` = locators of open sessions (same source as `ordered_open_locators`), `new_group_id` = `uuid::Uuid::new_v4().to_string()`; inside `mutate_global`: `settings.repo_groups = apply_op(...)?`, then `settings.currently_open = flatten_open(&settings.repo_groups, &open)`; return the new doc. No event emit (the caller gets the doc; sync import already emits `GLOBAL_SETTINGS_CHANGED_EVENT`).
- Open hook: after a session is created (shared helper called from `open_repo`, restore, init, clone paths - find the common post-open point in `repo.rs`), spawn a non-blocking task: resolve the canonical remote key like `repo_assignment_key` does (session remotes -> `canonical_remote_key(&remote.fetch_url)`), then `mutate_global`: insert into `repo_remote_keys`, `repo_groups = note_repo_opened(...)` then `normalize` with the current open set, rewrite `currently_open` via `flatten_open`. Must never block or fail the open; failures log via `warn_if_bookkeeping_persist_failed`.
- Immediately on open (not in the async task): `repo_groups = normalize(doc, open)` so the new tab appears in the doc at root end even before the remote key resolves.
- Close hook (`close_repo` path): `repo_groups = normalize(doc, open-after-close)` + `flatten_open` rewrite (prunes the ungrouped item, keeps grouped membership).
- `set_open_repos_order`: keep the command; after computing `ordered_paths`, also reorder the doc's ROOT repo items to match (groups keep their positions relative to surviving neighbours; simplest: rebuild root as the ordered interleave - mark the exact algorithm builder's choice, pinned by its test) and rewrite `currently_open` from `flatten_open`. (The frontend reorder switches to ops in Task 7, but this command stays coherent for E2E/back-compat.)

- [ ] **Step 1: Write failing tests**: in `commands/repo_groups.rs` or `repo.rs` test module - `apply_op_rewrites_currently_open` (build an `AppState` the way existing `state.rs`/command tests do; if no such harness exists, test the composed pure sequence `apply_op` + `flatten_open` and the hook helpers as pure fns instead - the plan requires the LOGIC pinned, not a tauri runtime), `close_keeps_grouped_membership_prunes_ungrouped`, `open_normalize_appends_before_key_resolution`.
- [ ] **Step 2: Run `cargo test -p legit-app` - new tests fail**
- [ ] **Step 3: Implement commands + hooks; register both commands in `collect_commands!`**
- [ ] **Step 4: Regenerate bindings: `LEGIT_UPDATE_BINDINGS=1 cargo test -p legit-app bindings`; then `cargo test -p legit-app` fully green**

### Task 4: Theme tokens

**Files:**
- Modify: `src/theme/tokens.ts` (TOKEN_CONTRACT + CONTRAST_PAIRS), `src/theme/defaults.ts`, `src/styles/theme.css`, all 5 `themes/*.legit-theme.json`

**Interfaces:**
- Produces: tokens `group.bg` and `group.fg` (CSS vars `--group-bg`, `--group-fg`), group "Repo Tabs", documentation strings describing the group container background/name text.
- Contrast pair: `{ fg: "group.fg", bg: "group.bg", base: "tab.strip.bg", label: "Repo group header", group: "Tabs & headers" }` (AA 4.5, the default).

- [ ] **Step 1: Add the two tokens in all 4 places + every bundled theme.** Default (Dark) values: a translucent accent wash for `group.bg` (e.g. bind to a new or existing palette entry; follow how `tab.*` tokens bind in each theme) and a readable `group.fg`; tune per theme until the contrast pair passes composited over `tab.strip.bg`.
- [ ] **Step 2: Run vitest theme suites: `powershell.exe -NoProfile -Command "cd C:\NOT_WORK\LeGit; npx vitest run src/theme"` - `contract.test.ts` green for every bundled theme**

### Task 5: Frontend strip model and store

**Files:**
- Create: `src/panels/repoTabStrip/stripModel.ts`
- Create: `src/panels/repoTabStrip/stripModel.test.ts`
- Create: `src/store/repoGroups.ts`
- Test: vitest on `stripModel.test.ts`

**Interfaces:**
- Consumes: generated types `RepoGroupsDoc`, `GroupItem`, `RepoGroup`, `RepoGroupsOp`, `ItemRef` from `src/lib/types.ts` re-exports; `RepoSummary` (`locator` field); `api.getRepoGroups`, `api.applyRepoGroupsOp`; `onGlobalSettingsChanged` (`src/lib/events.ts`).
- Produces:

```ts
export const MAX_GROUP_DEPTH = 3; // mirrors src-tauri/src/repo_groups.rs

export type StripNode =
  | { kind: "repo"; repo: RepoSummary; depth: number }
  | { kind: "group"; group: RepoGroup; depth: number; children: StripNode[];
      openCount: number; containsActive: boolean };

export function buildStripModel(
  doc: RepoGroupsDoc, openRepos: RepoSummary[], activeRepoId: string | null,
): StripNode[];
export function visibleDepth(nodes: StripNode[]): number; // expanded paths only
export type DropTarget =
  | { kind: "insert"; parentId: string | null; index: number }
  | { kind: "merge"; target: ItemRef };
export function classifyDrop(args: {
  pointerX: number;
  items: Array<{ ref: ItemRef; left: number; width: number; parentId: string | null;
                 index: number; depth: number; isGroup: boolean }>;
  dwellSatisfied: boolean;
  draggedRef: ItemRef;
  draggedDepthCost: number; // 1 for a repo, 1 + own subtree depth for a group
}): DropTarget;
```

Store (`src/store/repoGroups.ts`, zustand like `repos.ts`): `doc: RepoGroupsDoc`, `load(): Promise<void>` (calls `api.getRepoGroups`), `applyOp(op: RepoGroupsOp): Promise<void>` (awaits `api.applyRepoGroupsOp`, sets the returned doc, `notify.error(formatAppError(e))` on failure), module-level `onGlobalSettingsChanged(() => load())` subscription following how other stores subscribe.

**`buildStripModel` semantics:** walk `doc.items`; repo refs resolve against `openRepos` by `locator` (closed/pending members produce no node); groups with `openCount === 0` produce no node (ghost rule); collapsed groups produce the group node with `children: []` but correct `openCount`/`containsActive` (chips render from the node itself). `classifyDrop`: center zone (middle 50% of an item's width) + `dwellSatisfied` -> `merge` unless depth would exceed `MAX_GROUP_DEPTH` (`target.depth + draggedDepthCost > MAX_GROUP_DEPTH`) or target is the dragged item / its descendant; otherwise nearest insertion gap (the existing centre-comparison rule generalized to the gap between strip items at the pointed depth).

- [ ] **Step 1: Write failing tests** in `stripModel.test.ts`: `buildStripModel_flat_doc_yields_plain_repo_nodes` (Review Focus 5), `closed_members_and_all_closed_groups_render_nothing`, `collapsed_group_reports_open_count_and_active`, `visibleDepth_ignores_collapsed_subtrees`, `classifyDrop_center_dwell_merges`, `classifyDrop_fast_pass_through_inserts`, `classifyDrop_at_cap_falls_back_to_insert`, `classifyDrop_rejects_descendant_target`.
- [ ] **Step 2: Run them (PowerShell interop vitest) - fail**
- [ ] **Step 3: Implement `stripModel.ts` + `repoGroups.ts`; tests green; `npx tsc --noEmit` clean**

### Task 6: Strip rendering (groups, chips, three styles)

**Files:**
- Modify: `src/panels/RepoTabBar.tsx` (render from `buildStripModel`)
- Modify: `src/styles/global.css` (group container + header band + chip CSS per `data-repo-tab-style`)
- Test: existing suites stay green (`RepoTabBar.test.tsx`, `src/theme/noLiteralColors.test.ts`, `src/styles/toolbarControls.test.ts`, `src/layering.test.ts`)

**Interfaces:**
- Consumes: Task 5 model + store, Task 4 tokens.
- Produces: DOM structure - group container `div.legit-tab-group` (background layer, `--group-bg`; a per-group `style={{ "--group-bg": group.color }}` override when `color` is set, nothing otherwise so the token rules), header band `div.legit-tab-group__header` (name + caret, `--group-fg`), children row `div.legit-tab-group__tabs`, collapsed chip `div.legit-tab-group__chip` (caret, name, open count, active marker when `containsActive`). Tabs render IN FRONT (z-order: tabs have the higher stacking inside the container; the container is visually behind, per the spec's sketch).

**Rules:**
- Zero groups in the model: render exactly the previous flat DOM (no wrapper elements) - the existing tests must pass unmodified except store wiring.
- Strip height: the strip's padding-top grows by `visibleDepth * headerBand` where headerBand derives from `--ui-font-size` (CSS `calc`, e.g. `calc(var(--ui-font-size) + 0.5em)`); everything bottom-aligns (`align-items: flex-end` already).
- Per style (`:root[data-repo-tab-style="..."]`): flush = container flush on the separator, top radius like tabs; pill = fully rounded container, chip is a pill; browser = borderless container with the flare pseudo-element geometry reused/adapted from the existing `.legit-tab` flare rules (nested flares: member tabs keep theirs; the container carries its own with `--group-bg` as the flare fill).
- Header: click toggles `SetCollapsed` (via store `applyOp`), chip click expands (never activates a member); collapsed chip shows `name (openCount)`.
- Colours only via `var(--group-bg)` / `var(--group-fg)`; the active marker on a chip reuses `tab.active.*` tokens.
- Overflow fade: the clipped-edge detection (`data-clipped-left/right`) keys off the scroller's scroll metrics, which are content-agnostic; verify it still fires with group containers present (manual check in Step 3).

- [ ] **Step 1: Implement rendering + CSS (recursive `StripNode` renderer)**
- [ ] **Step 2: Run the full vitest suite (PowerShell interop) + `npx tsc --noEmit` - green; `RepoTabBar.test.tsx` may gain minimal store-mock setup but no behavioural edits**
- [ ] **Step 3: Visual smoke per style: temporarily seed a grouped doc (devtools or test repo), screenshot flush/pill/browser at `--ui-font-size` 12 and 18; confirm bottom alignment, chip shapes, flares, and the zero-group strip pixel-identical to before (user runs the app from PowerShell if a human check is needed; state the result honestly)**

### Task 7: Drag and drop, context menus, rename, colour

**Files:**
- Modify: `src/panels/RepoTabBar.tsx` (drag machine + menus)
- Create: `src/panels/repoTabStrip/dragMachine.ts` IF the pointer logic extracted cleanly exceeds ~100 lines in the component (builder's call), with its pure parts in `stripModel.ts` either way
- Test: `stripModel.test.ts` additions for any new pure helpers; existing suites green

**Interfaces:**
- Consumes: `classifyDrop`, `applyOp` (store), `InlineEditor` (`src/panels/shared/InlineEditor.tsx`), `AnchoredDropdown`/`Popover` (`src/panels/shared/`), `useMenuConfirm` NOT needed (nothing destructive).
- Produces: user-facing interactions, mapping 1:1 to ops:
  - Drag commit: `classifyDrop` result -> `MergeIntoGroup { dragged, target }` or `MoveItem { item, parent, index }`. Dwell: a 350ms timer armed while the pointer rests in a center zone (reset on zone change); `DRAG_THRESHOLD` and the live-reorder preview behaviour stay. During drag, the live preview continues to use local order state; the op is sent once on release (replacing the `reorderRepos`/`setOpenReposOrder` call for grouped strips; a flat strip may keep the old path - builder's call, one path must own each case).
  - Merge preview: target swells/frames via a CSS class (`is-merge-target`), tokens only.
  - Group creation: after a successful `MergeIntoGroup`, the new group's header enters rename mode immediately (`InlineEditor`; Enter confirms -> `Rename`, Esc keeps "Group N").
  - Tab context menu (right-click a tab): "Move to group" submenu listing existing groups by name (`MoveItem` to that group's end) plus "New group..." (`NewGroupWith { item }`, then inline rename opens); "Remove from group" (`MoveItem` to the parent's parent, positioned right after the group) when grouped.
  - Group header/chip context menu: Rename (inline), Change color... (native `<input type="color">` in a small `Popover`, follows `SeedRow.tsx`'s pattern; commit -> `SetColor(Some(hex))`), Reset to theme color (`SetColor(None)`), Collapse/Expand (`SetCollapsed`), Ungroup (`Ungroup`). No confirmations.
  - Double-click header = rename; single click = collapse toggle; drag on header moves the whole group (same drag machine, `ItemRef::Group`).
- [ ] **Step 1: Write failing vitest tests for the new pure helpers (dwell-zone computation if extracted; otherwise extend classifyDrop cases)**
- [ ] **Step 2: Implement the interactions**
- [ ] **Step 3: Full verification: `cargo test -p legit-app`, vitest full run via PowerShell interop, `npx tsc --noEmit` - all green**

### Task 8: Changelog and final sweep

**Files:**
- Modify: `CHANGELOG.md` (`## [Unreleased]`, Added)
- Modify: `BACKLOG.md` (deferred optimization)

- [ ] **Step 0: Add the BACKLOG.md entry the spec requires: "Unload collapsed repo groups" - collapsing is purely visual in v1; a later optimization may close sessions/watchers of fully collapsed groups and restore them on expand; rough approach: a repo-session suspend/resume seam keyed off group collapse state**
- [ ] **Step 1: Add the bullet: "Repository tabs can be grouped into named, collapsible, colorable groups by drag and drop (groups nest, sync across machines, and follow the tab style)"**
- [ ] **Step 2: Run the complete gates once more: `cargo test -p legit-app`, `cargo test -p legit-core`, vitest full suite (PowerShell interop), `npx tsc --noEmit`. Report any failure honestly; fix before claiming done**
- [ ] **Step 3: Confirm no file contains an em-dash or center dot introduced by this work (`git diff | grep -n "—\|·"` is empty)**

---

## Self-review notes

- Spec coverage: model/recursion (T1), depth constant (T1/T5), sync incl. gating/identity/ambiguity/ghosts (T2), lifecycle + remote-key bookkeeping + currently_open coherence (T3), tokens + contrast + per-group override as user data (T4, T6), rendering per style / z-order / visible-depth height / chips / active marker (T5, T6), gestures incl. dwell-merge vs positional insert, menus, inline rename, colour picker (T7), CHANGELOG (T8). Collapse-never-touches-sessions holds by construction: no task touches sessions/watchers.
- Deliberately not planned: keyboard shortcuts (spec non-goal), unload-on-collapse (backlog), E2E drag specs (the pure classifier + flow tests carry the logic; interactive drag is Step-3 manual verification in Task 6/7 - if a drag-wiring bug is found and fixed later, it gets its regression seam then per house rules).
