# LeGit Backlog

Deferred features and extension ideas — things intentionally postponed, not
forgotten. When a feature is put off ("let it be for now", "later", "future"),
add it here with: what it is, why it's deferred, and a rough approach so it can
be picked up cleanly. Completed items are removed (git history keeps the
record); an item that is partially done keeps only its open remainder.

---

## Reword commit: extend beyond HEAD

**What:** Reword (rename) the message of any **local** commit, not just HEAD.

**Status:** Deferred 2026-06-21. v1 ships HEAD-only reword (`GitBackend::reword_commit`
via `git commit --amend --only`, with a hard block on pushed commits and an inline
editor in the Commits panel). Older commits need history replay.

**Approach (plumbing, fully non-interactive — fits the CLI/no-temp-script model):**
- Forge a reworded commit object preserving the tree and parents:
  `git commit-tree <C>^{tree} -p <parent…> -m <msg>`. `commit-tree` has no
  `--author` flag, so preserve the original author via `GIT_AUTHOR_NAME/EMAIL/DATE`
  env — **`GitRunner::run_with_env` now exists** (added 2026-07-04 by the
  backend-review pass, exactly this shape: caller env applied *after* the
  base env/GIT_* scrub so overrides win; see [[project-runner-env-inherit]]).
- Replay descendants onto the new commit: `git rebase --onto <new> <C> <branch>`.
  Because the reworded commit keeps an **identical tree**, the replay is
  conflict-free. Use `--rebase-merges` when merges sit in the `<C>..<branch>`
  range (chosen behavior) so topology survives.
- Preconditions: refuse unless `git merge-base --is-ancestor <C> HEAD` (v1 rewrites
  only the current branch); reuse the existing pushed check
  (`git rev-list -n 1 <C> --not --remotes`).
- Dirty tree: auto-stash (reuse `run_with_auto_stash`); on failure
  `git rebase --abort` + `git stash pop`. Add a `RewordOutcome`
  (`Clean` / `StashPopFailed`) mirroring `SwitchOutcome`.
- Signing: route through `SignMode` (`-S` / `--no-gpg-sign`); old signatures are
  necessarily discarded and re-signed — see [[project-commit-log-no-sig-verify]].

**Also deferred:**
- Rewording a **pushed** commit behind an explicit force-push confirmation
  (currently hard-blocked).
- Reword editor affordances: a modal/full editor option and signing-key selection.

---

## Diff viewer: syntax highlighting

**What:** Syntax-highlight the code shown in the diff panel (inline + split).

**Status:** Deferred 2026-06-19. The diff viewer (Phase A hunk-level + Phase B
line-level) is complete without it.

**Approach (recommended — per-line, decoration-based):**
- The CodeMirror document is *not* real source (inline interleaves old/new/
  context lines), so CodeMirror's native Lezer language highlighting would
  mis-parse it. Instead, tokenize each diff line independently and emit
  `Decoration.mark`s — the same mechanism `DiffEditor.tsx` already uses for
  word-level highlighting.
- Use a lightweight tokenizer (e.g. Prism's `tokenize`, which returns a token
  tree that maps cleanly to ranges); pick the grammar from the file extension
  (`request.path`). Consider lazy-loading grammars to keep the bundle small.
- Layer syntax marks under the existing added/removed-word marks in
  `decorationField` (mind `Decoration.set` ordering).
- Add syntax colour **theme tokens** (keyword/string/number/comment/function/
  type/operator/punctuation/…) in all 4 token places (see
  [[feedback-theme-tokens]] convention: `tokens.ts`, `defaults.ts`,
  `theme.css`, both theme JSONs).

**Caveat:** per-line tokenization can't see across lines, so multi-line
constructs (block comments, multi-line/template strings) highlight imperfectly.
Full fidelity would require highlighting the whole file on each side and mapping
colours onto diff lines by line number (fetch full blobs + a mapping layer) —
significantly more work; most diff viewers accept the per-line approximation.

**Rough effort:** ~1 day; most of it the tokenizer integration and the syntax
theme-token set.

---

## Startup: parallelize repo-session restore

**What:** `restore_open_repos` (commands/repo.rs) restores persisted repos
strictly sequentially: per repo a `git rev-parse` probe, then `open_session`
(more git spawns + watcher setup). With many repos on Windows (slow process
spawn) this is the dominant startup cost.

**Status:** Deferred 2026-07-03. The frontend now holds the splash until
restore completes (App.tsx boot gate), so the cost is visible as splash time
rather than an empty repo list - making restore faster is the follow-up.

**Rough approach:** probe + open the sessions concurrently
(`futures::future::join_all` or a small `JoinSet`), then reassemble
`summaries` in the persisted order (order must stay user-controlled -
see the tab-ordering convention). Watch out: `open_session` takes
`&AppState` writes; make sure concurrent session insertion into the
`repos` map is race-free (it's behind an RwLock already).

---

## Other deferred ideas

- **Live-refresh the diff on external git changes.** The filesystem watcher's
  emitted domains (backend) don't include `diff`, so an external `git`
  stage/unstage while the app is open doesn't refresh an open diff (in-app
  actions do). Add `diff` to the watcher's domains in the Rust side.
