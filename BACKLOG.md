# LeGit Backlog

Deferred features and extension ideas — things intentionally postponed, not
forgotten. When a feature is put off ("let it be for now", "later", "future"),
add it here with: what it is, why it's deferred, and a rough approach so it can
be picked up cleanly.

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
  env — this requires a **minimal `GitRunner::run_with_env`** (factor
  `build_command` into `build_command_with_env`, apply caller env *after* the
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

## ~~Theme completeness: retheme dockview + literal-colour audit~~

Done 2026-07-02. The `.dv-dockview` override block in `global.css` (extended
to also match `.dockview-theme-abyss`, covering the Refs paneview) now maps
every visible dockview colour var to LeGit tokens — including sash, scrollbar,
paneview header border, floating shadow, and the drag-over overlay (new tokens
`shadow.color` + `dnd.overlay.bg`). The abyss class remains only as a
structural fallback. All residual literal colours (menu/popover/toast
box-shadows) were tokenized. Enforced by `src/theme/noLiteralColors.test.ts`:
any colour literal outside `theme.css`, `defaults.ts`, the Theme Editor's
colour-data values, or a `var(--token, …)` fallback fails the suite.

---

## Button cleanup: consolidate the ad-hoc button variants

**What:** The app has accumulated too many button styles, each hand-rolled at
its call site. Consolidate them into a small shared set of button components
with consistent sizing (font-relative), theming (tokens), and hover/disabled
behaviour.

**Status:** Deferred 2026-07-02. First step done: the Commits toolbar's
button was extracted to `panels/shared/ToolbarButton.tsx` and now also serves
the Working Changes section actions (Stage/Unstage/Discard all — the
link-style `TextButton` is gone). Remaining inventory:
- Global CSS `button` base + `.primary` / `.danger` classes (global.css) —
  used by ~30 call sites (Branches/Stashes/Remotes rows, Theme Editor, forms).
- `ToolbarButton` + `toolbarBtnStyle` (shared) — could become the "ghost"
  variant of the final set.
- `IconButton` in WorkingChangesPanel.
- One-off inline-styled buttons: the settings link-toggle (Photoshop chain),
  push-menu entry, palette-row delete "×", ViewMenu/RepoOverflowMenu entries,
  Refs paneview header.

**Rough approach:** a `src/components/buttons.tsx` (or `panels/shared/`)
module exporting `Button` (variants: default / primary / danger / ghost /
link / icon; sizes derived from `--ui-font-size`), backed by the existing
button tokens (`button.*`, plus a new `button.link.fg` bound to `accent`).
Migrate call sites incrementally — start with the inline-styled one-offs,
then fold `SyncButton`/`TextButton`/`IconButton` into the shared set. Give
destructive text-buttons the danger colour while at it.

---

## Other deferred ideas

- **Diff viewer: inline editing.** The original reason CodeMirror was chosen —
  let users fix small things directly in the diff pane. Needs an editable
  document model and write-back to the working tree.
- **Live-refresh the diff on external git changes.** The filesystem watcher's
  emitted domains (backend) don't include `diff`, so an external `git`
  stage/unstage while the app is open doesn't refresh an open diff (in-app
  actions do). Add `diff` to the watcher's domains in the Rust side.
- **Diff viewer: full-fidelity (multi-line) syntax highlighting.** See the
  caveat above — only if the per-line approximation proves insufficient.
- ~~**Git command log panel.**~~ Done — `GitRunner` reports every invocation via
  a process-wide observer → `git_invocation` Tauri event → `useGitLogStore` →
  the **Git Log** panel. Central error toasts (`useNotificationsStore` +
  `Toasts`) surface command failures; clicking a toast summons the Git Log.
  Possible follow-ups: filter/search the log, copy a command, jump a toast to
  its specific log entry (currently it just opens the panel).

---

## Git functionality — missing vs a normal client

Audited 2026-06-19. The **review → stage → commit** loop (incl. line-level
staging) and **history viewing** are complete; the items below are standard
git-client features not yet first-class (the interactive Git Console is the only
current way to do them by hand). Each follows the same vertical slice: add a
`GitBackend` method → implement in `cli_impl` via `GitRunner` (+ a parser if it
returns data) → Tauri command (registered in `lib.rs`) → wrapper in
`lib/commands.ts` + type in `lib/types.ts` → UI. Roughly priority-ordered.

### 1. Remotes & sync (biggest gap)
- ~~**fetch / pull / push** (incl. push to set upstream, force-with-lease).~~
  Done — `fetch`/`pull`/`push` backend methods (`run_with_op`, cancellable via
  the existing `console_cancel`), `repo_*` commands, and a sync toolbar in the
  Commits panel (Fetch / Pull / Publish-or-Push + force-with-lease menu, busy +
  Cancel, ahead/behind chip). **Auth is driven by the active git profile**: SSH
  via `core.sshCommand` (existing) + a new `credential.helper` managed key for
  HTTPS (LeGit stores no secrets). Auth/rejection failures are classified
  (`AuthFailed` / `PushRejected`) and surfaced as toasts.
