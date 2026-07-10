# Conflict-resolution safety: guard, reopen, marker warning

**Date:** 2026-07-10
**Status:** approved

## Problem

During a merge, "Mark resolved" in the Merge panel writes and stages the file
even when conflict markers remain (the tooltip warns, nothing stops it), the
whole-file Take buttons stage immediately with no guard, and once a file is
staged there is no way back into the merge view for it. An accidentally
staged half-resolution is invisible in Working Changes and irreversible in
the UI.

## Design (three complementary parts)

### A. Mark-resolved guard (Merge panel)

When "Mark resolved" is clicked and the *current editor text* still parses
to one or more conflict blocks (`parseConflicts`), swap in an inline confirm
row ("N conflicts still unresolved - stage anyway? [Stage anyway] [Cancel]",
same pattern as the panel's pending-switch row). Hardcoded, not gated by the
destructive-confirmation setting: a correctness guard, not a destruction
guard (precedent: amend-pushed confirm). Gate on re-parsed text, never on
the selection counter - resolving a block by deleting both sides is valid
but counts as "unaddressed" there. Take buttons stay unguarded (whole-file
resolutions cannot leave markers).

### B. Reopen conflict

Verified against real git: the index's resolve-undo (REUC) record persists
until the merge commit, so a staged resolution can be reopened natively:

    git update-index --unresolve -- <path>   # restores stages 1/2/3
    git checkout -m -- <path>                # regenerates markers in worktree

- Backend: `conflict_reopen(path)` runs the two commands in sequence. If
  checkout -m fails after a successful unresolve, the partial state (stages
  restored, worktree still holds the old resolution) is reported via
  `append_error_note`, never silently.
- Eligibility: `resolve_undo_paths()` parses `git ls-files --resolve-undo`
  (`<mode> <sha> <stage>\t<path>` lines; unique paths).
- UI: "Reopen conflict…" in the staged-row context menu (single selection),
  only while an op is in progress and the path has a resolve-undo record.
  Destructive (discards the staged resolution): `useMenuConfirm`, gated by
  `useConfirmDestructive`. On success: invalidate `OP_DOMAINS`, summon the
  Merge panel for the path.

### C. Staged-marker warning (Working Changes)

- Backend: `staged_marker_paths()` runs `git diff --cached --check`; exit
  code 2 means findings (data, not an error). A pure parser keeps only
  `<path>:<line>: leftover conflict marker` lines (`--check` also reports
  whitespace errors) and returns unique paths.
- Frontend: queried under the status domain (watcher-fresh), enabled only
  while an op is in progress (decided: the merge-session window is where
  markers are accidents; zero cost / zero false positives otherwise).
  Flagged staged rows show a persistent `WarningIcon` badge (new optional
  `renderBadge` prop on `FileTree`, always visible, tooltip "contains
  leftover conflict markers", colour `status.conflicted` token) and their
  context menu offers "Reopen conflict…" from B.

Extension (same day): the warning and "Reopen conflict…" follow the file to
the UNSTAGED side (a staged resolution that was unstaged again). Verified
against real git: the resolve-undo record survives `restore --staged`
(LeGit's unstage), and `git diff --check` (worktree side) flags the markers
with the same output shape - `unstaged_marker_paths()` mirrors the staged
variant. Unstaged rows already showing as Conflicted are skipped (the
conflict state itself is the signal there). The warning renders as the
conflict triangle REPLACING the leading status icon (decided over a separate
trailing badge): same position and colour as a conflicted file, which is the
message - "this file effectively still is conflicted".

The eligibility signals stay distinct: B keys off git's resolve-undo record,
C keys off marker content; a file can be either, both, or neither.

Extension 2 (same day) - unified take-side flow: the Merge panel's toolbar
"Take current/incoming" buttons (fire-and-stage) are replaced by tri-state
checkboxes in the Current/Incoming pane headers that select/clear that whole
side across all conflict blocks as a normal *selection* - previewable in the
Result pane, refinable per block/line, staged through the single Mark
resolved path (guard included). The header checkboxes are aligned over the
pane's checkbox-gutter column (measured at build). Whole-file take remains
in exactly two places: the Merge panel's binary/unreadable branch (only
possible resolution) and the Working Changes conflict-row menu (delete-aware
quick shortcuts). Because a resolution identical to HEAD produces NO status
entry (verified against real git: take-current + stage -> empty status),
every resolution path now posts an explanatory toast when the file vanishes
(`notifyResolutionInvisible`), and the Merge panel's post-stage guidance says
"Resolved and staged" instead of suggesting Mark resolved again. Visible
"resolved - no changes" rows were considered and dropped (2026-07-10): the
toast covers the moment of surprise, and the op-state strip covers the
ongoing state.

## Vertical slice

`GitBackend` methods -> `cli_impl` (+ parsers with format constants
alongside) -> Tauri commands (`lib.rs` registration) -> `commands.ts` +
`types.ts` wrappers -> UI.

## Testing

- Parser unit tests (`--check` output filtering incl. whitespace-error
  lines and paths containing `:`; resolve-undo line format).
- `flow_tests.rs`: reopen = exact sequence unresolve then checkout -m;
  `--check` exit-2 classification.
- `tests/git_flows.rs` (real git): stage a resolved conflict -> resolve-undo
  lists it -> reopen restores UU + markers; `diff --cached --check` exits 2
  with the expected line shape (encodes the exit-code assumption).
- Existing vitest suites from PowerShell; UI verified manually against the
  LeGit-Test merge state.

## Out of scope

Marker checking outside an in-progress operation (decided against);
unstaged-file marker checks (unstaged conflicted files already show as
Conflicted).
