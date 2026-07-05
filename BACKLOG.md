# LeGit Backlog

Deferred features and extension ideas — things intentionally postponed, not
forgotten. When a feature is put off ("let it be for now", "later", "future"),
add it here with: what it is, why it's deferred, and a rough approach so it can
be picked up cleanly. Completed items are removed (git history keeps the
record); an item that is partially done keeps only its open remainder.

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

## Review findings deferred (2026-07-05 full-codebase review)

The review's directly fixable findings were applied the same day (lossy
non-UTF-8 stdout, CRLF hunk-patch corruption, Compare/Search repo-switch
reset, global git-path hot-swap to open sessions, restore merge race +
stale active pointer, cold-cache repo-settings wipe, credential-broker
poison-proofing + shim timeouts, type-drift arms, binary-file View guard,
Branches delayed-busy pattern). Still open:

- **Runner: duplicate `OperationId` kills the earlier invocation.** A second
  invocation under the same op id evicts the first's kill channel, whose
  dropped sender fires the cancel arm and kills the first child. Latent (the
  frontend mints UUIDs), but the runner should guard: reject a colliding id
  or key the running map by (id, generation).
- **Runner: non-UTF-8 paths cannot be represented.** The whole `&[&str]` arg
  surface (and `<rev>:<path>` interpolation via `to_string_lossy`) assumes
  UTF-8 paths. Rarely bites (paths originate from git's own output); a real
  fix means an `OsStr`/bytes-capable runner arg path. Large.
- **Editable diff: CRLF files saved from the inline editor lose their `\r`.**
  The display model strips `\r` (`parse_file_diff` uses `lines()`), so the
  editable-diff save path writes LF-only content back. Sibling of the fixed
  patch-builder bug; needs an end-of-line-aware edit model or save-time
  re-instatement.
- **Worktree read/write symlink escape (defense-in-depth).**
  `resolve_repo_relative` rejects `..` but follows in-repo symlinks, so a
  tracked `link -> /outside` lets `repo_write_worktree_file` write outside
  the repo. Canonicalize-and-verify after join (mind Windows `\\?\` paths).
- **Credential broker trust note.** Any same-user process that reads
  `LEGIT_CRED_TOKEN` from a git child's environment can request credentials
  (and trigger a genuine-looking prompt). Same-user is the existing trust
  boundary (same as git's own helper model); document it, and consider
  showing which operation/remote triggered the prompt for user verification.
- **File View: report binary content properly.** The menu entry is disabled
  for binary files; nicer would be the backend classifying content (NUL
  sniff) so the panel can say "binary file, N bytes" for any rev.

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
  injection), and a warning when the plan rewrites pushed commits.
  (Reword beyond HEAD as a standalone feature was dropped 2026-07-05 by
  decision - not planned.)
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

Audited 2026-06-19; done items pruned since (large sweep 2026-07-04: per-remote
branch view, in-app credential prompt, inspection polish, clone/init options,
tag remote choice + annotated-from-graph, file restore/view at revision).
Each item follows the same vertical slice: add a `GitBackend` method →
implement in `cli_impl` via `GitRunner` (+ a parser if it returns data) →
Tauri command (registered in `lib.rs`) → wrapper in `lib/commands.ts` + type
in `lib/types.ts` → UI.

### Credential prompt follow-ups
The in-app credential prompt ships (2026-07-04): the app binary doubles as a
`git credential` helper (`--credential-helper` shim mode), injected via
`GIT_CONFIG_*` env config so it lands at the END of the helper list (GCM /
profile helpers keep winning where configured); a localhost token-guarded
broker answers from a session cache, the OS keychain (`keyring` crate,
written only after git confirms via `store`), or a UI prompt. Deferred:
- **SSH passphrase prompting** (`SSH_ASKPASS` shim mode): the helper covers
  HTTP(S) only; encrypted SSH keys without an agent still fail
  non-interactively.
- **Keychain management UI**: list/forget credentials LeGit remembered
  (today: delete the "LeGit Git Credentials" entries in the OS keychain).

### Inspection polish
- Search: virtualized results for huge repos (results are capped at 100
  today, so this only matters if the cap is raised).
- Rev pickers use a native `<input list>` datalist (Compare); a richer
  dropdown (grouped, fuzzy) could replace it if the native UX is not enough.
- Blame: the panel accepts a `{ path, rev }` summon payload and offers
  per-hunk "blame parent" time travel, but has no rev input of its own.

### Clone / init
- `--shallow-submodules` pairing when depth + submodules are both set
  (skipped: fails on servers without reachable-sha1 fetch support).

### Advanced
- **Submodules** (the `GitBackend::submodules()` method is a `NotYet` stub) —
  list/update/sync.
- **Worktrees** (add/list/remove), **bisect**.
