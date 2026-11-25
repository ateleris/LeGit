# Performance and memory guardrails

Status: plan; Phase 0 partly measured, feedback-contract pieces shipped. Trigger: a large merge made LeGit exhaust a
Windows machine's memory (2026-11-24; the line-ending scan buffered every
changed blob and re-ran on every watcher batch). That instance is fixed. This
note is about making the whole class impossible, and about making LeGit
measurably fast.

## Goal

Three promises, each checkable:

1. **A git call through LeGit costs about what it costs in a console.**
   Measured as wrapper overhead (spawn, env, pipes, logging, IPC) per
   invocation against the same command run bare, back to back on the same
   machine. Target, set from the Phase 0 numbers below: overhead no more
   than the larger of 5 ms and 20 percent of the bare time. Met since the
   shared console (measured +0.1 to +2.8 ms; before it +16 to +24 ms), see
   "Phase 0 results".
2. **Everything that is LeGit's own behaviour stays bounded and responsive.**
   - No UI-thread task over 50 ms; input feedback within 100 ms.
   - A user action never queues behind a background refresh.
   - Memory: the app process stays under a fixed budget (proposed 1 GB
     resident, excluding the webview's baseline) on every stress fixture.
   - Nothing LeGit starts on its own (watcher, focus, timers) may cost time
     or memory proportional to repo size or change-set size without a cap,
     a cancel path and a degraded mode.

3. **The UI always tells the truth about what LeGit is doing.** Added
   2026-11-25 after the manual pass on the large-merge fixture: memory was
   fine, but the merge ran 1.5 s with nothing on screen, and the
   "uncommitted changes" row took 3+ s more because it waited for line
   counts it does not need.
   - Every operation shows activity from the moment it starts until it
     ends: no stretch where LeGit works and the screen is still. (Fast
     operations stay flicker-free through the existing 150 ms delay.)
   - Anything that can be slow runs in the background and never holds back
     faster information: show what is known now, fill in the rest when it
     arrives.
   - Anything that runs long can be stopped by the user.

**Budgets are test targets, never runtime tripwires.** The numbers above are
asserted by the local perf run on the reference machine, as ratios against
a bare baseline wherever possible so a slower computer scales both sides.
At runtime LeGit never stops something because it is slow: a slow machine
or a slow disk gets a slower LeGit, not a broken one. Runtime limits exist
only for resource exhaustion (memory, buffered output), and even those ask
before stopping anything the user started (see the watchdog).

What promise 1 does NOT cover, on purpose: LeGit runs more git commands than
a console user types (status plus counts plus markers per refresh), and some
git commands are slow by nature on big inputs (`diff --numstat` over a
multi-GB change set). Those are promise 2 problems: LeGit decides whether and
when to run them. The rule that follows: **user-requested git work may take
as long as git takes; LeGit-initiated git work must be bounded.**

## Known starting points

Facts from the 2026-11-24 investigation, to be confirmed or extended by the
audit:

- `GitRunner` buffers stdout without limit; caps are applied after reading
  (`blob_bytes`, `file_at_revision`, `file_diff`).
- No limit on concurrent git processes; a superseded query's backend
  command keeps running (react-query drops the result, nothing cancels the
  process). Five status-domain scans are gated since today; the rest are not.
- Status runs two `diff --numstat -M` over the whole change set on every
  refresh; the marker checks run `diff --check` the same way.
- The default Windows git path is `...\Git\cmd\git.exe`, a shim that spawns
  the real binary: one extra process per call (measured, see "Phase 0
  results").
- 267 commands, about 138 query sites; only the Commits panel and the shared
  file tree virtualize their lists.

## Phase 0: measure first (no fixes)

Nothing below is trusted until it has a number.

- **Stress fixtures**, scripted and disposable (the `LeGit-MemTest` script
  is the first): large conflicted merge; 100k-commit history; 10k refs and
  tags; 50k untracked files; one 500 MB text file and one 2 GB binary;
  500 stashes; 200 submodules; a repo on WSL.
- **Wrapper-overhead benchmark**: the same commands (`status`, `rev-parse`,
  `log -1`) run bare and through `GitRunner`, local and WSL, cold and warm.
  Reports the per-call delta and isolates the `cmd\git.exe` shim.
- **Per-action cost report** from the existing invocation log: for each user
  action and each automatic trigger, which git commands ran, how long, how
  many bytes of output. The Git Command Log already has the data; this adds
  an export and a summary.
- **Frontend probes** (dev builds only): long-task observer, IPC payload
  size per command, render counts for the big lists.
- **Memory sampling**: app RSS and child git RSS during each fixture run.

Deliverable: a baseline table (action or trigger, wall time, git time,
overhead, output bytes, peak memory) per fixture.

### Phase 0 results (2026-11-25, partial)

Reference machine: i7-12700H, 32 GB, Windows, git 2.52. Measured with
`scripts\perf.ps1` against `LeGit-MemTest` (clean tree), medians of 40
interleaved rounds; reports are kept in `..\LeGit-Perf`. Run-to-run noise
is around 5 ms, so only the large differences below are conclusions.

| `git rev-parse HEAD` | median |
|---|---|
| real binary (`mingw64\bin\git.exe`), console inherited | 18 to 30 ms |
| shim (`cmd\git.exe`, what a console user runs), console inherited | 44 to 46 ms |
| real binary with `CREATE_NO_WINDOW` | 57 ms |
| shim with `CREATE_NO_WINDOW` | 65 ms |
| real binary with `DETACHED_PROCESS` | 30 ms |
| shim with `DETACHED_PROCESS` | 65 ms |
| through `GitRunner`, shim (today's default) | 63 to 88 ms |
| through `GitRunner`, real binary | 34 to 62 ms |

What this says:

- **`CREATE_NO_WINDOW` costs 20 to 27 ms per call.** Windows starts a
  console host for every child that has no console to inherit. This is the
  bulk of the wrapper overhead and applies to every git call LeGit makes.
- **The shim costs 10 to 17 ms per call**, but a console user pays it too
  (`git` on PATH is the shim), so it is not wrapper overhead: bypassing it
  would make LeGit faster than the console.
- **The runner's own code (env, pipes, tokio, logging) is within noise.**
- A refresh that runs five git commands therefore pays 100+ ms for console
  hosts alone.

Shipped 2026-11-25: **one shared hidden console**
(`runner/shared_console.rs`, set up at app startup). Measured from a
windowed process (`examples/console_probe.rs`): 88 to 44 ms per call with
the shim, 38 to 20 ms with the real binary, no visible window, about 35 ms
once at startup. Runner overhead with it: +0.1 to +2.8 ms, inside the
promise 1 target. The console is created through a short-lived
`CREATE_NO_WINDOW` child and `AttachConsole`, because `AllocConsole` shows
its window first. Children were attached to a hidden console before too, so
prompts and helpers behave as before; cancel goes through the Job Object,
never console events. Still to confirm in the installed app: hooks, ssh,
credential helpers, no flash at startup.

Decided against: calling the real binary directly (LeGit would have to
supply what the shim sets up: PATH entries for `sh`, ssh, credential
helpers, git-lfs). `DETACHED_PROCESS` is not an option with the shim
either: its child allocates its own console.

Memory, first idle sample of a dev build with two repos open
(`scripts\perf-mem.ps1`): app process about 90 MB, webview processes about
1.1 GB in total (one renderer alone at 1 GB; dev build with HMR and
devtools, a release build has not been sampled). The proposed "1 GB" budget
cannot be judged before the fixture runs are sampled, and it has to be
stated per group (app process, git children, webview) because the webview
alone already exceeds it in a dev build.

Not measured yet: the other stress fixtures, the per-action cost report,
IPC payload sizes, render counts, WSL, peak memory during the fixture
merge on the current build.

## Phase 1: exhaustive audit

Every item gets a row in one findings table: location, what it scales with,
worst case on the fixtures, trigger (user or automatic), severity.

1. **Backend commands (all 267).** For each: what does its cost scale with
   (repo size, history length, change-set size, single-file size)? Is its
   output bounded before it is read? Is it cancellable? Does it hold
   anything in memory beyond its result?
2. **Query sites (all ~138).** For each: which domain, how often it
   refetches (watcher, focus, timer, action), payload size, whether it is
   enabled when its panel is not visible, whether a refetch storm is
   possible.
3. **Watcher and invalidation.** Event volume under each fixture, what one
   batch fans out to, behaviour while unfocused, repos in background tabs.
4. **Rendering.** Every list and tree: virtualized or bounded? Every
   per-row hook or query. Diff and file viewers on huge inputs.
5. **IPC.** Payloads over 1 MB, base64 blobs, anything serialized twice.
6. **Startup and repo open.** Time to first paint, time to usable, what
   runs before the user can act.
7. **Remote (WSL) path.** Agent round trips per action, base64 overhead,
   reconnect cost.
8. **Process lifetime.** Leaked children, orphaned pipes, growing maps and
   caches (query cache, logs, fingerprints).
9. **Feedback.** For every user action and every panel: is there a visible
   busy state for the whole wait, does fast information wait on slow
   information, can it be stopped?

Method: the inventory passes are mechanical and parallelize well (one pass
per command file and per panel), followed by a verification pass that
reproduces each high-severity finding on a fixture. Findings that cannot be
reproduced are recorded as unconfirmed, not fixed on suspicion.

## Phase 2: structural guardrails

These remove classes of bug instead of instances, and land before the
individual fixes so the fixes can rely on them.

- **Runner output budget.** Every `GitRequest` carries a byte limit with a
  conservative default; overflow kills the process tree and returns a
  dedicated error. Commands that legitimately need more say so explicitly.
- **Scheduler in front of the runner.** A per-repo limit on concurrent git
  processes with two classes: interactive (user actions, never queued behind
  background work) and background (refreshes; coalesced, cancellable).
- **Cancellation end to end.** A superseded or unmounted query cancels its
  backend command and the git process behind it.
- **Scan gating for every automatic read**, generalizing today's
  `ScanGate`: one in flight per repo and kind.
- **Size before content** as a rule for every blob and diff read.
- **Degrade thresholds** for change-set-proportional work (line counts,
  marker checks, line endings): above a threshold show less. Accepted as a
  principle on one condition: it is communicated well. Every degraded view
  says what is missing and why, in the place where the information would
  have been, and offers to compute it on demand. A silently missing chip or
  count is a bug. (The line-ending cutoff shipped 2026-11-24 does not yet
  meet this: it drops the chips without a notice. First item to fix.)
- **Rendering rule**: any list that can exceed a few hundred rows is
  virtualized; enforced by a test over the panel sources.
- **IPC payload cap** with a typed "too large" outcome.
- **Watchdog that asks instead of killing.** App plus child memory and the
  age of running operations are sampled on a timer. Three behaviours:
  - *Something runs much longer than expected* (relative to that
    operation's own history on this machine, not a fixed number): a
    non-blocking notice, "<operation> is taking longer than expected. Stop
    it?" with Stop and Keep waiting. Asked once per operation; Keep waiting
    silences it for that operation. Nothing is stopped without the answer.
  - *Memory is elevated*: the same kind of notice, naming what is using it.
  - *Memory reaches the hard ceiling and the cause is LeGit's own
    background work*: automatic refreshes are PAUSED (not killed, nothing
    the user started is touched) and a persistent notice says so, with a
    Resume button. This one case acts before asking, because the
    2026-11-24 machine was unusable within seconds: a question nobody can
    click on protects nothing. Pausing is reversible and loses no work.
  On Windows, git children additionally run in a Job Object so a child that
  runs away despite all of the above is ended by the OS instead of taking
  the machine down; LeGit reports it as an error with the cause.

### The feedback contract

The UI-side counterpart of the guardrails above, for promise 3.

- **Progressive data.** A query returns the cheap part first and enriches
  later: status delivers the file list from `git status` alone, line counts
  arrive from a separate query. A consumer that only needs "are there
  changes" (the graph's uncommitted row, the merge banner) must never wait
  for an enrichment. Rule for new queries: one query, one cost class.
- **Every operation has a busy state.** Fetch, pull and push have one;
  merge, rebase, cherry-pick, revert, reset and stash apply/pop do not.
  All of them report through one shared surface, the **activity bar**
  (below the repo tabs, in the operation banner's slot), fed from a
  per-command label map so no call site can forget it. Background reads keep using `PanelLoadingBar`.
- **One write at a time per repository.** While a long-running write
  holds a repository, other writes to it are refused with a message naming
  it and the main write controls go inert; quick writes take turns with
  each other. Reads and other repositories are never held back; the whole
  UI is never blocked. (Shipped 2026-11-25 at the frontend command layer,
  `src/lib/repoWrites.ts`; it does not span windows, a backend-level lock
  would.)
  Context-menu entries that write are marked `<MenuItem writes>` and go
  inert with a tooltip naming the running operation (shipped 2026-11-25).
- **Busy states cover the whole wait**, not only the fetch: a panel whose
  view takes long to build after its data arrives shows busy until it has
  painted.
- **Stopping long work.** Reads are cancelled outright (safe by nature).
  Operations that write the working tree are different: killing git
  mid-checkout can leave a half-written tree and a stale `index.lock`. For
  those, Stop asks first and says what it means, ends git gracefully (the
  runner already sends TERM before any hard kill), then reports the state
  the repo is in and offers the matching recovery (`merge --abort`,
  `rebase --abort`). Stop is never offered where no safe recovery exists.
  Shipped 2026-11-25 for merge, rebase, cherry-pick and revert (start,
  continue, skip): the session's executor wrapper records the op ids of
  running worktree-rewriting invocations, `repo_stop_operation` cancels
  them, removes an `index.lock` the killed process left behind (Windows
  kills outright, git cannot clean up) and returns the resulting op state.
  An operation stopped before git recorded it (early in a merge, or any
  fast-forward) has no Abort and leaves partly rewritten files. Decided:
  the files stay, and a warning toast says the operation was stopped and
  that files it had changed may be left in Working Changes. An offer to
  restore them was built and rejected. Confirmed on Windows 2026-11-25:
  git is killed and the stale `index.lock` is removed.
  Open: (1) reads are not cancellable yet; (2) other lock files (`HEAD.lock`,
  ref locks) are not cleaned up.
- **Enforcement.** A test over the action wrappers asserts that every
  mutating action goes through the activity surface, in the style of the
  existing enforcement tests.

## Phase 3: fix the findings

Ranked by severity times likelihood from the Phase 1 table. Each fix lands
with its regression test, as usual. Expected early candidates: the
`cmd\git.exe` shim if the benchmark confirms it, status line counts on large
change sets, unvirtualized file lists, the remaining read-then-cap paths.

## Phase 4: keep it that way

- **Byte-budget tests** in the real-git suite: fixtures run through an
  executor that counts output bytes and asserts a ceiling per scan.
- **Command-count budgets**: the flow tests already pin command sequences;
  add a per-refresh ceiling so a new automatic command is a visible change.
- **The local stress and perf command** (see "How this is tested"), with
  its report kept per run so wrapper cost and memory cannot creep unnoticed.
- **A release-checklist line** in RELEASING.md: run the perf command, compare
  with the last report.
- **A short rule in CLAUDE.md**: automatic work must be bounded, gated and
  cancellable; user-visible lists are virtualized.

## How this is tested

The principle: a regression must fail a test, never a machine. Every stress
run therefore executes under a hard memory limit set from outside the
process, so going over budget kills the test instead of the host.

All stress and performance runs happen on the developer machine (Windows
with WSL and Docker Desktop), not in GitHub Actions: the fixtures are
multi-GB, hosted runners are too noisy to time anything, and the machine
that matters is a real Windows desktop. GitHub CI keeps running what it
runs today and gains nothing heavy.

### Three tiers

1. **Deterministic budget tests.** They measure causes, not symptoms: bytes
   of git output buffered, number of git processes spawned per refresh, peak
   concurrent processes. Small tempdir fixtures run through a counting
   executor. They are ordinary fast unit tests inside `cargo test`, so they
   also run wherever the normal suite runs; they need no isolation and no
   large data. Most guardrails are pinned here.
2. **Stress suite (local, isolated).** The large fixtures from Phase 0, run
   against the real backend with wall-time, process-count and peak-memory
   assertions. Marked `#[ignore]` so plain `cargo test` skips them.
3. **App-level perf pass (local).** The real app on a large fixture: merge,
   then time-to-idle and peak memory of the app plus its children.

### One local command

A single entry point (`scripts/perf` or an npm script) builds the fixtures
once into a cache directory outside the repo, runs tiers 2 and 3 under
their memory limits, and writes a dated report (action or trigger, wall
time, git time, overhead, output bytes, peak memory) next to the previous
ones, so a run is compared against the last baseline instead of against a
guess. Run before a release and after any change to the runner, the
watcher or a refresh path.

### Isolation: a container for the Linux side, a Job Object for Windows

- **Linux side: a Docker container.**
  `docker run --memory=<budget> --memory-swap=<budget> --pids-limit=<n>`
  gives a kernel-enforced cap: an unbounded read gets the test process
  OOM-killed and the run fails. Fixtures are generated inside the container
  and thrown away with it. This covers `legit-core`, the runner and the
  agent (the code behind WSL repos).
- **Windows side: a Job Object, not a container.** The incident happened on
  Windows, and the Windows-specific parts are exactly what a Linux container
  cannot see: the `cmd\git.exe` shim, NTFS and Defender file costs, the
  ReadDirectoryChangesW watcher, WebView2. Windows containers do not run a
  WebView2 GUI app sensibly. The equivalent isolation is a Job Object with a
  memory limit around the test process tree (a small launcher, the same
  mechanism the Phase 2 watchdog uses for git children).

So the stress suite has one definition and two launchers, both started by
the one local command. The Windows run is the one that matches the reported
incident and is the one that gates a release.

### Timing

Wrapper overhead is always asserted as a ratio: bare and wrapped runs back
to back, so machine speed and background load cancel out. The UI numbers
(50 ms, 100 ms) are absolute and are asserted on the reference machine
only, with the previous report as the reference for drift. A failed budget
fails the perf run; it never changes what the shipped app does.

### What stays manual

Tier 3 starts as a scripted manual pass: open the fixture, follow a
checklist like `LeGit-MemTest/TESTING.md`, read the numbers off the report
and Task Manager. Automating it means driving WebView2 through
`tauri-driver` on Windows (the existing E2E suite drives WebKitGTK on
Linux); worth doing only if the manual pass proves too easy to skip.

## Order and size

Phase 0 and 1 are investigation and produce the baseline and the findings
table: roughly two to three sessions. Phase 2 is the core engineering:
roughly four to six sessions, the scheduler and cancellation being the
largest pieces. Phase 3 depends on the table. Phase 4 is small and lands
alongside each guardrail. The phases can ship incrementally; after Phase 2
the incident class from 2026-11-24 is closed regardless of what Phase 3
finds.

## Decisions

Settled 2026-11-25:

- **Budgets** are targets derived from measurement and checked as ratios in
  the local perf run. Nothing is killed at runtime for being slow; slower
  computers must simply be slower.
- **Degraded modes** are fine as long as they are communicated well (see
  the degrade-thresholds guardrail).
- **Watchdog** warns and asks ("... is taking longer than expected. Stop
  it?") instead of stopping things on its own.

- **Auto-pause exception**: at the hard memory ceiling LeGit pauses its
  own background refreshes without asking first, then says so with a Resume
  button. Nothing the user started is touched, nothing is killed.

Open:

- The app memory budget: stated per group (app process, git children,
  webview). The fixture merge has not been sampled (skipped 2026-11-25);
  `scripts\perf-mem.ps1` does it when a number is needed, at the latest
  before the watchdog's memory ceiling is built.
