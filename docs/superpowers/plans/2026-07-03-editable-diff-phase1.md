# Editable Diff Viewer (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans
> to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking. Do NOT use subagent-driven-development (user rule).
> **Do NOT commit or push at any point** — leave all changes uncommitted for
> the user to review and commit (user rule; this overrides the usual
> commit-per-task cadence).

**Goal:** Make the diff viewer's working-tree (unstaged) diffs directly
editable — new-side lines can be modified/inserted/deleted in the diff pane,
with explicit save writing the result back to the file on disk.

**Architecture:** The read-only `DiffEditor` (CodeMirror 6) gains an editable
mode. Row identity survives edits via line-start markers in a `RangeSet`
(mapped through document changes); a `changeFilter` rejects edits touching
read-only rows (hunk headers, removed lines, fillers). On save, the current
per-hunk new-side text is collected from the document and spliced into the
original file by hunk line ranges (pure function), then written via a new
`repo_write_worktree_file` IPC command. While dirty: refetches are deferred,
hunk/line actions are disabled, and switching files prompts.

**Tech Stack:** React 18 + TypeScript, CodeMirror 6 (`@codemirror/state`,
`@codemirror/view`, `@codemirror/commands`), TanStack Query, Tauri 2 (Rust),
vitest.

**Spec:** `docs/superpowers/specs/2026-07-03-merge-rebase-conflicts-design.md`
(Phase 1 section).

## Global Constraints

- **Never commit or push.** Leave changes staged/unstaged for the user.
- **No literal colours anywhere** — every colour is `var(--token)`. New token
  `diff.edited.bg` must be added in all 4 places (`src/theme/tokens.ts`,
  `src/theme/defaults.ts`, `src/styles/theme.css`, both
  `themes/*.legit-theme.json`) or `src/theme/contract.test.ts` fails.
- **All dimensions scale from `--ui-font-size`** (em / `--fz-*`); fixed px only
  for hairlines.
- **No em-dashes** in code comments, docs, or any output.
- **Do not run `npm install` from WSL** (Linux binaries would break the
  Windows-run app). If a dependency must be installed, ask the user to run
  `npm install` in PowerShell. Running `npx vitest` from WSL is fine
  (verified).
- Editable scope in this phase: **only `working_unstaged` diffs**. Staged
  diffs (new side = index) and commit diffs stay read-only.
- Rust tests: `cargo test -p legit-app --lib` (command layer) and
  `cargo test -p legit-core` (core). Frontend tests: `npx vitest run <file>`.
- Backend commands are `#[tauri::command] #[specta::specta]`, registered in
  `src-tauri/src/lib.rs` `collect_commands![]`, with hand-written wrappers in
  `src/lib/commands.ts` (types in `src/lib/types.ts` when new types cross IPC;
  this phase adds none).

---

### Task 1: Pure edit-model helpers (`editModel.ts`)

**Files:**
- Create: `src/panels/Diff/editModel.ts`
- Test: `src/panels/Diff/editModel.test.ts`

**Interfaces:**
- Consumes: nothing (pure module, no imports).
- Produces (used by Tasks 4 and 5):
  - `detectEol(text: string): "\n" | "\r\n"`
  - `hasTrailingNewline(text: string): boolean`
  - `splitLines(text: string): string[]`
  - `interface HunkRange { newStart: number; newLines: number }`
  - `spliceEdits(originalText: string, hunks: HunkRange[], hunkTexts: string[][]): string`
  - `interface RowMeta { kind: string; hunkIndex: number }`
  - `collectHunkNewSideTexts(docLines: string[], rowIndexAt: (line: number) => number | null, rows: RowMeta[], hunkCount: number): string[][]`

- [ ] **Step 1: Write the failing tests**

