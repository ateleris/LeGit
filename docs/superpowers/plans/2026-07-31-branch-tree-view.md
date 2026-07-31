# Branch Folder Tree View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do NOT use subagent-driven-development (user rule). Do NOT commit at any point (user rule): leave all changes for the user's review.

**Goal:** The Refs panel's Branches section can render slash-separated branch names as a collapsible folder tree, toggled by a section-header Tree/List control persisted as a global setting.

**Architecture:** Reuse the shared pure `flatten` from `src/panels/shared/FileTree/buildTree.ts` (branch names are slash-paths) via a small pure adapter `branchTree.ts`; render folder rows plus the existing branch rows indented; persist `branch_list_view` following the `changed_files_view_mode` convention end to end.

**Tech Stack:** React/TypeScript frontend, Rust (src-tauri) global settings persistence, vitest.

**Spec:** `docs/superpowers/specs/2026-07-31-branch-tree-view-design.md`

## Global Constraints

- Never commit or push; leave changes for the user's review.
- No em-dashes anywhere; use "-" or restructure.
- No literal colors / fixed-px sizing: theme tokens and em/`--fz-*` only. The current-branch dot on folders uses `var(--ref-branch-current-fg, rgb(130, 220, 130))` (same token+fallback as the chip and the row dot).
- Rust verification: `cargo check -p legit-app`. Frontend: `npx tsc --noEmit` (WSL) and vitest via `powershell.exe -Command "cd C:\NOT_WORK\LeGit; npx vitest run ..."`.
- Do NOT hand-edit `src/lib/bindings.ts` (regenerated when the app runs).
- Flat mode must render exactly today's lists (sort mode `refs_sort_mode` applies). Tree mode uses `flatten`'s ordering (folders first, alphabetical) - the sort mode does not apply there.

---

### Task 1: `branch_list_view` global setting end to end

**Files:**
- Modify: `src-tauri/src/state.rs` (Settings struct ~line 226 area, defaults ~line 352)
- Modify: `src-tauri/src/commands/persistence.rs` (next to `save_changed_files_view_mode`, ~line 85)
- Modify: `src-tauri/src/lib.rs` (`collect_commands!`, next to `commands::save_changed_files_view_mode` at ~line 246)
- Modify: `src/lib/commands.ts` (next to `saveChangedFilesViewMode`, ~line 985)
- Modify: `src/lib/types.ts` (Settings mirror, next to `changed_files_view_mode` at ~line 43)
- Modify: `src/store/settings.ts` (setter next to `setChangedFilesViewMode`, ~line 179; interface ~line 106; import list ~line 5)

**Interfaces:**
- Produces: Rust `Settings.branch_list_view: Option<String>`; Tauri command `save_branch_list_view(mode: String)`; TS `saveBranchListView(mode: string)`; store setter `setBranchListView(mode: "tree" | "flat")`; `Settings.branch_list_view?: string | null` in types.ts. Consumers read `settings?.branch_list_view === "tree" ? "tree" : "flat"`.

- [ ] **Step 1: Rust field + default**

In `state.rs`, next to `changed_files_view_mode`:

```rust
    /// Branches section list style (`"tree"` | `"flat"`). `None`/unknown =
    /// flat. Toggled from the Branches section header, applies globally.
    #[serde(default)]
    pub branch_list_view: Option<String>,
```

and in the `Default` impl: `branch_list_view: None,`

- [ ] **Step 2: Persistence command**

In `persistence.rs`, mirroring `save_changed_files_view_mode`:

```rust
/// Persist the Branches section's list style (`"tree"` | `"flat"`).
#[tauri::command]
#[specta::specta]
pub async fn save_branch_list_view(
    state: tauri::State<'_, AppState>,
    mode: String,
) -> Result<(), AppError> {
    state.mutate_global(|s| {
        s.branch_list_view = Some(mode);
    })
    .await
}
```

Register in `lib.rs` `collect_commands!` right after `commands::save_changed_files_view_mode,`:

```rust
        commands::save_branch_list_view,
```

(If persistence.rs commands are re-exported via a `mod`/`pub use` list in `commands/mod.rs`, add it there the same way `save_changed_files_view_mode` is.)

- [ ] **Step 3: Verify the app crate compiles**

Run: `cargo check -p legit-app 2>&1 | tail -3`
Expected: no errors.

- [ ] **Step 4: Frontend wrapper + type + store setter**

`src/lib/commands.ts`:

```typescript
export const saveBranchListView = (mode: string) =>
  invoke<null>("save_branch_list_view", { mode });
```

`src/lib/types.ts`, in the `Settings` mirror next to `changed_files_view_mode`:

```typescript
  branch_list_view?: string | null;
```

`src/store/settings.ts`: add `saveBranchListView` to the imports from `../lib/commands`; add to the store interface:

