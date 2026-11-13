# Work Log window - design

## Intent

Simon reports project hours, often days late, and reconstructs what he worked
on by opening each repo and scanning its log for a given day. The Work Log
window answers "what did I do on day X, in which repos" in one place: per-day
commits across all open repos, with timestamps, subjects, changed files, and
read-only diffs, plus a best-effort view of uncommitted work.

It is a pure reporting surface. Reading it is the whole job; the hours are
typed into the reporting tool by hand.

## Goals

- One window that shows, per calendar day, every commit the user authored
  across all open repos, on any local branch (unmerged feature-branch work
  counts).
- Per commit: author time, subject, branch, expandable changed-file list,
  and a click-through read-only diff.
- Stashes shown the same way on the day they were created, marked as
  stashes.
- Uncommitted working-tree changes shown as a clearly marked block, each
  file with status and last-modified time, bucketed by that mtime's day,
  with a read-only working-tree diff on click.
- Works identically for local and WSL repos.

## Non-goals

- No export, no copy-as-text button, no clipboard integration (explicitly
  declined - Simon writes the report himself).
- No hour estimation, no time-tracking math beyond showing first/last commit
  times per repo per day.
- No staging, unstaging, discarding, or any mutation from this window - the
  diff pane is read-only even for working changes.
- No sweep of repos LeGit knows but does not have open.
- No in-layout (docked) mode and no setting to choose one: this is always a
  separate OS window (unlike File History, which has the global toggle).

## Anti-goals

- A reconstructed "edit history" of uncommitted work. Git has none; the
  filesystem mtime is the last touch only and can lie (formatter, checkout).
  The UI must never present uncommitted entries as authoritative work
  evidence - they are marked visually and labeled as uncommitted.
- Slowing the main window down. The sweep runs in the Work Log window's own
  queries; opening it must not block or churn the main window.

## Decided design

### Data semantics

- **Which commits are "mine":** author email matches, case-insensitively,
  any email in the union of: all configured git profiles' emails, plus each
  repo's effective `user.email`. Filtering happens in code (pure function,
  unit-tested), not via `git log --author` regexes.
- **Which refs:** all local branches (`--branches`) plus `HEAD` (covers
  detached HEAD work). Remote-tracking refs and tags are excluded. Branch
  attribution uses `git log --source`, accepting its approximation (a
  commit reachable from several branches reports the one git walked first).
- **Stashes:** swept separately via the existing stash-list path and shown
  as marked rows (distinct from both commits and the uncommitted block),
  interleaved chronologically inside the repo block on the day the stash
  was created - committer date, the same convention `inject_stashes` uses
  in the log. Each row shows time, the stash message, and the branch it was
  made on; file list and read-only diff reuse the existing stash
  show/diff paths. No identity filtering: stashes are local by nature, so
  every stash in an open repo is the user's work. Honest limitation,
  stated here on purpose: a stash that was popped or dropped since no
  longer exists, so its creation day loses that entry - the window reports
  surviving stashes only, no reflog archaeology.
- **Which date:** author date, bucketed into calendar days using the
  recorded author timezone offset. Author date survives rebases, so work
  books to the day it was done, not the day it was replayed.
- **Signature rule (hard):** the log format must not contain `%G?`
  (CLAUDE.md rule - it forces per-commit signature verification).
