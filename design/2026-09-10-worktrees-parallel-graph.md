# Worktrees in one shared commit graph ("parallel mode") - analysis

2026-09-10. Companion to the chat estimate for mode A (each worktree opens
as its own repo tab, plus a Worktrees pane in Refs for the meta calls).
This note analyzes mode B: worktrees displayed in parallel with the main
repo inside the SAME commit graph, in one tab. Status: analysis only, no
decision, nothing implemented.

## 1. What git actually shares between worktrees

The starting point that shapes everything below: linked worktrees share one
repository. Per `git worktree`, the split is:

- **Shared (common git dir):** the object database, all refs
  (`refs/heads/*`, `refs/tags/*`, `refs/remotes/*`), `packed-refs`, config,
  and notably `refs/stash` - the stash list is one list for all worktrees.
- **Per worktree (private gitdir `.git/worktrees/<name>/`):** `HEAD`, the
  index, op state (`MERGE_HEAD`, `rebase-merge/`, ...), `ORIG_HEAD`, and the
  per-worktree ref namespace `worktrees/<name>/*`.

Consequence: the commit graph LeGit draws (log over all refs, branches,
tags) is already identical for every worktree of a repo. "Parallel display"
is therefore NOT a different graph - it is the same graph plus:

1. a HEAD decoration per worktree, and
2. optionally one "uncommitted changes" (workdir) row per worktree, and
3. the ability to act on more than one working tree from one tab.

Items 1-2 are cheap. Item 3 is where the cost lives.

## 2. Can the graph display multiple HEADs?

Yes, with existing machinery:

- **Decorations.** `git worktree list --porcelain` reports every worktree's
  HEAD sha and checked-out branch in one call. Injecting a decoration per
  worktree onto the matching commit rows mirrors how stash nodes are
  injected (`inject_stashes`). `RefDecoration` already has a `headOf`
  variant; a `{ type: "worktreeHead", value: <name> }` sibling (or reuse of
  `headOf`) covers rendering. The lane algorithm is untouched - decorations
  do not participate in lane assignment.
- **Multiple workdir rows.** Today one synthetic "uncommitted changes" row
  is derived from the active repo's status and anchored above HEAD. N rows
  need N status reads, each executed WITH THAT WORKTREE AS CWD, plus a
  worktree label on the row. Anchoring per worktree HEAD reuses the stash
  injection pattern. Moderate work, no algorithmic obstacle.
- **Visuals.** A worktree chip next to the branch chips (new theme tokens,
  the usual 4 places + contrast pair). Row count grows by one per dirty
  worktree; no other graph impact.

So: display is feasible and comparatively cheap. The graph was never the
blocker.

## 3. What full interactivity impacts (the expensive part)

### 3.1 Execution context

Every worktree-scoped git call (status, stage/unstage/discard, commit,
diff, stash push/pop, switch, merge/rebase/cherry-pick/revert + their
continues) must run with cwd = that worktree. Today a `RepoSession` holds
ONE runner bound to one toplevel; every backend method implicitly means
"the session's worktree". Mode B needs either:

- (a) an executor per worktree inside the session
  (`HashMap<WorktreeId, Arc<dyn GitExecutor>>`) - fits the existing
  hot-swap design, and `Host::executor_for(git_path, cwd)` already
  parameterizes cwd, so it works for WSL repos unchanged; or
- (b) `-C <worktree>` injection via a wrapping executor.

Either way, the `GitBackend` surface grows a worktree dimension for the
scoped subset of methods. This is the single largest change: the runner
seam is the one every feature flows through.

### 3.2 Data model / queries

Query keys split into repo-scoped and worktree-scoped:

- stay `[repoId, domain]`: log, branches, tags, remotes, stashes (list).
- become `[repoId, worktreeId, domain]`: status, diff, op_state, marker
  paths, case_drift, line-ending map.

Ripples: `invalidateRepoDomains`, `withDerivedDomains`, the watcher event
payload (must say WHICH worktree changed), `useRepoChangeListener`, and
every panel that touches a worktree-scoped query.

### 3.3 Watchers

