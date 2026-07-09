# Uniform copy-path actions (2026-07-09)

Every file-listing panel offers the same context-menu pair: **Copy relative
path** (repo-relative, as git reports it) and **Copy absolute path** (repo
root + relative path, OS-native separators). Approved design:

- `src/lib/paths.ts`: pure `toAbsolutePath(repoRoot, relPath)` - joins the
  root (possibly Windows-style `C:\...`) with git's POSIX relative path using
  the root's native separator; unit-tested. `copyText(text)` wraps
  `navigator.clipboard.writeText` with an `execCommand` fallback.
- `src/panels/shared/CopyPathMenuSection.tsx`: StashMenuSection-style
  fragment (SectionLabel + two MenuItems) with props `{ path, onClose }`;
  reads the repo root via `useActiveRepo()` (absolute entry hidden without a
  repo). Single source for wording/behaviour so panels cannot drift.
- Wiring: Files (replaces its single "Copy path" entry; file + folder rows),
  Working Changes (staged + unstaged sections), Changed Files (covers commit
  details), File History. Compare and Search get a `PanelContextMenuProvider`
  for the first time (decision 2026-07-09: full uniformity); Search's
  hardcoded right-click -> file history moves into the menu as an entry.
- Blame is a single-file view (no file list); CommitDetails delegates its
  file list to Changed Files.
