# Competitive feature review - LeGit vs the git GUI field (2026-08-20)

Compared against SourceTree, GitKraken, Fork, Git Extensions, Sublime Merge,
and Tower. LeGit's side is grounded in a full sweep of the actual surface
(GitBackend trait, registered IPC commands, panel registry, UI wiring);
competitor facts are from knowledge current to early 2026 and may drift by a
minor version.

## Verdict

LeGit is at or above parity with the commercial mid-field in the core
daily-driver areas (staging, graph, branching, integrating, sync), clearly
ahead of the whole field in five areas (submodules, stash, conflict tooling,
line endings, config/profiles/credentials), and behind in exactly the areas
the backlog tracks (worktrees, bisect, keyboard/palette, provider
integration) plus a handful of smaller gaps added to the backlog from this
review (patches, multi-commit selection, whitespace toggle, --no-verify,
branch filter, merge-commit cherry-pick/revert, undo-last-commit).

## Matrix (major areas)

Legend: Y = solid, p = partial/basic, - = absent

| Area                      | LeGit | SrcTree | Kraken | Fork | GitExt | SublMerge | Tower |
|---------------------------|-------|---------|--------|------|--------|-----------|-------|
| File/hunk/line staging    | Y     | Y       | p      | Y    | Y      | Y         | Y     |
| Commit graph              | Y     | Y       | Y      | Y    | Y      | p         | Y     |
| Log search/filter         | p     | p       | Y      | Y    | Y      | Y         | Y     |
| Interactive rebase        | Y     | p       | Y      | Y    | Y      | p         | Y     |
| Built-in conflict editor  | Y     | -       | Y      | Y    | p      | Y         | p     |
| Stash depth               | Y     | p       | p      | p    | p      | p         | p     |
| Submodules                | Y     | p       | p      | p    | p      | p         | p     |
| Blame + file history      | Y     | Y       | Y      | Y    | Y      | Y         | Y     |
| LFS                       | Y     | Y       | Y      | p    | p      | -         | Y     |
| Patches (format/apply)    | -     | Y       | -      | Y    | Y      | p         | p     |
| Worktrees                 | -     | -       | Y      | -    | Y      | -         | -     |
| Bisect                    | -     | -       | -      | -    | Y      | -         | -     |
| git-flow helpers          | -     | Y       | Y      | Y    | p      | -         | Y     |
| Provider PRs/repo listing | -     | Y       | Y      | p    | -      | -         | Y     |
| Keyboard/command palette  | -     | p       | Y      | Y    | Y      | Y         | Y     |
| Undo convenience          | p     | -       | Y      | p    | p      | p         | Y     |

## Where LeGit is genuinely ahead (differentiators)

- **Submodules** - full lifecycle: add/move/remove with magit semantics,
  retained-gitdir inspection with unpushed-commit detection, auto-update
  after switch/pull with rollback guarantees, "Branch here" for detached
  submodule HEADs, open-as-tab / jump-to-superproject. No competitor is
  close; every one treats submodules as an afterthought.
- **Stash** - SHA-addressed actions immune to stash@{N} reordering (even
  from outside the app), stashes as graph nodes, rename, apply a single
  file out of a stash, pathspec stash. The field has push/pop/drop.
- **Conflict tooling** - editable result pane, whole-file takes,
  leftover-marker detection in staged AND unstaged content, and
  reopen-a-resolved-conflict (`update-index --unresolve`) - the last seen
  in no GUI at all.
- **Config / identity profiles / credentials** - per-scope resolved-value
  display with sources; profiles with detection, apply-preview, and
  clone-time application; LeGit acting as git's credential helper so HTTPS
  prompts appear in-app (broker socket + OS keychain).
- **Line-ending tooling** - attention-only chips, one-click EOL-only
  revert, commit warning, renormalize with a true dry-run preview
  (throwaway GIT_INDEX_FILE). Unique in the field.
- **Transparency** - pager-backpressured git Console with `| grep`;
  command log interleaved with watcher invalidation batches (what ran, and
  why the UI refreshed).
- Smaller uniques: lane locks, blame time-travel (re-blame at parent),
  on-demand signature verification + zero-cost Signed column, three-way
  dirty-switch policy, fast-forward-on-remote-checkout, auto-push of tags
  that just became public, editable unstaged diff.

## Gaps and their disposition

- Already backlogged before this review: worktrees (Kraken/GitExt have
  them), bisect (GitExt only), keyboard shortcuts / command palette (the
  biggest UX-parity gap; everyone but SourceTree is strong), provider repo
  listing + PRs (explicit product decision), touched-path log filter.
- Added to the backlog by this review: patches (create/apply),
  multi-commit selection (unlocks cherry-pick/revert sets, compare-by-
  selection, patch-from-range), diff ignore-whitespace toggle, commit
  `--no-verify`, branch-list filter box, merge-commit cherry-pick/revert
  (`-m` mainline picker) + `-x`, "Undo last commit" convenience.
- Decided against (recorded in BACKLOG "Decided and recorded"): git-flow
  helpers, archive export, git notes, sparse checkout.
- Backend-only seams relevant to the gaps: pickaxe `-S`/`-G` search kinds,
  `search_paths`, `LogOptions.paths`, `CommitOptions.sign`
  (None/WithKey) + `allow_empty` - all kept and tested, unwired.
