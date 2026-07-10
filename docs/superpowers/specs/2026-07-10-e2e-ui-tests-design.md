# E2E UI smoke tests - design

Date: 2026-07-10
Status: approved

## Goal

Automated UI coverage for LeGit's full stack (React UI -> Tauri IPC -> GitRunner
-> real git -> watcher -> React Query), which today has none. The backend is
already covered by real-git integration tests; this adds a small smoke suite
that drives the built app. Deliberately small: two specs, not a second test
pyramid.

## Decisions

- **Run target: Linux CI only.** One heavier job on ubuntu-latest with
  webkit2gtk-driver + xvfb. No local Windows/WSL runnability; failures are
  debugged via CI artifacts (screenshots, logs).
- **Stack: tauri-driver + WebdriverIO.** Tauri's documented WebDriver setup.
  WebdriverIO (npm) talks to tauri-driver, which launches the built binary
  under WebKitWebDriver.
- **Scope: core smoke + conflict banner.** Stage/commit happy path, plus a
  merge-conflict flow (the most fragile UI area).
- **Binary under test: debug build** (`tauri build --debug --no-bundle`).
  Much faster to compile than release; the debug binary's specta export is
  non-fatal (`let _ = ...`) and the "LeGit DEV" title is cosmetic.
- **CI job is blocking.** A smoke suite that fails should matter; demote to
  non-blocking only if flakiness shows up in practice.

## Architecture

New top-level `e2e/` directory, isolated from the vitest unit tests:

```
e2e/
  wdio.conf.ts          # WebdriverIO config; spawns/kills tauri-driver
  fixtures.ts           # generates fixture git repos + seeds app data dir
  specs/
    smoke.spec.ts       # open -> stage -> commit -> visible in log
    conflict.spec.ts    # merge conflicting branch -> conflict banner
  package.json          # own deps (wdio) so the main package.json stays clean
```

Runtime chain: WebdriverIO -> tauri-driver (port 4444) -> WebKitWebDriver ->
LeGit debug binary under xvfb.

## Hermetic launch + fixture repos (key mechanism)

WebDriver cannot drive native file dialogs. The fixture repo enters via
settings restore: the app reads `currently_open` from
`<app-data>/global-settings.json` at startup (`restore_open_repos`) and opens
those repos automatically.

Per spec file, the harness:

1. Creates a temp dir; points `XDG_DATA_HOME` / `XDG_CONFIG_HOME` / `HOME` at
   it (env passed to tauri-driver -> app), so the app data dir
   (`.../ch.ateleris.legit/`) is fully hermetic - no shared state between
   specs or with the runner's real config.
2. Generates the fixture repo with plain `git` child-process calls (local
   `user.name` / `user.email`, `commit.gpgsign=false`, `core.autocrlf=false` -
   same pinning as the Rust real-git harness in `tests/git_flows.rs`):
   - smoke fixture: 2 commits + one modified tracked file in the worktree
   - conflict fixture: `main` and `feature` editing the same line, checked
     out on `main`
3. Writes `global-settings.json` pre-seeded with
   `currently_open: [<fixture path>]` and `active_open_repo`.

No production code changes are needed for launch - the mechanism exists.

## Selector strategy (only production-code change)

The codebase has zero `data-testid` today. Add them sparingly to elements the
specs touch: working-changes file rows (+ stage/unstage affordance), commit
message input, commit button, commit-log subject cells, branch rows in the
Branches panel, merge menu items, conflict banner. Convention: static
`data-testid` strings (`wc-file-row`, `commit-button`, ...); dynamic values
(file name, branch name) via a companion attribute, e.g.
`[data-testid="wc-file-row"][data-path="notes.txt"]`. Purely additive.

## Specs

**smoke.spec.ts**
1. App window appears; repo tab shows the fixture repo name.
2. Unstaged section lists the modified file -> click stage -> file moves to
   staged.
3. Type a commit message, click commit.
4. Wait until the log shows the new subject at HEAD and working changes are
   empty.

**conflict.spec.ts**
1. App opens on the conflict fixture (on `main`).
2. Right-click `feature` in the Branches panel -> Merge (the
   `BranchMenuSection` path).
3. Assert the conflict banner appears and the conflicted file is listed.
4. No cleanup needed - the fixture temp dir is discarded.

Each spec gets its own app session (fresh launch, fresh fixture).
`maxInstances: 1`, serialized.

## CI job

Third job `e2e-tests` in `ci.yml`, parallel to the existing two:

- ubuntu-latest; apt: existing Tauri deps + `webkit2gtk-driver` + `xvfb`
- `cargo install tauri-driver --locked` (cached), rust-cache, npm ci
- `npm run tauri build -- --debug --no-bundle`
- run wdio under `xvfb-run`
- on failure: upload screenshots + tauri-driver/app logs as artifacts

## Failure handling / flakiness discipline

- Assertions on async state (post-commit log update, watcher-driven refresh)
  use WebdriverIO `waitUntil` / auto-wait with generous timeouts (~10s), never
  fixed sleeps.
- Screenshot-on-failure in the `afterTest` hook.
- Suite stays at 2 specs until proven stable in CI; extensions (clone flow,
  branch switch) come after.

## Verification

Linux-CI-only, so: push the branch, watch the `e2e-tests` job. Fixture
generation and settings seeding are plain Node + git and can be validated
locally in WSL; only the WebDriver run itself needs CI.
