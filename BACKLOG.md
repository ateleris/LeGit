# LeGit Backlog

Deferred features and extension ideas — things intentionally postponed, not
forgotten. When a feature is put off ("let it be for now", "later", "future"),
add it here with: what it is, why it's deferred, and a rough approach so it can
be picked up cleanly. Completed items are removed (git history keeps the
record); an item that is partially done keeps only its open remainder.

---

## Review findings deferred (2026-07-05 full-codebase review)

All findings from the review are now closed (second sweep 2026-07-05:
duplicate-OperationId guard in the runner, 3-way resolve CRLF preservation,
canonicalize-and-verify in `resolve_repo_relative`, credential-broker trust
docs + prompt attribution, File View binary classification) except one,
re-deferred with justification:

- **Runner: non-UTF-8 paths cannot be represented.** The whole `&[&str]` arg
  surface (and `<rev>:<path>` interpolation via `to_string_lossy`) assumes
  UTF-8 paths. Re-deferred after scoping: every path crossing IPC is JSON
  (UTF-8 by construction), so the frontend cannot even express a non-UTF-8
  path - a real fix means bytes end-to-end (runner + executor trait + every
  backend signature + an IPC encoding + frontend types), a cross-cutting
  rewrite. Today a repo with non-UTF-8 filenames fails cleanly (git reports
  "pathspec did not match" on the lossy-decoded name); nothing corrupts.
  Revisit only if such repos become a real support case.

---

## Other deferred ideas

- **Live-refresh the diff on external git changes.** The filesystem watcher's
  emitted domains (backend) don't include `diff`, so an external `git`
  stage/unstage while the app is open doesn't refresh an open diff (in-app
  actions do). Add `diff` to the watcher's domains in the Rust side.
- **Diff viewer: cross-hunk syntax highlighting.** Shipped 2026-07-05 (Lezer
  via `@codemirror/language-data`, opt-in global setting): each hunk's old/new
  side is reconstructed from the rows and parsed independently
  (`syntaxModel.ts`), so multi-line constructs highlight correctly *within* a
  hunk. Constructs opened before the hunk's context window still mis-parse;
  full fidelity would mean fetching both full blobs, parsing each once, and
  mapping by line number. Only worth it if the per-hunk approximation proves
  insufficient in practice.
- **Syntax highlighting elsewhere.** File View shows whole real files, so it
  could attach the language extension directly (no reconstruction needed); the
  3-way resolve view could reuse `applySyntaxHighlights`. The `syntax.*` theme
  tokens and `syntaxLanguages.ts` loader are shared infrastructure. Also: the
  highlight-vs-`diff.added.fg`/`diff.removed.fg` interaction means themes that
  tint changed-line text heavily may want their Syntax palette checked for
  contrast against the line tints.
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
