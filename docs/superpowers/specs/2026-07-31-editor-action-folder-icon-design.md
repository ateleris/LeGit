# Editor action: folder icon when no editor is configured

**Date:** 2026-07-31
**Status:** Approved

## Problem

The top-right "open in editor" toolbar button (and its counterpart in the
repo overflow menu) always shows the edit icon (`ExternalEditorIcon`,
SquarePen). When no external editor is configured the action opens the repo
FOLDER instead - the tooltip already says so ("Open folder (no editor
configured)") but the icon still promises an editor.

## Design

1. `src/lib/editorAction.ts` - new pure predicate
   `editorOpensFolder(template): boolean`, true when `templateProgram` is
   empty (the exact rule `editorActionLabel` already applies). Replace
   `useEditorActionLabel(repoId)` with
   `useEditorAction(repoId): { label: string; opensFolder: boolean }`
   (single consumer: RepoTabBar).
2. `src/icons/index.tsx` - add `FolderIcon` (lucide `Folder`, standard
   `withDefaults`).
3. Call sites render `opensFolder ? <FolderIcon /> : <ExternalEditorIcon />`:
   - `RepoTabBar` top-right button (via the hook),
   - `RepoOverflowMenu` per-repo button (computed per row from the same
     `effectiveEditorTemplate` it already uses for the label - icon and
     label can never disagree).
4. Unchanged: the load-lazily fallback (until repo settings load, the global
   template decides) applies to icon and label alike; the backend action
   resolution is untouched.

## Testing

`src/lib/editorAction.test.ts` (new - the module had no tests despite pure
decision logic): `templateProgram` (plain command, quoted path with spaces,
blank/whitespace), `editorActionLabel` (program vs folder fallback),
`editorOpensFolder` (TDD: red first). Icon wiring itself is thin JSX.