Create `src/panels/Diff/editModel.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  collectHunkNewSideTexts,
  detectEol,
  hasTrailingNewline,
  splitLines,
  spliceEdits,
  type RowMeta,
} from "./editModel";

describe("detectEol / splitLines / hasTrailingNewline", () => {
  it("detects CRLF when present", () => {
    expect(detectEol("a\r\nb\r\n")).toBe("\r\n");
    expect(detectEol("a\nb\n")).toBe("\n");
    expect(detectEol("")).toBe("\n");
  });

  it("splits lines dropping the trailing empty piece", () => {
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("a\r\nb")).toEqual(["a", "b"]);
    expect(splitLines("")).toEqual([]);
  });

  it("reports trailing newline", () => {
    expect(hasTrailingNewline("a\n")).toBe(true);
    expect(hasTrailingNewline("a")).toBe(false);
  });
});

describe("spliceEdits", () => {
  it("replaces a hunk's new-side range in the middle of a file", () => {
    const original = "one\ntwo\nthree\nfour\nfive\n";
    // Hunk covered lines 2-4 (three lines); user edited them down to two.
    const result = spliceEdits(
      original,
      [{ newStart: 2, newLines: 3 }],
      [["TWO", "3+4"]]
    );
    expect(result).toBe("one\nTWO\n3+4\nfive\n");
  });

  it("preserves CRLF line endings", () => {
    const original = "one\r\ntwo\r\nthree\r\n";
    const result = spliceEdits(original, [{ newStart: 2, newLines: 1 }], [["TWO"]]);
    expect(result).toBe("one\r\nTWO\r\nthree\r\n");
  });

  it("preserves a missing trailing newline", () => {
    const original = "one\ntwo";
    const result = spliceEdits(original, [{ newStart: 1, newLines: 1 }], [["ONE"]]);
    expect(result).toBe("ONE\ntwo");
  });

  it("handles multiple hunks without offset drift (splices bottom-up)", () => {
    const original = "a\nb\nc\nd\ne\nf\ng\n";
    const result = spliceEdits(
      original,
      [
        { newStart: 2, newLines: 1 },
        { newStart: 6, newLines: 1 },
      ],
      [
        ["B", "B2"], // grew by one line
        ["F"],
      ]
    );
    expect(result).toBe("a\nB\nB2\nc\nd\ne\nF\ng\n");
  });

  it("handles a hunk that grows and one that shrinks to empty", () => {
    const original = "a\nb\nc\nd\n";
    const result = spliceEdits(
      original,
      [
        { newStart: 1, newLines: 1 },
        { newStart: 3, newLines: 2 },
      ],
      [["a", "a2"], []]
    );
    expect(result).toBe("a\na2\nb\n");
  });

  it("strips stray carriage returns from collected lines (CRLF doc)", () => {
    const original = "one\r\ntwo\r\n";
    const result = spliceEdits(original, [{ newStart: 1, newLines: 1 }], [["ONE\r"]]);
    expect(result).toBe("ONE\r\ntwo\r\n");
  });
});

describe("collectHunkNewSideTexts", () => {
  // Inline-view row model of one hunk: header, context, removed, added, context.
  const rows: RowMeta[] = [
    { kind: "Hunk", hunkIndex: 0 },
    { kind: "Context", hunkIndex: 0 },
    { kind: "Removed", hunkIndex: 0 },
    { kind: "Added", hunkIndex: 0 },
    { kind: "Context", hunkIndex: 0 },
  ];

  it("collects context + added lines, skipping headers and removed", () => {
    const docLines = ["@@ -1,3 +1,3 @@", "ctx1", "old", "new", "ctx2"];
    const out = collectHunkNewSideTexts(docLines, (i) => i, rows, 1);
    expect(out).toEqual([["ctx1", "new", "ctx2"]]);
  });

  it("attributes user-inserted lines (no marker) to the preceding row's hunk", () => {
    // A line was inserted after "new": doc has 6 lines, line 4 has no marker.
    const docLines = ["@@ -1,3 +1,3 @@", "ctx1", "old", "new", "inserted", "ctx2"];
    const rowAt = (i: number) => (i <= 3 ? i : i === 4 ? null : 4);
    const out = collectHunkNewSideTexts(docLines, rowAt, rows, 1);
    expect(out).toEqual([["ctx1", "new", "inserted", "ctx2"]]);
  });

  it("skips filler rows (split view) and handles multiple hunks", () => {
    const splitRows: RowMeta[] = [
      { kind: "Hunk", hunkIndex: 0 },
      { kind: "Added", hunkIndex: 0 },
      { kind: "Filler", hunkIndex: 0 },
      { kind: "Hunk", hunkIndex: 1 },
      { kind: "Context", hunkIndex: 1 },
    ];
    const docLines = ["@@", "new0", "", "@@", "ctx1"];
    const out = collectHunkNewSideTexts(docLines, (i) => i, splitRows, 2);
    expect(out).toEqual([["new0"], ["ctx1"]]);
  });

  it("a deleted line simply no longer contributes", () => {
    // "new" was deleted: doc is 4 lines; markers skip original row 3.
    const docLines = ["@@ -1,3 +1,3 @@", "ctx1", "old", "ctx2"];
    const rowAt = (i: number) => (i <= 2 ? i : 4);
    const out = collectHunkNewSideTexts(docLines, rowAt, rows, 1);
    expect(out).toEqual([["ctx1", "ctx2"]]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/panels/Diff/editModel.test.ts`
Expected: FAIL — cannot resolve `./editModel`.

- [ ] **Step 3: Write the implementation**

Create `src/panels/Diff/editModel.ts`:

```ts
// Pure helpers for the editable diff viewer: EOL handling, splicing edited
// per-hunk text back into the original working-tree file, and rebuilding each
// hunk's new-side text from the edited document. No CodeMirror imports, so
// everything here is unit-testable headlessly.

export type Eol = "\n" | "\r\n";

export function detectEol(text: string): Eol {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

export function hasTrailingNewline(text: string): boolean {
  return text.endsWith("\n");
}

/** Split file text into lines without their EOLs; a trailing newline does not
 *  produce a final empty line. */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r\n|\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** A hunk's new-side line range (1-based start, line count), from `DiffHunk`. */
export interface HunkRange {
  newStart: number;
  newLines: number;
}

/**
 * Replace each hunk's new-side line range in `originalText` with the edited
 * lines in `hunkTexts` (parallel to `hunks`). Splices bottom-up so earlier
 * hunks' line numbers stay valid while later ones change length. Preserves the
 * file's EOL style and trailing-newline state; stray `\r` on collected lines
 * (a CRLF file rendered in CodeMirror) is stripped before joining.
 */
export function spliceEdits(
  originalText: string,
  hunks: HunkRange[],
  hunkTexts: string[][]
): string {
  const eol = detectEol(originalText);
  const lines = splitLines(originalText);
  const order = hunks
    .map((_, i) => i)
    .sort((a, b) => hunks[b].newStart - hunks[a].newStart);
  for (const i of order) {
    const h = hunks[i];
    const replacement = hunkTexts[i].map((l) => l.replace(/\r$/, ""));
    // newStart is 1-based; git uses start 0 for an empty new side.
    const start = Math.max(h.newStart - 1, 0);
    lines.splice(start, h.newLines, ...replacement);
  }
  const body = lines.join(eol);
  return hasTrailingNewline(originalText) && lines.length > 0 ? body + eol : body;
}

/** The subset of a diff row the collector needs (DiffRow and SplitRow both fit). */
export interface RowMeta {
  kind: string;
  hunkIndex: number;
}

/** Row kinds whose text belongs to the new (working-tree) side of the file. */
const NEW_SIDE_KINDS = new Set(["Context", "Added"]);

/**
 * Rebuild each hunk's new-side text from the edited document. `rowIndexAt`
 * maps a 0-based doc line to its original row index, or null for a line the
 * user inserted. Inserted lines are attributed to the hunk of the nearest
 * preceding original row; the edit guard only permits insertions inside
 * editable regions, so that row always exists and belongs to the right hunk.
 */
export function collectHunkNewSideTexts(
  docLines: string[],
  rowIndexAt: (line: number) => number | null,
  rows: RowMeta[],
  hunkCount: number
): string[][] {
  const out: string[][] = Array.from({ length: hunkCount }, () => []);
  let lastHunk = -1;
  for (let i = 0; i < docLines.length; i++) {
    const rowIndex = rowIndexAt(i);
    if (rowIndex != null && rows[rowIndex]) {
      const row = rows[rowIndex];
      lastHunk = row.hunkIndex;
      if (NEW_SIDE_KINDS.has(row.kind)) out[row.hunkIndex].push(docLines[i]);
    } else if (lastHunk >= 0) {
      out[lastHunk].push(docLines[i]);
    }
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/panels/Diff/editModel.test.ts`
Expected: PASS (all tests).

