# Interactive rebase polish: reorder, reword, pushed-commits warning

Date: 2026-08-18
Status: approved (design), pending implementation
Related: release blocker #2 in BACKLOG.md. Builds on the 2026-08-18 review
fixes (plan-coverage verification, merge refusal, `RebaseStep {action, sha}`
shape) in `cli_impl/mod.rs` / `InteractiveRebasePanel.tsx`.

## Scope (decided)

Three additions to the existing Interactive Rebase panel and its backend:

1. **Newest-first row order** matching the commit graph (todo order stays
   internal; flipped at the submit boundary).
2. **Drag-to-reorder** plan rows - live pointer-based reorder like the
   repo tab bar (the grabbed row follows the pointer and the order updates
   live, so it visibly lands where dragged; decided over HTML5 DnD with an
   indicator line 2026-08-18). The existing arrow buttons stay. A
   non-interactive "base" anchor row below the plan shows what the commits
   are applied onto (and thereby the newest-first direction).
3. **Reword as a plan step**: inline multiline textarea under the row,
   prefilled with the full original message.
4. **Pushed-commits warning**: per-row "pushed" chips plus a central
   confirm dialog on Start when the range contains commits reachable from
   the upstream. NOT gated by the destructive-confirmation setting
   (history-warning house rule, same as amend-pushed).
5. **Transplant notice**: when the chosen base is NOT an ancestor of HEAD
   (a commit on a parallel branch), `git rebase -i <base>` does not just
   edit history - it RELOCATES the plan's commits onto that base. An info
   line in the panel says so ("Replays these commits onto <short-sha>:
   they move onto that commit's history"), so the plan listing's implicit
   relocation becomes an informed choice. Informational only - no
   confirm, no blocking.

Out of scope: editing squash result messages (the concatenated default is
accepted unchanged, as today); a standalone reword-outside-rebase action
(dropped by decision 2026-07-05); `--force-with-lease` changes (the push
flow already offers it).

## Reword mechanism (decided): carrier commits + `fixup -C`

The injected todo is deliberately hex-only (single-quoted `printf`
interpolation; anything else is an injection surface), so message text must
never ride the todo. Alternatives rejected: a GIT_EDITOR queue script
(shell portability, and git invokes the same editor for squash messages -
a mixed squash+reword plan desynchronizes the queue) and `exec git commit
--amend -m` (arbitrary text through the shell-interpreted todo).

Chosen: per reword step, create an unreferenced **carrier commit** holding
the new message, and emit `pick <orig>` + `fixup -C <carrier>`. `fixup -C`
takes the message AND author from the carrier without opening an editor -
this is git's own blessed non-interactive reword lane (it is what
`git commit --fixup=reword:` + `--autosquash` compile down to, git 2.32).

Carrier construction (no shell, byte-safe):

```
git log -1 --format=%an%x00%ae%x00%aD <orig>      # author to preserve
git commit-tree <orig>^{tree} -p <orig> -m <msg>  # message as plain argv
```

with `GIT_AUTHOR_NAME/EMAIL/DATE` env overrides (`run_with_env`; the
runner spawns without a shell, so `-m <msg>` needs no quoting and may be
multi-line). The carrier's tree equals the original's and its parent IS
the original, so its diff is empty and the fixup applies cleanly anywhere
in a reordered plan. Carriers are unreferenced after the rebase and are
garbage-collected.

Git floor: `fixup -C` needs git >= 2.32 (2021). Older git refuses the
injected todo at parse time and aborts cleanly; the surfaced error gets an
appended note naming the requirement (only for plans containing rewords -
reword-free plans keep working on older git).

## Backend

Types (`types.rs`, TS mirror in `src/lib/types.ts`):

- `RebaseAction` gains `Reword` (keyword irrelevant - reword steps expand
  to pick + fixup -C, never a `reword` todo line).
- `RebaseStep` gains `message: Option<String>` (`#[serde(default)]`);
  required (non-empty after trim) exactly when `action == Reword`,
  refused otherwise at plan validation.

`rebase_interactive(base, plan)` order of operations (nothing mutates
before every check passes):

1. Plan validation (extended): hex shas; first KEPT step must be `pick`
   **or `reword`**; not all dropped; reword steps must carry a
   non-blank message.
2. `rev-list --parents base..HEAD` coverage + merge refusal, unchanged
   (a reword covers its sha like a pick; carriers do not exist yet).
3. Carrier creation per reword step (author read + `commit-tree` as
   above). Any failure aborts with `CommandFailed` - the rebase has not
   started, nothing to clean up.
4. `build_rebase_todo(plan, carriers)`: reword emits
   `pick <orig>\nfixup -C <carrier>\n`; carrier shas hex-validated like
   all others.