- **Worktree tabs (builder's-check call):** open tabs of the same
  repository (linked worktrees share all local branches) are deduplicated
  by git common dir - one merged repo block per repository, so a commit
  never counts twice in the day list or the day detail. Uncommitted blocks
  stay per worktree (each has its own working tree), labeled with the
  worktree's tab name when a repository has several open.
- **Uncommitted changes:** from status, each changed file stat'ed through
  the host fs for its mtime; files are bucketed under their mtime's day and
  the block is labeled "Uncommitted" with a distinct visual marker.
  Files last touched before the selected range (and deleted files, which
  cannot be stat'ed) go to a dimmed "Older" row at the bottom of the day
  list - never silently dropped, never clamped into a wrong day; each row
  there shows its real mtime date (deleted files show "deleted" instead).
  This is my call from the builder's check. This
  requires extending `FsStat` with an optional mtime (epoch seconds);
  `#[serde(default)]` on the wire keeps old agents parsing (an agent that
  does not send it yields files bucketed under "today" - acceptable, and the
  deployed agent is updated in lockstep anyway). Note the specta rule:
  `FsStat` crosses the agent protocol, not the IPC boundary, so the
  output-only `serde(default)` prohibition does not bite; verify before
  reusing the type in a command payload.

### Backend

- One new `GitBackend` method (domain file `cli_impl/worklog.rs` or folded
  into `history.rs` - builder's choice) returning, per repo, the commits
  since a cutoff: id, author time (+offset), author email, subject, source
  ref. One `git log --branches HEAD --source --since=<cutoff>` per repo.
  Format constant lives next to its pure parser in `cli_impl/parsers/`.
- Changed-file lists are lazy: loaded per commit on expand, reusing the
  existing commit-files path. Diffs reuse the existing commit-diff and
  working-diff commands, read-only on the frontend.
- The sweep command takes a repo id and runs through that repo's session
  (host seam), so WSL repos work unchanged. The frontend fans out one query
  per open repo and merges; a repo whose sweep fails shows an inline error
  row for that repo, never poisons the other repos' data.
- Tests, per project convention: parser unit tests; a `flow_tests/` case
  asserting the exact git invocation (incl. the absence of `%G?`); a
  `tests/git_flows.rs` real-git case validating the `--source` /
  `--branches` / `--since` assumptions (e.g. an unmerged branch's commit
  appears; a rebased commit keeps its author day).

### Window and UI

- A new always-popout window reusing the File History window seams: label
  `wl-<something stable>` via `commands/panel_window.rs`, the `src/windows/`
  shell (uiPrefs boot/refresh, theme reload), main-close cascade, and its
  own persisted window size (command-owned setting, like
  `file_history_window_size`). Single instance: opening it again focuses it.
- Opened from the View menu ("Work Log"); also registered on the Mac native
  menu where the View menu lives there.
- **Three panes, left to right:**
  1. **Day list:** the last N days, newest first, each row with weekday +
     date and "x commits, y repos" (days with only stashes or only
     uncommitted work count too). Empty
     days stay in the list, dimmed, so the calendar reads continuously.
  2. **Day detail:** the selected day, one block per repo (repos with
     nothing that day are omitted). Repo header: name + commit count +
     first-to-last commit time span. Under it, commit rows newest-first
     (matching the commit graph): author time, branch, subject, expandable
     changed-file list. The uncommitted block sits above the commits
     (it is newer), expanded to one row per file: status letter, path,
     mtime, newest first.
  3. **Diff pane:** the selected file's diff, read-only, reusing the shared
     File History diff body. For a commit file: that commit's change to the
     file. For an uncommitted file: HEAD vs working tree, so staged +
     unstaged in one view. No such `DiffSource` exists yet (only
     unstaged/staged/commit variants do), so this is a new variant plus
     backend path with both test gates, including untracked-file handling
     (mirror the `--no-index` fallback the unstaged path uses) - "reuse"
     applies to the viewer, not the diff source.
- **Toolbar:** range selector ("Last 7 / 14 / 30 days", persisted) and an
  identity filter (default "All identities"). My call from the builder's
  check: the dropdown lists the distinct author emails actually matched in
  the current sweep (profile emails and repo-effective `user.email`s
  alike), so a filter can never silently hide work under an email the
  dropdown does not show; the uncommitted blocks have no author and stay
  visible regardless of the identity filter.
- Data loads on window open; a manual refresh control re-sweeps. No watcher
  wiring in v1 (the window is a point-in-time report; builder may note
  watcher invalidation as a follow-up, not build it).
- All colours via theme tokens (the uncommitted marker likely reuses an
  existing warning/attention token; if a new token is needed it goes in the
  4 places and gets a `CONTRAST_PAIRS` entry if it carries text). All
  dimensions scale from `--ui-font-size`. Loading feedback follows the
  150ms-delay rule.
- CHANGELOG.md gets an `Added` bullet.

## Constraints

- Follow every architecture rule in CLAUDE.md: commands never compose git
  flows; parsers pure with format constants adjacent; both test gates for
  any new composed flow; no literal colours; no fixed-px chrome.
- Do not commit; leave the work for Simon's review.

## Left to the builder

- Exact names (command, backend method, query keys - follow the
  `[repoId, domain, ...]` pattern; the day-bucketing lives in a pure,
  unit-tested frontend or backend function, builder's choice of side).
- Whether the per-repo sweep returns raw commits for frontend bucketing or
  pre-bucketed days (lean: raw commits, bucket in a pure TS function with
  unit tests, since day boundaries are a display concern).
- Window sizing defaults, pane proportions, and splitter behavior
  (SplitviewReact like File History).
- How "last N days" interacts with the --since cutoff (cutoff = start of
  the oldest requested day in local time, generous by one day to survive
  timezone skew, then bucket precisely in code).
- The empty states: no open repos, a day with nothing, sweep still running.