```typescript
  setBranchListView: (mode: "tree" | "flat") => Promise<void>;
```

and the implementation next to `setChangedFilesViewMode`:

```typescript
  async setBranchListView(mode) {
    await saveBranchListView(mode);
    const s = get().settings;
    if (s) {
      set({ settings: { ...s, branch_list_view: mode } });
    }
  },
```

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit 2>&1 | tail -3`
Expected: clean.

---

### Task 2: `branchTree.ts` pure adapter (TDD)

**Files:**
- Create: `src/panels/Branches/branchTree.ts`
- Test: `src/panels/Branches/branchTree.test.ts`

**Interfaces:**
- Consumes: `flatten`, `type Row` from `../shared/FileTree/buildTree`.
- Produces:
  - `branchTreeRows(names: string[], collapsed: ReadonlySet<string>): Row[]` - tree rows for slash-path names.
  - `leafName(path: string): string` - display segment for a leaf row.
  - `folderHoldsCurrent(folderPath: string, currentName: string | null | undefined): boolean` - the collapsed-folder current-dot predicate.

- [ ] **Step 1: Write the failing test**

`src/panels/Branches/branchTree.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { branchTreeRows, folderHoldsCurrent, leafName } from "./branchTree";

const names = ["main", "feature/api", "feature/new-pricing"];

describe("branchTreeRows", () => {
  it("groups slash-prefixed names under folder rows, folders first", () => {
    const rows = branchTreeRows(names, new Set());
    expect(rows.map((r) => (r.kind === "dir" ? `D:${r.path}` : `B:${r.path}`))).toEqual([
      "D:feature",
      "B:feature/api",
      "B:feature/new-pricing",
      "B:main",
    ]);
  });

  it("reports the branch count on the folder row", () => {
    const rows = branchTreeRows(names, new Set());
    const dir = rows.find((r) => r.kind === "dir");
    expect(dir && dir.kind === "dir" && dir.fileCount).toBe(2);
  });

  it("hides a collapsed folder's branches", () => {
    const rows = branchTreeRows(names, new Set(["feature"]));
    expect(rows.map((r) => r.path)).toEqual(["feature", "main"]);
    const dir = rows[0];
    expect(dir.kind === "dir" && dir.collapsed).toBe(true);
  });

  it("compresses single-child folder chains into one row", () => {
    const rows = branchTreeRows(["release/v1/hotfix"], new Set());
    const dir = rows.find((r) => r.kind === "dir");
    expect(dir && dir.kind === "dir" && dir.label).toBe("release/v1");
    expect(dir && dir.kind === "dir" && dir.path).toBe("release/v1");
  });

  it("indents nested rows by depth", () => {
    const rows = branchTreeRows(["a/b", "a/c/d"], new Set());
    const byPath = new Map(rows.map((r) => [r.path, r.depth]));
    expect(byPath.get("a")).toBe(0);
    expect(byPath.get("a/b")).toBe(1);
    expect(byPath.get("a/c")).toBe(1);
    expect(byPath.get("a/c/d")).toBe(2);
  });
});

describe("leafName", () => {
  it("returns the last path segment", () => {
    expect(leafName("feature/new-pricing")).toBe("new-pricing");
    expect(leafName("main")).toBe("main");
  });
});