- **Upstream/tracking — show ahead/behind**: done (current branch only, via
  `tracking_status` → `git rev-list --left-right --count`). Still TODO: **set /
  clear upstream** explicitly (beyond push `--set-upstream`).
- ~~Manage **remotes** (add / remove / rename / set-url).~~ Done — a dedicated
  **Remotes panel** (`src/panels/Remotes/`, registry id `remotes`) lists remotes
  with fetch/push URLs and does add / remove / rename / set-url + per-remote
  fetch / prune (`GitBackend::{list_remotes,add_remote,remove_remote,
  rename_remote,set_remote_url,prune_remote}` + `parsers/remotes.rs`). Mutations
  invalidate `remotes/branches/tracking/log` so the sync toolbar stays correct.
- Still TODO: a **pull-strategy picker** in the UI (rebase / merge / ff-only —
  the `PullStrategy` enum exists but the UI always uses `Default`); **streaming
  progress** (currently busy-state + Cancel, no progress bar); storing HTTPS
  tokens in LeGit (kept out by design — rely on the credential helper); a
  push-remote picker in the sync toolbar; per-remote tracked-branch view.

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

### 2. Branch operations (write)
- **Create**, **checkout/switch** (incl. detached, checkout a remote branch),
  **delete** (safe + force), **rename**.
- **Merge** (with conflict handling) and **rebase** (onto / interactive).
- Branch from a commit; set as current. (Branch *listing* already exists.)

### 3. Stash
- save (incl. keep-index / include-untracked), list, show, apply, pop, drop,
  branch-from-stash.

### Commit safety: detached-HEAD warning
- Before committing on a **detached HEAD**, warn the user with a confirmation
  (commit stays possible, but they must confirm — a detached-HEAD commit is
  easily lost). Detect via the current ref (e.g. `git symbolic-ref -q HEAD`
  fails / the status reports no branch); show a confirm in the Working Changes
  commit flow, similar to the existing discard-confirmation.

### 4. Undo & history rewriting
- **reset** (soft / mixed / hard) to a commit.
- **revert** a commit; **cherry-pick** a commit (with conflict handling).
- Interactive rebase / squash / reword; **reflog** view + restore.

### 5. Getting a repo
- ~~**clone** / **init** a new repo.~~ Done — inline Clone / Init forms in the
  Repositories panel (`repo_clone` / `repo_init` / `cancel_clone` in
  `commands/repo.rs`, sharing the extracted `register_open_repo`). Clone is
  cancellable (busy + Cancel via the `AppState.transient_ops` registry). Both
  take an optional **profile** (a "Use global config" sentinel default): the
  profile's auth is injected into the clone via `git -c …` and then applied to
  the new repo (sets `git_profile_id`, so it shows as active in Repo Settings).
  Remaining: streaming clone progress (%), clone options (`--depth`/`--branch`/
  submodules), `git init --bare` / initial-branch name.

### 6. Conflict resolution
- Detect conflicted state; per-file resolve UI (ours / theirs / manual via the
  diff editor), mark resolved, continue/abort merge/rebase/cherry-pick.

### 7. Inspection
- **Diff between arbitrary commits/branches** (the `GitBackend::diff(from, to)`
  method is currently a `NotYet` stub) — compare view.
- **Blame / annotate** a file.
- **Search**: commits (message/author), file paths, and content (`git log -S`/`-G`).

### 8. Tags
- ~~create (lightweight + annotated), delete, push tags.~~ Done — Tags pane in
  the Refs panel (list with pushed indicator, create at HEAD with optional
  annotation message, push, delete), plus commit-row context-menu entries
  ("Create tag here…" with the inline chip-input pattern, per-tag push/delete)
  and a remote indicator on pushed tag chips (`pushedTagNames`: same name AND
  same target on the remote, via a cached `ls-remote --tags`). Remote-side
  deletion is a separate deliberate action (GitKraken-style): "Delete tag
  from <remote>" appears on pushed tags in the menus and the Tags pane.
  Remaining: choosing a remote other than origin/first, and creating
  annotated tags from the graph context menu (currently lightweight only
  there).

### 9. File-level
- Restore/checkout a file to a specific revision; open a file at a revision.

### 10. Advanced
- **Submodules** (the `GitBackend::submodules()` method is a `NotYet` stub) —
  list/update/sync.
- **Worktrees** (add/list/remove), **bisect**.

