# Branches section: folder-like tree view

**Date:** 2026-07-31
**Status:** Approved

## Goal

Slash-separated branch names (`feature/api`, `feature/new-pricing`) can render
as a collapsible folder tree in the Refs panel's Branches section, switchable
against the flat list. The switch is a segmented Tree/List toggle in the
Branches section header (like the Files panel's), persisted as a GLOBAL
setting - no Global Settings panel entry (user decision).

## Design

1. **Tree building - reuse `flatten`.** The shared pure module
   `src/panels/shared/FileTree/buildTree.ts` already turns slash-paths into
   render-ready rows (folder rows with depth/count/collapse +
   single-child-chain compression, leaf rows). Branch names are slash-paths:
   feed `{ path: branch.name }` per branch, map leaf rows back to `Branch`
   by name. Git itself forbids a branch named like another branch's folder
   prefix (`feature` vs `feature/api` cannot coexist), so the path mapping is
   total. A small `branchTree.ts` wrapper in `panels/Branches` holds this
   adapter logic (entry building, leaf lookup, current-branch-in-folder
   detection) as pure functions with unit tests (`branchTree.test.ts`).
2. **Both lists nest** (user decision): the local list and the
   remote-branches list in the Branches section each apply the same flatten
   with their own collapse state. The remote list nests within each remote's
   existing grouping (paths are the branch names WITHOUT the remote prefix,
   as already listed).
3. **Rendering.** Folder row: chevron (existing `ChevronDownIcon` /
   `ChevronRightIcon` pattern), folder name, branch count, indented by
   depth via `em` padding; click toggles collapse. Branch rows are the
   existing `LocalBranchRow` / `RemoteBranchRow`, indented by depth,
   displaying the LEAF segment (full name in tooltip; rename editors and all
   actions keep operating on the full name). A collapsed folder containing
   the checked-out branch shows the current-branch dot
   (`--ref-branch-current-fg`) next to its count (user decision) so the
   checkout is never invisible.
4. **State.** Collapse state: ephemeral component state (`Set<string>` of
   folder paths), folders default expanded - same as the Files tree. View
   mode: new global setting `branch_list_view: "flat" | "tree"` (Rust
   `Settings` struct, `#[serde(default)]` flat default; mirrored in
   `types.ts`; read/written via `useSettingsStore`). The only UI is the
   section-header segmented toggle (`segStyle` pattern from FilesPanel).
5. **Flat mode** renders exactly today's lists (no behavior change when the
   setting is "flat"/absent).
6. **Ordering:** tree mode uses `flatten`'s ordering (folders first,
   alphabetical); the `refs_sort_mode` setting applies to the flat list only.

## Testing

- `branchTree.test.ts` (pure): entry building, leaf-row -> Branch mapping,
  folder counts, current-branch-in-collapsed-folder detection, compression
  of single-child chains, flat mode passthrough.
- `buildTree.ts` stays untouched (its own tests already pin the tree
  semantics).
- Settings plumbing follows the existing convention; no new theme tokens
  (chevrons/colors reuse existing ones).
