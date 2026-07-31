# Release Notes panel

**Date:** 2026-07-31
**Status:** Approved
**Backlog item:** "Release notes generator (idea, unscoped)" - evaluated Git
Extensions' plugin as the reference: a dialog with from/to rev expressions
running `git log from..to` into a copyable summary. LeGit v1 matches that
scope with better range pickers.

## Design (user decisions: plain text only, no grouping, merges included)

1. **Panel.** New repo-scoped `release-notes` panel (registry descriptor +
   component map; ViewMenu lists it automatically). Default placement: right
   of the Commits panel.
2. **Range row.** Plain From / To text inputs accepting any rev expression
   (tag, branch, SHA, `HEAD~5`). A `<datalist>` combo was tried and dropped
   2026-07-31 - the native dropdown felt off (user feedback). Defaults on
   open: From = most recent tag by `created_at`, To = `HEAD`. (Most recent
   BY DATE is not always `git describe`'s nearest-reachable tag; revisit
   only if it hurts.)
3. **Data.** No backend changes: `repoLog(repoId, 10_000, 0, "from..to")`
   (explicit high cap instead of the 500 default); existing tags/branches
   queries. Query key under the `log` domain so the watcher refreshes it.
   Hitting the 10k cap shows a "list truncated" notice - never silent.
4. **Formatting.** Pure `formatReleaseNotes(commits): string` in
   `src/panels/ReleaseNotes/releaseNotes.ts`: one BARE subject line per
   commit, newest first (git's order) - no bullets, no SHAs (user decision
   2026-07-31; the first cut used `- <subject> (<sha8>)`). Subject = first
   line of the message, defensively. Also pure
   `latestTagName(tags): string | null` (max `created_at`). Both
   unit-tested.
5. **Preview + copy.** Read-only monospace textarea (selectable), commit
   count line, Copy button via the existing `copyText` helper + success
   toast. Invalid rev: git's error via `formatAppError` (PanelError).
   Valid-but-empty range: "No commits in this range."

## Out of scope (possible follow-ups)

Markdown/HTML output, conventional-commit grouping, merge filtering,
templates, `git describe`-based default tag.

## Testing

`releaseNotes.test.ts`: line shape, newest-first passthrough, multiline
message uses first line, empty list -> empty string, `latestTagName` picks
max `created_at` / null on empty. Panel wiring is thin JSX over existing
queries.