One filesystem watcher per checked-out worktree plus one on the common git
dir (refs/objects), with batches tagged by worktree so invalidation stays
scoped. `legit-watch`'s API and `RepoChangedPayload` change shape. (Mode A
has a much smaller cousin of this: a worktree session must additionally
watch the COMMON dir for ref moves - noted in the mode A estimate.)

### 3.4 Panels and op state

Working Changes, the commit composer, Diff (working sources), and the
op-state strip are all per-worktree. Each worktree can be mid-merge or
mid-rebase INDEPENDENTLY, so op-state banners multiply. Two UI shapes:

- **Active-worktree switcher (recommended if mode B is built):** one set of
  panels, scoped to a selected worktree; a dropdown in the Working Changes
  toolbar (and mirrored on the workdir rows: clicking a worktree's row
  activates it). Persisted per repo in `RepoSettings`.
- Parallel panel instances per worktree: dockview supports parameterized
  panels, but layout persistence, summon routing, and the shared diff slot
  all assume one instance per kind. Rejected as v1 of mode B.

## 4. Ambiguous commands with multiple HEADs

Principle: **no command is dispatched ambiguously - every mutating call
carries an explicit worktree context.** The UI supplies it from one of two
sources: the active-worktree selector (composer, Working Changes, op-state
actions) or the clicked row's own context (a workdir row, a worktree HEAD
chip). "HEAD" never appears as a bare argument; it is always "HEAD of
worktree W".

Audit of the graph's command surface:

| Command | Scope | Resolution |
| --- | --- | --- |
| commit / stage / discard / hunk ops | worktree | active worktree only |
| switch / checkout | worktree | active worktree; if the target branch is checked out in ANOTHER worktree git refuses - classify that error and offer "activate that worktree" (or detached checkout via `--ignore-other-worktrees`) |
| merge / rebase / cherry-pick / revert (+continue/abort) | worktree | active worktree; per-worktree op state drives the banner |
| reset (soft/mixed/hard) | worktree | moves the ACTIVE worktree's branch/index/tree |
| stash push | worktree | active worktree (list is shared; entries record their origin only in the message) |
| stash apply/pop | worktree | applies to the active worktree, regardless of where it was created |
| branch create / rename | shared | unambiguous |
| branch delete | shared | git refuses deleting a branch checked out in ANY worktree - classify, name the worktree |
| tag / fetch / push / pull(fetch leg) | shared | unambiguous; pull's merge leg is worktree-scoped (active) |

Detached-HEAD and amend-pushed warnings, `isDetachedHead`, and tracking
(ahead/behind) all become functions of the active worktree's HEAD, not "the
repo's HEAD".

## 5. Cost and risk

- Display only (decorations + read-only dirty badges): ~1 session on top
  of mode A.
- Multiple workdir rows (read-only): ~1 more session (N status reads with
  cwd, row injection, labels).
- Full mode B (per-worktree executors, scoped domains, multi-watcher,
  active-worktree switcher, ambiguity polish, per-worktree op state):
  roughly 6-10 focused sessions, touching the runner seam, the watcher
  crate, the invalidation layer, and four panels. High regression surface;
  the real-git suite and flow tests would need a worktree dimension too.

## 6. Recommended staging

1. **Ship mode A** (worktree = own tab + Worktrees pane in Refs). Covers
   the workflow; everything reuses existing machinery. Note that because
   refs are shared, every worktree tab ALREADY shows the same full graph -
   mode A is closer to mode B than it first appears.
2. **Stage B1, cheap and safe:** in every tab of the repo family, inject
   the OTHER worktrees' HEAD decorations (from `worktree list`), with two
   read-only actions: "open worktree as tab" and "jump to commit". No
   ambiguity exists because nothing mutates through a foreign HEAD.
3. **Stage B2, on demand:** the active-worktree switcher scoping Working
   Changes/composer inside one tab (per-worktree executor for ONE extra
   context at a time).
4. **Stage B3, only with proven demand:** N workdir rows + full parallel
   interactivity per section 3.

The open product question for 2-4: does interacting with several worktrees
from one tab beat Ctrl+Tab between two tabs that already share the same
graph? B1 is worth it regardless; B2/B3 should wait for that answer.