describe("folderHoldsCurrent", () => {
  it("is true when the current branch lives under the folder (any depth)", () => {
    expect(folderHoldsCurrent("feature", "feature/api")).toBe(true);
    expect(folderHoldsCurrent("feature", "feature/x/y")).toBe(true);
  });

  it("is false for siblings, prefixes, and no current branch", () => {
    expect(folderHoldsCurrent("feature", "featureX/api")).toBe(false);
    expect(folderHoldsCurrent("feature", "main")).toBe(false);
    expect(folderHoldsCurrent("feature", null)).toBe(false);
    expect(folderHoldsCurrent("feature", undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `powershell.exe -Command "cd C:\NOT_WORK\LeGit; npx vitest run src/panels/Branches/branchTree.test.ts 2>&1 | Select-Object -Last 8"`
Expected: FAIL - module `./branchTree` not found.

- [ ] **Step 3: Implement**

`src/panels/Branches/branchTree.ts`:

```typescript
// Pure adapter: branch names are slash-paths, so the shared FileTree flatten
// (folder rows + compression + collapse) builds the Branches section's tree
// view. Git forbids a branch named like another branch's folder prefix
// ("feature" cannot coexist with "feature/api"), so mapping leaf rows back to
// branches by full path is total.

import { baseName, flatten, type Row } from "../shared/FileTree/buildTree";

/** Tree rows (folders first, alphabetical - `flatten`'s ordering) for the
 *  given branch names. Flat mode never calls this: the flat list renders
 *  exactly as before, sort mode included. */
export function branchTreeRows(names: string[], collapsed: ReadonlySet<string>): Row[] {
  return flatten(
    names.map((name) => ({ path: name })),
    "tree",
    collapsed,
  );
}

/** Display segment for a leaf row (full name stays in tooltips/actions). */
export const leafName = baseName;

/** True when the checked-out branch lives anywhere under this folder - a
 *  collapsed folder shows the current-branch dot so the checkout is never
 *  invisible. */
export function folderHoldsCurrent(
  folderPath: string,
  currentName: string | null | undefined,
): boolean {
  return !!currentName && currentName.startsWith(`${folderPath}/`);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `powershell.exe -Command "cd C:\NOT_WORK\LeGit; npx vitest run src/panels/Branches/branchTree.test.ts 2>&1 | Select-Object -Last 5"`
Expected: PASS (all tests).

---

### Task 3: Shared segmented-toggle style

**Files:**
- Create: `src/panels/shared/segmented.ts`
- Modify: `src/panels/Files/FilesPanel.tsx` (`segStyle` definition ~line 471 and its two uses ~lines 235-238)

**Interfaces:**
- Produces: `segStyle(active: boolean, side: "left" | "right"): React.CSSProperties` exported from `src/panels/shared/segmented.ts`.

- [ ] **Step 1: Move `segStyle`**

Cut the `segStyle` function out of `FilesPanel.tsx` VERBATIM (keep its body byte-identical - it already uses only theme tokens) into `src/panels/shared/segmented.ts`:

```typescript
// Segmented two-button toggle style (Tree | List), shared by the Files panel
// and the Branches section. Extracted verbatim from FilesPanel.
```

with `export function segStyle(...)` and any imports its body needs. In `FilesPanel.tsx`, delete the local definition and add:

```typescript
import { segStyle } from "../shared/segmented";
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit 2>&1 | tail -3`
Expected: clean.

---

### Task 4: Branches section renders the tree

**Files:**
- Modify: `src/panels/Branches/BranchesPanel.tsx`:
  - imports (top),
  - view-mode read + collapse state in `BranchesSection` (~line 136 area),
  - section header toggle + local list (~lines 297-344),
  - remote group bodies (~lines 346-385),
  - `LocalBranchRow` props (`displayName`, ~line 515 + name span ~line 606).

**Interfaces:**
- Consumes: Task 1's `useSettingsStore` `settings?.branch_list_view` + `setBranchListView`; Task 2's `branchTreeRows`/`leafName`/`folderHoldsCurrent`; Task 3's `segStyle`; existing `ChevronDownIcon`/`ChevronRightIcon` from `../../icons`.
- Produces: internal `BranchFolderRow` component (not exported).

- [ ] **Step 1: View mode + collapse state**

In `BranchesSection`, next to the `sortMode` read (~line 136):

```typescript
  const branchView = useSettingsStore((s) =>
    s.settings?.branch_list_view === "tree" ? "tree" : "flat",
  );
  const setBranchListView = useSettingsStore((s) => s.setBranchListView);
  // Collapse state is ephemeral and per-list (local + one per remote group),
  // keyed by a list id so folder paths can repeat across lists. Folders
  // default to expanded - absent from the set = expanded.
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  const toggleFolder = useCallback((listId: string, path: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      const key = `${listId}\0${path}`;
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const collapsedFor = useCallback(
    (listId: string): ReadonlySet<string> => {
      const prefix = `${listId}\0`;
      const out = new Set<string>();
      for (const key of collapsedFolders) {
        if (key.startsWith(prefix)) out.add(key.slice(prefix.length));
      }
      return out;
    },
    [collapsedFolders],
  );
```

- [ ] **Step 2: Folder row component**

Add near the other subcomponents (after `SectionLabel`, ~line 433):

```typescript
/** A collapsible folder row of the branch tree: chevron + name + count.
 *  Shows the current-branch dot while collapsed and hiding the checkout. */
function BranchFolderRow({
  label,
  depth,
  count,
  collapsed,
  holdsCurrent,
  onToggle,
}: {
  label: string;
  depth: number;
  count: number;
  collapsed: boolean;
  holdsCurrent: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      title={collapsed ? `Expand ${label}` : `Collapse ${label}`}
      style={{
        background: "none",
        border: "none",
        padding: 0,
        marginLeft: `${depth * 1.25}em`,
        display: "flex",
        alignItems: "center",
        gap: 4,
        cursor: "pointer",
        fontSize: "var(--fz-lg)",
        fontFamily: "monospace",
        color: "var(--panel-fg)",
      }}
    >
      {collapsed ? <ChevronRightIcon /> : <ChevronDownIcon />}
      {label}
      {collapsed && holdsCurrent && (
        // Same token as the checked-out chip/row dot: the hidden checkout
        // stays visible on the folder.
        <span style={{ color: "var(--ref-branch-current-fg, rgb(130, 220, 130))" }}>●</span>
      )}
      <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)" }}>({count})</span>
    </button>
  );
}
```

Add `ChevronRightIcon` to the existing icons import.

- [ ] **Step 3: Section header toggle**

At the top of the panel body (before the Local list block, ~line 305), one control governs both lists:

```tsx
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <div style={{ display: "flex" }}>
            <button
              onClick={() => setBranchListView("tree")}
              aria-pressed={branchView === "tree"}
              style={segStyle(branchView === "tree", "left")}
            >
              Tree
            </button>
            <button
              onClick={() => setBranchListView("flat")}
              aria-pressed={branchView === "flat"}
              style={segStyle(branchView === "flat", "right")}
            >
              List
            </button>
          </div>
        </div>
```

- [ ] **Step 4: Local list tree mode**

Extract the existing `<LocalBranchRow ...>` JSX (~lines 308-342) into a local render helper inside `BranchesSection` so flat and tree mode share it VERBATIM (flat mode must not change):

```typescript
  const renderLocalRow = (b: Branch, displayName?: string) => (
    <LocalBranchRow
      key={b.name}
      branch={b}
      displayName={displayName}
      /* ...all existing props verbatim... */
    />
  );
```

Replace the local list body:

```tsx
            {branchView === "flat"
              ? localBranches.map((b) => renderLocalRow(b))
              : branchTreeRows(localBranches.map((b) => b.name), collapsedFor("local")).map((row) =>
                  row.kind === "dir" ? (
                    <BranchFolderRow
                      key={`d:${row.path}`}
                      label={row.label}
                      depth={row.depth}
                      count={row.fileCount}
                      collapsed={row.collapsed}
                      holdsCurrent={folderHoldsCurrent(row.path, currentBranch)}
                      onToggle={() => toggleFolder("local", row.path)}
                    />
                  ) : (
                    <div key={row.path} style={{ marginLeft: `${row.depth * 1.25}em` }}>
                      {renderLocalRow(localByName.get(row.path)!, leafName(row.path))}
                    </div>
                  ),
                )}
```

with `const localByName = useMemo(() => new Map(localBranches.map((b) => [b.name, b])), [localBranches]);` and imports `branchTreeRows, folderHoldsCurrent, leafName` from `./branchTree`. (`currentBranch` already exists in the component - it feeds the menu sections.)

- [ ] **Step 5: Remote groups tree mode**

Inside each remote group's `!collapsed && ...` body, the same split keyed per remote (`listId = remote:${group.remote}`): flat mode keeps `group.branches.map(...)` verbatim; tree mode maps `branchTreeRows(group.branches.map((b) => shortRemoteBranchName(b.name, group.remote)), collapsedFor(\`remote:${group.remote}\`))` - folder rows as in Step 4 (holdsCurrent always false: the checkout is never a remote ref), leaf rows look up the branch via a per-group `Map<string, Branch>` keyed by short name and pass `shortName={leafName(row.path)}` to the existing `RemoteBranchRow` (full `b.name` keeps feeding actions/menus), wrapped in the same `marginLeft` div.

- [ ] **Step 6: `displayName` on LocalBranchRow**

`LocalBranchRow` props gain `displayName?: string`; the name span (~line 606) renders `{displayName ?? branch.name}` and gains `title={branch.name}`. Rename editors and every action keep using `branch.name`.

- [ ] **Step 7: Type-check and test**

Run: `npx tsc --noEmit 2>&1 | tail -3` then `powershell.exe -Command "cd C:\NOT_WORK\LeGit; npx vitest run 2>&1 | Select-Object -Last 5"`
Expected: clean / all pass.

---

### Task 5: Whole-slice verification and wrap-up

- [ ] **Step 1: Full verification**

Run: `cargo check -p legit-app 2>&1 | tail -3`, `npx tsc --noEmit 2>&1 | tail -3`, full vitest.
Expected: all clean.

- [ ] **Step 2: Spec note**

Append to the spec's Design section: "Tree mode uses `flatten`'s ordering (folders first, alphabetical); the `refs_sort_mode` setting applies to the flat list only."

- [ ] **Step 3: Manual smoke test (user, running app)**

LeGit-Test has `feature/api` + `feature/new-pricing`: toggle Tree - a collapsible `feature` folder appears in Local (and under origin if fetched); collapse it while a feature branch is checked out - green dot on the folder; rename/delete/checkout from a nested row still act on the full name; toggle List - exactly the previous flat list; restart the app - the choice persisted.

- [ ] **Step 4: Leave everything uncommitted.**