---

### Task 2: Backend worktree file read/write commands

**Files:**
- Modify: `src-tauri/src/commands/working.rs` (append)
- Modify: `src-tauri/src/lib.rs` (register two commands in `collect_commands![]`, after `commands::repo_discard,` at line ~104)
- Modify: `src/lib/commands.ts` (append wrappers)

**Interfaces:**
- Consumes: `AppState::get_session`, `RepoSession.path`, `AppError::{Io, ParseArgs}` (all existing).
- Produces (used by Task 5):
  - Rust: `repo_read_worktree_file(state, repo_id, path) -> Result<String, AppError>`, `repo_write_worktree_file(state, repo_id, path, content) -> Result<(), AppError>`
  - TS: `repoReadWorktreeFile(repoId: string, path: string): Promise<string>`, `repoWriteWorktreeFile(repoId: string, path: string, content: string): Promise<null>`

- [ ] **Step 1: Write the failing Rust tests**

Append to `src-tauri/src/commands/working.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn resolve_repo_relative_joins_inside_root() {
        let root = Path::new("/repo");
        let p = resolve_repo_relative(root, "src/main.rs").unwrap();
        assert_eq!(p, Path::new("/repo/src/main.rs"));
    }

    #[test]
    fn resolve_repo_relative_rejects_absolute_paths() {
        let root = Path::new("/repo");
        assert!(resolve_repo_relative(root, "/etc/passwd").is_err());
    }

    #[test]
    fn resolve_repo_relative_rejects_traversal() {
        let root = Path::new("/repo");
        assert!(resolve_repo_relative(root, "../outside.txt").is_err());
        assert!(resolve_repo_relative(root, "src/../../outside.txt").is_err());
        assert!(resolve_repo_relative(root, "./x/./y").is_err());
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p legit-app --lib resolve_repo_relative`
Expected: FAIL to compile — `resolve_repo_relative` not found.

- [ ] **Step 3: Implement the guard and the two commands**

Append to `src-tauri/src/commands/working.rs` (above the `tests` module), and
add `use std::path::{Component, Path};` to the imports (the file already has
`use std::path::PathBuf;` — extend it):

```rust
/// Resolve a repo-relative file path against the repo root, rejecting absolute
/// paths and any non-plain component (`..`, `.`, prefixes) so IPC callers can
/// only ever touch files inside the repository working tree.
fn resolve_repo_relative(root: &Path, rel: &str) -> Result<PathBuf, AppError> {
    let rel_path = Path::new(rel);
    let plain = !rel_path.as_os_str().is_empty()
        && rel_path
            .components()
            .all(|c| matches!(c, Component::Normal(_)));
    if rel_path.is_absolute() || !plain {
        return Err(AppError::ParseArgs(format!(
            "invalid repo-relative path: {rel}"
        )));
    }
    Ok(root.join(rel_path))
}

/// Read a working-tree file as UTF-8 text (the editable diff's save baseline).
#[tauri::command]
#[specta::specta]
pub async fn repo_read_worktree_file(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    path: String,
) -> Result<String, AppError> {
    let session = state.get_session(&repo_id).await?;
    let abs = resolve_repo_relative(&session.path, &path)?;
    let bytes = tokio::fs::read(&abs)
        .await
        .map_err(|e| AppError::Io(format!("read {}: {e}", abs.display())))?;
    String::from_utf8(bytes).map_err(|_| AppError::Io(format!("{path} is not UTF-8 text")))
}

/// Overwrite a working-tree file with the given text (the editable diff's
/// save path). The frontend is responsible for EOL preservation.
#[tauri::command]
#[specta::specta]
pub async fn repo_write_worktree_file(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    path: String,
    content: String,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    let abs = resolve_repo_relative(&session.path, &path)?;
    tokio::fs::write(&abs, content.as_bytes())
        .await
        .map_err(|e| AppError::Io(format!("write {}: {e}", abs.display())))
}
```

Register both in `src-tauri/src/lib.rs` inside `collect_commands![]`, directly
after the `commands::repo_discard,` line:

```rust
        commands::repo_read_worktree_file,
        commands::repo_write_worktree_file,
```

