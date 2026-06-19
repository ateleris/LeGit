# LeGit Backlog

Deferred features and extension ideas — things intentionally postponed, not
forgotten. When a feature is put off ("let it be for now", "later", "future"),
add it here with: what it is, why it's deferred, and a rough approach so it can
be picked up cleanly.

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
- Still TODO: manage **remotes** (add / remove / rename / set-url) + a
  remote-settings UI; a **pull-strategy picker** in the UI (rebase / merge /
  ff-only — the `PullStrategy` enum exists but the UI always uses `Default`);
  **streaming progress** (currently busy-state + Cancel, no progress bar);
  storing HTTPS tokens in LeGit (kept out by design — rely on the credential
  helper).

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
- **clone** (with progress/auth), **init** a new repo.

### 6. Conflict resolution
- Detect conflicted state; per-file resolve UI (ours / theirs / manual via the
  diff editor), mark resolved, continue/abort merge/rebase/cherry-pick.

### 7. Inspection
- **Diff between arbitrary commits/branches** (the `GitBackend::diff(from, to)`
  method is currently a `NotYet` stub) — compare view.
- **Blame / annotate** a file.
- **Search**: commits (message/author), file paths, and content (`git log -S`/`-G`).

### 8. Tags
- create (lightweight + annotated), delete, push tags.

### 9. File-level
- Restore/checkout a file to a specific revision; open a file at a revision.

### 10. Advanced
- **Submodules** (the `GitBackend::submodules()` method is a `NotYet` stub) —
  list/update/sync.
- **Worktrees** (add/list/remove), **bisect**.