- **Diff viewer: full-fidelity (multi-line) syntax highlighting.** See the
  caveat in the syntax-highlighting item — only if the per-line approximation
  proves insufficient.
- **Diff viewer: inline editing of staged diffs.** Unstaged working-tree
  diffs are editable (2026-07-03); staged diffs (new side = index) remain
  read-only — extend if wanted.
- **Git Log panel follow-ups.** Filter/search the log, copy a command, jump
  a toast to its specific log entry (currently it just opens the panel).
- **Interactive rebase polish.** The panel ships (reorder via up/down,
  pick/squash/fixup/drop, plan injected via the `printf`-redirect
  `GIT_SEQUENCE_EDITOR`, conflicts through the normal banner). Deferred:
  drag-to-reorder rows, reword as a plan step (needs per-commit message
  injection — see the reword-beyond-HEAD item), and a warning when the plan
  rewrites pushed commits.
- **3-way view polish.** Ships as a Diff-panel toggle on conflicted files
  (ours | editable result | theirs from the real index stages, proportional
  scroll sync). Deferred: showing the base stage (already fetched), and
  conflict-aligned scroll sync instead of proportional.
- **Button set: sweep the class call sites.** The shared set ships
  (`panels/shared/buttons.tsx`: `Button` default/primary/danger/ghost +
  `IconButton`; `ToolbarButton` is the labeled ghost preset; menu entries
  unified on the `primitives.tsx` `MenuItem`, now a real button). The ~36
  `className="primary"/"danger"` call sites still use the classes directly —
  they ARE the token-backed system underneath `Button`, so migrating them to
  `<Button variant>` is optional, purely mechanical churn. New code should
  use the shared components. A "link" variant was skipped (no call sites).

---

## Git functionality — missing vs a normal client

Audited 2026-06-19; done items pruned since. Each item follows the same
vertical slice: add a `GitBackend` method → implement in `cli_impl` via
`GitRunner` (+ a parser if it returns data) → Tauri command (registered in
`lib.rs`) → wrapper in `lib/commands.ts` + type in `lib/types.ts` → UI.
Roughly priority-ordered.

### 1. Remotes & sync leftovers
Fetch/pull/push (cancellable, profile-driven auth, classified failures,
streaming transfer progress), the Remotes panel, ahead/behind, set/clear
upstream, and the pull-strategy / push-remote pickers all ship. Still open:
- **Per-remote tracked-branch view** (Branches panel groups remote branches
  flat; a per-remote grouping with tracking info would go there).
- (Kept out by design: storing HTTPS tokens in LeGit — rely on the credential
  helper; see the item below.)

#### In-app credential prompt (`GIT_ASKPASS` / custom helper)

**What:** Let LeGit itself prompt for credentials and feed them to git, instead
of depending on a system credential helper being installed and correctly
configured. This is the CLI-client equivalent of how GitKraken (own engine) and
Gitnuro (JGit `CredentialsProvider`) do auth — they prompt in-app and inject
credentials, never relying on the git CLI's `sh -c` helper invocation.

**Why deferred / why it matters:** the profile's `credential.helper` works, but
it depends on the user having a working helper (e.g. Git Credential Manager) and
referencing it correctly — notably **a short name like `manager`, NOT a full
path with spaces**, because the git CLI runs helpers via `sh -c` (a full path
word-splits → `C:/Program: No such file or directory`). LeGit now writes the
helper as a reset-then-set so the profile is authoritative, but the dependency
on an external helper remains.

**Rough approach:** ship a tiny askpass shim (or a `git credential` helper) that
LeGit points git at via `GIT_ASKPASS`/`SSH_ASKPASS`/`core.askPass` (or
`-c credential.helper=…`), opening a prompt in the LeGit UI and returning the
entered secret to git over a local IPC channel. Decide secret handling (prefer
the OS keychain via the `keyring` crate; never plaintext in settings).
Cross-platform care: the shim must be invocable by Git for Windows' shell.

### 2. Inspection polish
Compare (two-rev snapshot diff with file list → read-only range diffs via
`DiffSource::CommitRange`), Search (message/author regex, content pickaxe,
path substring), and Blame (porcelain-parsed hunks, contents included) all
ship (2026-07-04). Deferred polish:
- Compare: a merge-base (three-dot) mode for "what would this branch merge";
  rev pickers instead of free-text inputs.
- Blame: blame at a specific revision (currently working-tree only);
  re-blame from a hunk's parent ("time-travel" blame).
- Search: `-G` regex content mode; virtualized results for huge repos.

### 3. Clone / init leftovers
Clone / init ship (cancellable, profile-aware, streaming progress). Still open:
- Clone options: `--depth`, `--branch`, submodules.
- `git init --bare` / initial-branch name.

### 4. Tags leftovers
Create/delete/push (incl. remote-side delete) ship. Still open:
- Choosing a **remote other than origin/first** for tag push/delete.
- Creating **annotated** tags from the graph context menu (currently
  lightweight only there).

### 5. File-level
- Restore/checkout a file to a specific revision; open a file at a revision.

### 6. Advanced
- **Submodules** (the `GitBackend::submodules()` method is a `NotYet` stub) —
  list/update/sync.
- **Worktrees** (add/list/remove), **bisect**.