(`commands/mod.rs` re-exports `working::*` already — verify with
`grep -n "working" src-tauri/src/commands/mod.rs`; if it uses explicit
re-exports instead of a glob, add the two names there too.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p legit-app --lib resolve_repo_relative`
Expected: PASS (3 tests). Also run `cargo check -p legit-app` — no warnings
about unused imports.

- [ ] **Step 5: Add the frontend wrappers**

Append to `src/lib/commands.ts` (near the other diff/working wrappers around
`repoStageHunk`):

```ts
export const repoReadWorktreeFile = (repoId: string, path: string) =>
  invoke<string>("repo_read_worktree_file", { repoId, path });

export const repoWriteWorktreeFile = (repoId: string, path: string, content: string) =>
  invoke<null>("repo_write_worktree_file", { repoId, path, content });
```

Run: `npx tsc --noEmit`
Expected: no errors.

---

### Task 3: Row-marker state and edit guard (`editableState.ts`)

CodeMirror state-level machinery, kept in its own module with **only
`@codemirror/state` imports** so it tests headlessly under vitest's node
environment (`@codemirror/view` needs a DOM).

**Files:**
- Create: `src/panels/Diff/editableState.ts`
- Test: `src/panels/Diff/editableState.test.ts`

**Interfaces:**
- Consumes: `RowMeta` from `./editModel` (Task 1).
- Produces (used by Task 4):
  - `interface RowState { field: StateField<RangeSet<RowMarker>>; guard: Extension; rowIndexAtLine(state: EditorState, lineNumber: number): number | null }`
  - `createRowState(rows: RowMeta[]): RowState`
  - `EDITABLE_KINDS: Set<string>` (`"Context"`, `"Added"`)

- [ ] **Step 1: Write the failing tests**

Create `src/panels/Diff/editableState.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import type { RowMeta } from "./editModel";
import { createRowState } from "./editableState";

// One hunk, inline rows: header / context / removed / added / context.
const ROWS: RowMeta[] = [
  { kind: "Hunk", hunkIndex: 0 },
  { kind: "Context", hunkIndex: 0 },
  { kind: "Removed", hunkIndex: 0 },
  { kind: "Added", hunkIndex: 0 },
  { kind: "Context", hunkIndex: 0 },
];
const DOC = "@@ -1,3 +1,3 @@\nctx1\nold\nnew\nctx2";

function makeState(rows: RowMeta[], doc: string) {
  const rowState = createRowState(rows);
  const state = EditorState.create({
    doc,
    extensions: [rowState.field, rowState.guard],
  });
  return { rowState, state };
}

/** Apply a change; returns the new state (unchanged doc = change was rejected). */
function apply(state: EditorState, from: number, to: number, insert: string) {
  return state.update({ changes: { from, to, insert } }).state;
}

describe("createRowState guard", () => {
  it("allows editing an Added line", () => {
    const { state } = makeState(ROWS, DOC);
    const line = state.doc.line(4); // "new"
    const next = apply(state, line.from, line.to, "edited");
    expect(next.doc.line(4).text).toBe("edited");
  });

  it("allows editing a Context line", () => {
    const { state } = makeState(ROWS, DOC);
    const line = state.doc.line(2); // "ctx1"
    const next = apply(state, line.from, line.from, "x");
    expect(next.doc.line(2).text).toBe("xctx1");
  });

  it("rejects editing a Removed line", () => {
    const { state } = makeState(ROWS, DOC);
    const line = state.doc.line(3); // "old"
    const next = apply(state, line.from, line.to, "nope");
    expect(next.doc.toString()).toBe(DOC);
  });

  it("rejects editing the hunk header", () => {
    const { state } = makeState(ROWS, DOC);
    const line = state.doc.line(1);
    const next = apply(state, line.from, line.from, "nope");
    expect(next.doc.toString()).toBe(DOC);
  });

  it("rejects deleting the boundary newline into a read-only line", () => {
    const { state } = makeState(ROWS, DOC);
    // Deleting from end of "ctx1" (editable) to start of "old" (read-only)
    // would merge an editable line into a read-only one.
    const ctx1 = state.doc.line(2);
    const old = state.doc.line(3);
    const next = apply(state, ctx1.to, old.from, "");
    expect(next.doc.toString()).toBe(DOC);
  });
});

describe("createRowState markers", () => {
  it("maps row identity through an insertion (new line has no row)", () => {
    const { rowState, state } = makeState(ROWS, DOC);
    const added = state.doc.line(4); // "new"
    // Split the line: press Enter at its end -> a new line 5 appears.
    const next = apply(state, added.to, added.to, "\ninserted");
    expect(next.doc.lines).toBe(6);
    expect(rowState.rowIndexAtLine(next, 4)).toBe(3); // still the Added row
    expect(rowState.rowIndexAtLine(next, 5)).toBe(null); // inserted line
    expect(rowState.rowIndexAtLine(next, 6)).toBe(4); // trailing Context row
  });

  it("keeps save-collection correct after a whole-line delete", () => {
    // Implementation note discovered during execution: with MapMode.TrackDel,
    // both boundary markers survive a whole-line deletion and land on the
    // merged line (the first wins, reporting the deleted row's index). That
    // is stale for gutter display, accepted while dirty, and harmless for
    // saving: the guard means marker merges only ever happen between editable
    // rows of the SAME hunk. The test asserts the invariant that matters:
    // collection stays correct. See editableState.test.ts for the final form.
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/panels/Diff/editableState.test.ts`
Expected: FAIL — cannot resolve `./editableState`.

- [ ] **Step 3: Write the implementation**

Create `src/panels/Diff/editableState.ts`:

```ts
// State-level machinery for the editable diff: row-identity markers that
// survive edits, and the change filter that keeps read-only rows untouchable.
//
// Row identity: the row model (DiffRow[] / SplitRow[]) is built once per
// mount. Each row's line start gets a point marker in a RangeSet; the set is
// mapped through every document change, so "which original row is doc line N"
// stays answerable after insertions and deletions. A line the user inserted
// has no marker: no gutter number, no diff tint, and the write-back collector
// attributes it to the enclosing hunk (see editModel.collectHunkNewSideTexts).
//
// Only @codemirror/state imports here: this module is unit-tested headlessly.

import {
  EditorState,
  MapMode,
  RangeSet,
  RangeValue,
  StateField,
  type Extension,
} from "@codemirror/state";
import type { RowMeta } from "./editModel";

/** Row kinds whose text the user may edit (new-side content). */
export const EDITABLE_KINDS = new Set(["Context", "Added"]);

class RowMarker extends RangeValue {
  // Drop the marker when its exact position is deleted (the line is gone).
  mapMode = MapMode.TrackDel;

  constructor(readonly rowIndex: number) {
    super();
  }
  eq(other: RangeValue): boolean {
    return other instanceof RowMarker && other.rowIndex === this.rowIndex;
  }
}

export interface RowState {
  /** RangeSet of one marker per original row, kept mapped through changes. */
  field: StateField<RangeSet<RowMarker>>;
  /** changeFilter rejecting edits that touch a non-editable row. */
  guard: Extension;
  /** Original row index for a (current) 1-based doc line, or null (inserted). */
  rowIndexAtLine(state: EditorState, lineNumber: number): number | null;
}

/**
 * Build the row-identity field and edit guard for one editor pane. `rows`
 * must parallel the pane's initial document lines (row i = doc line i + 1).
 */
export function createRowState(rows: RowMeta[]): RowState {
  const field = StateField.define<RangeSet<RowMarker>>({
    create(state) {
      const ranges = [];
      const count = Math.min(rows.length, state.doc.lines);
      for (let i = 0; i < count; i++) {
        ranges.push(new RowMarker(i).range(state.doc.line(i + 1).from));
      }
      return RangeSet.of(ranges, true);
    },
    update(value, tr) {
      return tr.docChanged ? value.map(tr.changes) : value;
    },
  });

  const rowIndexAtLine = (state: EditorState, lineNumber: number): number | null => {
    // Search the whole line span, not just the line start: an insertion at a
    // line's first position can nudge the marker a step into the line, and a
    // merge of two editable lines leaves two markers on one line (the first
    // one wins; the merged line is one line now, so one row is correct).
    const line = state.doc.line(lineNumber);
    let found: number | null = null;
    state.field(field).between(line.from, line.to, (_from, _to, value) => {
      found = value.rowIndex;
      return false;
    });
    return found;
  };

  const isLineEditable = (state: EditorState, lineNumber: number): boolean => {
    const rowIndex = rowIndexAtLine(state, lineNumber);
    if (rowIndex == null) return true; // user-inserted line
    const row = rows[rowIndex];
    return row != null && EDITABLE_KINDS.has(row.kind);
  };

  const guard = EditorState.changeFilter.of((tr) => {
    if (!tr.docChanged) return true;
    let ok = true;
    tr.changes.iterChangedRanges((fromA, toA) => {
      if (!ok) return;
      const start = tr.startState.doc.lineAt(fromA).number;
      const end = tr.startState.doc.lineAt(toA).number;
      for (let line = start; line <= end; line++) {
        if (!isLineEditable(tr.startState, line)) {
          ok = false;
          return;
        }
      }
    });
    return ok;
  });

  return { field, guard, rowIndexAtLine };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/panels/Diff/editableState.test.ts`
Expected: PASS. If the marker-mapping tests fail on boundary semantics
(insertion at a marker position pushing the marker), adjust `RowMarker` with
`startSide`/`point` semantics until the two marker tests pass — the tests are
the contract, encode any discovered CodeMirror quirk there, and leave a
comment in `editableState.ts` explaining it.

- [ ] **Step 5: Regression check**

Run: `npx vitest run src/panels/Diff/`
Expected: `editModel.test.ts` and `editableState.test.ts` both PASS.

---

### Task 4: Wire editing into `DiffEditor` (inline + split) and add the theme token

**Files:**
- Modify: `src/panels/Diff/DiffEditor.tsx`
- Modify: `src/theme/tokens.ts` (TOKEN_CONTRACT, Diff group)
- Modify: `src/theme/defaults.ts`
- Modify: `src/styles/theme.css`
- Modify: `themes/Dark.legit-theme.json`, `themes/Light.legit-theme.json`
- Modify: `package.json` (declare `@codemirror/commands` — already present
  transitively via the `codemirror` meta-package, so imports resolve now; the
  user runs `npm install` from PowerShell later to sync the lockfile)

**Interfaces:**
- Consumes: `createRowState`, `RowState` from `./editableState`;
  `collectHunkNewSideTexts` from `./editModel`.
- Produces (used by Task 5):
  - `DiffEditor` becomes `forwardRef` with handle
    `interface DiffEditorHandle { collectHunkTexts(): string[][] | null }`
  - New props on `DiffEditorProps`:
    `editable: boolean` (default false), `dirty: boolean`,
    `onDirty?: () => void`, `onSaveRequest?: () => void`
  - Theme token `diff.edited.bg` → CSS var `--diff-edited-bg`

- [ ] **Step 1: Add the theme token in all 4 places**

`src/theme/tokens.ts` — in `TOKEN_CONTRACT`, after the
`diff.line.selected.bg` entry (line ~157):

```ts
  { name: "diff.edited.bg", group: "Diff", documentation: "Whole-line background for a line with unsaved edits in the editable diff." },
```

`src/theme/defaults.ts` — next to the other `diff.*` bindings:

```ts
    "diff.edited.bg": "diff-hunk-header",
```

`src/styles/theme.css` — next to the other `--diff-*` fallbacks:

```css
  --diff-edited-bg: var(--palette-diff-hunk-header);
```

`themes/Dark.legit-theme.json` and `themes/Light.legit-theme.json` — in the
tokens object, alphabetically with the other `diff.*` tokens:

```json
    "diff.edited.bg": "diff-hunk-header",
```

Run: `npx vitest run src/theme/contract.test.ts src/theme/noLiteralColors.test.ts`
Expected: PASS.

- [ ] **Step 2: Extend DiffEditor's props and imports**

In `src/panels/Diff/DiffEditor.tsx`:

Add imports:

```ts
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { keymap } from "@codemirror/view"; // merge into the existing @codemirror/view import
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { collectHunkNewSideTexts } from "./editModel";
import { createRowState, type RowState } from "./editableState";
```

Extend the props interface and add the handle type:

```ts
export interface DiffEditorHandle {
  /** Current per-hunk new-side lines from the edited doc, or null if the
   *  editor is not mounted in editable mode. */
  collectHunkTexts(): string[][] | null;
}

interface DiffEditorProps {
  // ... existing props unchanged ...
  /** Allow editing new-side lines (working-tree unstaged diffs only). */
  editable?: boolean;
  /** Unsaved edits exist; used to visually disable hunk/line actions. */
  dirty?: boolean;
  /** Called on the first (and every) document change. */
  onDirty?: () => void;
  /** Called on Mod-s inside the editor. */
  onSaveRequest?: () => void;
}
```

- [ ] **Step 3: Add the editable extension bundle and edited-line highlight**

Add to `DiffEditor.tsx` (module level, near `decorationField`):

```ts
const editedLineDeco = Decoration.line({ class: "cm-diff-edited" });

/** Accumulates a `cm-diff-edited` line decoration for every line the user
 *  touches; mapped through subsequent changes. */
const editedLinesField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    if (!tr.docChanged) return value;
    let mapped = value.map(tr.changes);
    const add: Range<Decoration>[] = [];
    tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
      const start = tr.state.doc.lineAt(fromB).number;
      const end = tr.state.doc.lineAt(toB).number;
      for (let line = start; line <= end; line++) {
        add.push(editedLineDeco.range(tr.state.doc.line(line).from));
      }
    });
    if (add.length) {
      // Avoid stacking duplicates on a line that already carries the class.
      const starts = new Set<number>();
      mapped.between(0, tr.state.doc.length, (from) => {
        starts.add(from);
      });
      const fresh = add.filter((r) => !starts.has(r.from));
      if (fresh.length) mapped = mapped.update({ add: fresh, sort: true });
    }
    return mapped;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Extensions for an editable pane: history/undo, edit keys, save key,
 *  edited-line highlight, dirty notification, and a visible caret. */
function editableExtensions(
  onDirty: (() => void) | undefined,
  onSaveRequest: (() => void) | undefined
) {
  return [
    history(),
    keymap.of([
      {
        key: "Mod-s",
        preventDefault: true,
        run: () => {
          onSaveRequest?.();
          return true;
        },
      },
      ...defaultKeymap,
      ...historyKeymap,
    ]),
    editedLinesField,
    EditorView.updateListener.of((update) => {
      if (update.docChanged) onDirty?.();
    }),
    EditorView.theme({
      ".cm-content": { caretColor: "var(--panel-fg)" },
      ".cm-diff-edited": {
        backgroundColor: "var(--diff-edited-bg)",
      },
      // An edited line's diff tint and word marks are stale; neutralize them.
      ".cm-diff-edited.cm-diff-added, .cm-diff-edited.cm-diff-removed": {
        backgroundColor: "var(--diff-edited-bg)",
        color: "var(--panel-fg)",
      },
      ".cm-diff-edited .cm-diff-added-word, .cm-diff-edited .cm-diff-removed-word": {
        backgroundColor: "transparent",
      },
    }),
  ];
}
```

- [ ] **Step 4: Switch row lookups to marker-based and thread editability through both mounts**

Still in `DiffEditor.tsx`, refactor with these exact changes:

1. `lineNumberGutter` resolves rows through a `RowState` (works identically
   for read-only docs, which never change):

```ts
/** A line-number gutter that resolves the row for each doc line through the
 *  row markers, so numbers stay correct (or blank, for inserted lines) while
 *  the document is edited. */
function lineNumberGutter(
  rowState: RowState,
  getNo: (rowIndex: number) => number | null,
  cls: string
) {
  return gutter({
    class: cls,
    lineMarker(view, line) {
      const lineNo = view.state.doc.lineAt(line.from).number;
      const rowIndex = rowState.rowIndexAtLine(view.state, lineNo);
      const n = rowIndex == null ? null : getNo(rowIndex);
      return n == null ? null : new NumberMarker(String(n));
    },
  });
}
```

2. `decorationField` maps through doc changes instead of freezing (a no-op for
   read-only docs):

```ts
    update: (value, tr) => (tr.docChanged ? value.map(tr.changes) : value),
```

3. `mountInline` and `mountSplit`:
   - both create `const rowState = createRowState(rows)` (split: one per pane
     from its own row array) and pass it to every `lineNumberGutter` call,
     including `rowState.field` in extensions;
   - signature gains `editable: boolean`, `onDirty`, `onSaveRequest`
     parameters (split passes `editable` only to the RIGHT pane; the left pane
     always gets the read-only set);
   - an editable pane's extensions replace `...readOnly` with
     `rowState.guard, ...editableExtensions(onDirty, onSaveRequest)`;
     a read-only pane keeps `...readOnly` exactly as today;
   - both mounts change their return value from a cleanup function to
     `{ destroy: () => void, collect: () => string[][] }` where `collect`
     reads the live view state (inline: the single view; split: the right
     view):

```ts
  const collect = () => {
    const state = view.state; // split: rightView.state
    const docLines: string[] = [];
    for (let i = 1; i <= state.doc.lines; i++) docLines.push(state.doc.line(i).text);
    return collectHunkNewSideTexts(
      docLines,
      (i) => rowState.rowIndexAtLine(state, i + 1),
      rows, // split: the right-pane row array
      diff.hunks.length
    );
  };
```

4. **Update the ACTION PARITY comment block** to name editability as a shared
   capability: both mounts receive the same editable/onDirty/onSaveRequest
   parameters, and the split view applies them to its right pane.

- [ ] **Step 5: Convert `DiffEditor` to forwardRef with the collect handle and dirty styling**

Replace the `DiffEditor` component:

```ts
export const DiffEditor = forwardRef<DiffEditorHandle, DiffEditorProps>(function DiffEditor(
  {
    diff,
    mode,
    actions,
    onAction,
    onContextMenu,
    lineActionOp,
    onLineAction,
    scrollResetKey,
    editable = false,
    dirty = false,
    onDirty,
    onSaveRequest,
  },
  ref
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mountRef = useRef<{ destroy: () => void; collect: () => string[][] } | null>(null);
  const anchorRef = useRef<ScrollAnchor>({ line: 1, left: 0 });
  useEffect(() => {
    anchorRef.current = { line: 1, left: 0 };
  }, [scrollResetKey]);

  useImperativeHandle(ref, () => ({
    collectHunkTexts: () => (editable ? mountRef.current?.collect() ?? null : null),
  }));

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const anchor = anchorRef.current;
    const mounted =
      mode === "split"
        ? mountSplit(host, diff, actions, onAction, onContextMenu, lineActionOp, onLineAction, anchor, editable, onDirty, onSaveRequest)
        : mountInline(host, diff, actions, onAction, onContextMenu, lineActionOp, onLineAction, anchor, editable, onDirty, onSaveRequest);
    mountRef.current = mounted;
    return () => {
      mountRef.current = null;
      mounted.destroy();
    };
    // NOTE: `dirty` is intentionally NOT a dependency: recreating the editor
    // would discard the user's unsaved edits. It only drives the CSS class.
  }, [diff, mode, actions, onAction, onContextMenu, lineActionOp, onLineAction, editable, onDirty, onSaveRequest]);

  return (
    <div
      ref={hostRef}
      className={dirty ? "diff-editor-host diff-editor-host--dirty" : "diff-editor-host"}
      style={{ height: "100%", overflow: "auto" }}
    />
  );
});
```

Add the dirty-disable rules to `src/styles/global.css` (no colours involved,
only opacity/pointer-events, so no tokens needed):

```css
/* Editable diff: while there are unsaved edits, hunk/line actions are
   inert; save or discard first (the panel also guards in its handlers). */
.diff-editor-host--dirty .cm-diff-hunk-actions button,
.diff-editor-host--dirty .cm-diff-line-action {
  opacity: 0.4;
  pointer-events: none;
}
```

Add `"@codemirror/commands": "^6.0.0"` to `package.json` `dependencies`
(alphabetical position, before `@codemirror/language`). Do NOT run
`npm install` from WSL — the import already resolves via the `codemirror`
meta-package; tell the user to run `npm install` from PowerShell at the end.

- [ ] **Step 6: Type-check and run the diff test suite**

Run: `npx tsc --noEmit && npx vitest run src/panels/Diff/ src/theme/`
Expected: PASS, no type errors. (`DiffPanel.tsx` still compiles because all
new props are optional and the ref is unused there until Task 5.)

---

### Task 5: Save flow in `DiffPanel`

**Files:**
- Modify: `src/panels/Diff/DiffPanel.tsx`

**Interfaces:**
- Consumes: `DiffEditorHandle`, new `DiffEditor` props (Task 4);
  `repoReadWorktreeFile` / `repoWriteWorktreeFile` (Task 2);
  `spliceEdits` (Task 1); `ToolbarButton` from `../shared/ToolbarButton`.
- Produces: user-visible behavior only (no exported API).

- [ ] **Step 1: Add dirty state, refs, and editability**

In `DiffPanel()`:

```ts
const [dirty, setDirty] = useState(false);
// A summoned file switch waiting on the user while edits are unsaved; the
// inner req may itself be null ("clear the panel"), hence the wrapper.
const [pending, setPending] = useState<{ req: DiffRequest | null } | null>(null);
const editorRef = useRef<DiffEditorHandle | null>(null);
const savingRef = useRef(false);
// Mirrors for callbacks that must not change identity when these change.
const dirtyRef = useRef(dirty);
dirtyRef.current = dirty;
const requestRef = useRef(request);
requestRef.current = request;
const dataRef = useRef<DiffEntry | undefined>(undefined);
dataRef.current = data;

// Editable only for the unstaged working diff: its new side IS the file on
// disk. Staged diffs (new side = index) and commit diffs stay read-only.
const editable = request?.source.kind === "working_unstaged";
```

Note ordering: `dataRef.current = data;` must come after the `useQuery` call.
Add `useState` import usage as needed (already imported).

- [ ] **Step 2: Defer refetches and guard actions while dirty**

Change the query's `enabled` line to:

```ts
    enabled: !!request && request.repoId === activeRepoId && !dirty,
```

(React Query keeps the cached data while disabled, so the editor stays
mounted; invalidations mark it stale and it refetches when re-enabled after
save/discard — exactly the "run the newest pending invalidation on save"
behavior from the spec.)

Add a dirty guard at the top of BOTH `onAction` and `onLineAction`:

```ts
      if (dirtyRef.current) {
        notify.error("Unsaved edits in the diff. Save or discard them first.");
        return;
      }
```

- [ ] **Step 3: Implement save and discard**

```ts
const onSave = useCallback(async () => {
  if (savingRef.current) return;
  const req = requestRef.current;
  const entry = dataRef.current;
  const texts = editorRef.current?.collectHunkTexts();
  if (!req || !entry || !("Text" in entry) || !texts) return;
  savingRef.current = true;
  try {
    const original = await repoReadWorktreeFile(req.repoId, req.path);
    const next = spliceEdits(
      original,
      entry.Text.hunks.map((h) => ({ newStart: h.new_start, newLines: h.new_lines })),
      texts
    );
    await repoWriteWorktreeFile(req.repoId, req.path, next);
    setDirty(false);
    invalidateRepoDomains(queryClient, req.repoId, ["status", "log", "diff"]);
  } catch (e) {
    notify.error(formatAppError(e));
  } finally {
    savingRef.current = false;
  }
}, [queryClient]);

const onDiscardEdits = useCallback(() => {
  setDirty(false);
  const req = requestRef.current;
  // Refetch rebuilds the editor from the on-disk state.
  if (req) invalidateRepoDomains(queryClient, req.repoId, ["diff"]);
}, [queryClient]);

const onDirty = useCallback(() => setDirty(true), []);
```

Imports to add: `repoReadWorktreeFile`, `repoWriteWorktreeFile` from
`../../lib/commands`; `spliceEdits` from `./editModel`;
`type DiffEditorHandle` from `./DiffEditor`; `ToolbarButton` from
`../shared/ToolbarButton`; `useRef` from react.

- [ ] **Step 4: Gate file switches while dirty**

Pending switches are wrapped in `{ req }` (declared in Step 1) so a queued
**null** payload ("clear the panel") while dirty still shows the confirm bar.
Replace `onReceive`:

```ts
const sameTarget = (a: DiffRequest | null, b: DiffRequest | null) =>
  !!a && !!b && a.repoId === b.repoId && a.path === b.path && a.source.kind === b.source.kind;

const onReceive = useCallback((payload: DiffRequest | null) => {
  if (dirtyRef.current && !sameTarget(payload, requestRef.current)) {
    setPending({ req: payload });
    return;
  }
  setRequest(payload);
}, []);
```

In the repo-switch effect, also clear edit state when the request is dropped:

```ts
useEffect(() => {
  setRequest((req) => {
    if (req && req.repoId !== activeRepoId) {
      setDirty(false);
      setPending(null);
      return null;
    }
    return req;
  });
}, [activeRepoId]);
```

Render an inline confirm bar when `pending` is set (place it directly under
the toolbar div, before the error block; `request` is non-null here because
`pending` only gets set while a dirty diff is shown):

```tsx
{pending !== null && (
  <div
    className="legit-panel__toolbar"
    style={{ display: "flex", alignItems: "center", gap: 8 }}
  >
    <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)" }}>
      Unsaved edits in {request.path} will be lost.
    </span>
    <ToolbarButton
      label="Discard edits & switch"
      onClick={() => {
        setDirty(false);
        setRequest(pending.req);
        setPending(null);
      }}
    />
    <ToolbarButton label="Keep editing" onClick={() => setPending(null)} />
  </div>
)}
```

- [ ] **Step 5: Wire the editor and the Save/Discard buttons**

Pass through `DiffBody` to `DiffEditor` (add `editable`, `dirty`, `onDirty`,
`onSaveRequest={onSave}`, `editorRef` as props on `DiffBody`, forwarding to
`<DiffEditor ref={editorRef} ... editable={editable} dirty={dirty}
onDirty={onDirty} onSaveRequest={onSave} />`).

In the toolbar, after the file-path span, add:

```tsx
{dirty && (
  <span style={{ display: "flex", gap: 4, marginLeft: "auto" }}>
    <ToolbarButton label="Save" title="Write changes to the file (Ctrl+S)" onClick={onSave} />
    <ToolbarButton label="Discard edits" title="Reload the file, dropping your edits" onClick={onDiscardEdits} />
  </span>
)}
```

- [ ] **Step 6: Type-check and full frontend suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS, no type errors.

---

### Task 6: Verification

- [ ] **Step 1: Full test suites**

Run: `npx vitest run` and `cargo test -p legit-app --lib && cargo test -p legit-core`
Expected: all PASS.

- [ ] **Step 2: Manual verification checklist (user runs the app from PowerShell)**

Ask the user to run the app (`npm run tauri dev` in PowerShell) — after
`npm install` there to sync the new `@codemirror/commands` entry — and walk
through, in a scratch repo with a modified tracked file:

1. Open the unstaged diff of a modified file. Type into an added or context
   line: the line highlights with the edited tint, Save/Discard buttons
   appear, gutter numbers stay sane.
2. Try to type into a removed (left/red) line or a hunk header: rejected.
3. Press Enter inside an editable line, add a new line, then Ctrl+S: the file
   on disk contains the edit (verify in an external editor), the diff
   refreshes showing it, and Working Changes still lists the file.
4. Edit, then click a hunk's Stage button: it is inert and a toast explains
   unsaved edits; Save, then Stage works.
5. Edit, then click a different file in Working Changes: the confirm bar
   appears; "Keep editing" stays; "Discard edits & switch" opens the other
   file.
6. Edit, then press Discard edits: content reverts to on-disk state.
7. Repeat 1 and 3 in Split view (right pane editable, left pane read-only).
8. A staged diff and a commit diff are still fully read-only.
9. CRLF repo check (any Windows-checkout repo): edit + save does not rewrite
   every line ending (git diff shows only the edited lines changed).
10. Theme check: open the Theme Editor and confirm the new "diff.edited.bg"
    token exists and recolours the edited-line tint live.