5. Run `rebase -i --autostash <base>` with the printf sequence editor,
   unchanged.

New method + command **`repo_rebase_range_info(repo_id, base) ->
RebaseRangeInfo`**, one probe backing both the pushed chips and the
transplant notice:

```rust
pub struct RebaseRangeInfo {
    /// Range commits NOT reachable from @{upstream}; None = no upstream
    /// (no pushed-warning possible).
    pub unpushed: Option<Vec<String>>,
    /// True when `base` is NOT an ancestor of HEAD - the rebase replays
    /// the range ONTO the base (relocation, not just a history edit).
    pub transplant: bool,
}
```

- unpushed: `git rev-list <base>..HEAD --not @{upstream}` in one call.
  A failed `@{upstream}` resolution (exit 128) = `None`, not an error.
  The frontend derives `pushed = plan shas - unpushed`.
- transplant: `git merge-base --is-ancestor <base> HEAD` (exit 0 =
  ancestor = false, exit 1 = true; other exits are errors).

## Frontend (InteractiveRebasePanel)

- **Order**: `rows` state holds DISPLAY order (newest first, matching the
  graph). The submit path reverses into todo order; `planError` keeps
  operating on todo order (callers pass the reversed array) and its
  message reads for display order: squash/fixup meld into the commit
  BELOW. Arrow button labels flip to match.
- **Drag-to-reorder**: pointer-based live reorder (RepoTabBar pattern):
  pointerdown on a row (excluding select/textarea/button children) +
  4px threshold starts the drag; the row follows the pointer via
  translateY while the row order re-sorts live by comparing the dragged
  centre against sibling centres (offsetTop in the scroll container's
  content space; a useLayoutEffect recomputes the follow offset after
  each reorder to avoid a one-frame jump). Nothing commits on release -
  rows are local state. Disabled while `busy`, like the arrows.
- **Base anchor row**: `log <base> -1` fetches the base commit; a dashed,
  subtle, non-draggable row below the plan shows "base <shortSha>
  <subject> - commits above are applied onto this".
- **Reword UX**: the row `<select>` gains `reword` (pick, reword, squash,
  fixup, drop). Selecting it expands a multiline textarea under the row,
  prefilled with the FULL original message (`commit.message`, subject +
  body; the log format captures both). Row state gains `message: string`;
  switching the action away discards the edit. A reword whose text equals
  the original counts as unchanged for the Start gate; an empty/blank
  reword blocks Start with a footer error.
- **Pushed warning + transplant notice**: one query
  `[repoId, "log", "rebase-range-info", base]` ->
  `repoRebaseRangeInfo(repoId, base)`. `transplant: true` renders the
  info line above the plan (subtle-fg, no new tokens). Rows NOT in the
  unpushed set render
  a subtle "pushed" chip (subtle-fg; no new tokens). Start with >= 1
  pushed commit in range: central `confirmDialog` first - "Rewrite pushed
  commits?", body names the count and that the branch will need a
  force-push afterwards. Not gated by `useConfirmDestructive`. Query
  failure / no upstream degrades to no chips + no dialog + no notice
  (passive query, never blocks).
- Wrappers: `repoRebaseRangeInfo` in commands.ts (+ `RebaseRangeInfo`
  mirror); `RebaseStep` mirror gains `message?: string | null`.

## Edge cases (pinned by design)

- Reword + reorder: carrier diff is empty, applies anywhere.
- Reword as the first kept step: valid (its own pick precedes the fixup).
- Squash/fixup onto a reworded commit: melds into the pick + fixup -C
  result; the fixup -C line stays immediately after its pick.
- Coverage verification counts a reword's sha exactly once.

## Testing

- **Rust unit**: `build_rebase_todo` with rewords (two-line emission,
  carrier hex validation, reword-first-kept allowed, blank message
  refused); the `%an%x00%ae%x00%aD` author parse.
- **flow_tests.rs**: exact command sequence for a reworded plan (author
  read, `commit-tree` with env overrides + `-m` argv, final todo); a plan
  failing coverage verification runs NO `commit-tree`.
- **git_flows.rs** (real git): mid-history reword end-to-end - message
  replaced verbatim incl. multi-line body, author name/email/date
  preserved, trees unchanged; reword combined with reorder; the
  `rev-list <base>..HEAD --not @{upstream}` unpushed contract against a
  local bare remote + the no-upstream error path; the
  `merge-base --is-ancestor` exit-code contract (0 ancestor / 1 not).
- **Vitest**: `planError` under the new rules; the display<->todo
  reversal helper; pushed-set derivation.
- Full suites (cargo, tsc, vitest via PowerShell) + a manual
  rebase-playground re-run including a reword and a drag (the BACKLOG
  blocker #3 note already asks for this re-run).
