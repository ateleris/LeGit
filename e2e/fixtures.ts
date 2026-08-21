// Fixture repos + hermetic app-data seeding for the E2E suite.
//
// The app opens repos at startup by reading `currently_open` from
// `<app-data>/global-settings.json` (src-tauri: restore_open_repos), which is
// how the fixture repo enters the app - WebDriver cannot drive the native
// "open repository" file dialog. The app's data dir is made hermetic by
// pointing HOME/XDG_* at E2E_HOME on the tauri-driver process (wdio.conf.ts).
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export const E2E_HOME = path.resolve(import.meta.dirname, ".e2e-home");
export const SCREENSHOT_DIR = path.resolve(import.meta.dirname, "screenshots");

// Linux app-data dir for the production identifier (a debug build still uses
// tauri.conf.json): $XDG_DATA_HOME/ch.ateleris.legit
const APP_DATA_DIR = path.join(E2E_HOME, ".local", "share", "ch.ateleris.legit");
const FIXTURES_DIR = path.join(E2E_HOME, "fixtures");

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

// Same config pinning as the Rust real-git harness (tests/git_flows.rs):
// deterministic identity, no signing, no CRLF translation.
function initRepo(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.name", "E2E Tester");
  git(dir, "config", "user.email", "e2e@example.com");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "config", "core.autocrlf", "false");
}

/** Two commits on main + one unstaged modification to a tracked file. */
export function buildSmokeFixture(): string {
  const dir = path.join(FIXTURES_DIR, "smoke");
  initRepo(dir);
  writeFileSync(path.join(dir, "notes.txt"), "first line\n");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "initial commit");
  writeFileSync(path.join(dir, "readme.md"), "# smoke fixture\n");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "add readme");
  // Unstaged change the smoke spec stages and commits:
  writeFileSync(path.join(dir, "notes.txt"), "first line\nsecond line\n");
  return dir;
}

/**
 * `main` and `feature` each commit a different line 1 of conflict.txt;
 * clean tree, `main` checked out - merging `feature` conflicts.
 */
export function buildConflictFixture(): string {
  const dir = path.join(FIXTURES_DIR, "conflict");
  initRepo(dir);
  writeFileSync(path.join(dir, "conflict.txt"), "base\n");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "base commit");
  git(dir, "checkout", "-b", "feature");
  writeFileSync(path.join(dir, "conflict.txt"), "feature change\n");
  git(dir, "commit", "-am", "feature edit");
  git(dir, "checkout", "main");
  writeFileSync(path.join(dir, "conflict.txt"), "main change\n");
  git(dir, "commit", "-am", "main edit");
  return dir;
}

function seedAppData(repoPath: string): void {
  mkdirSync(APP_DATA_DIR, { recursive: true });
  // GlobalSettings is #[serde(default)]; only the repo-restore fields matter.
  writeFileSync(
    path.join(APP_DATA_DIR, "global-settings.json"),
    JSON.stringify({ currently_open: [repoPath], active_open_repo: repoPath }, null, 2),
  );
}

/**
 * Wipe all per-app state so sessions stay hermetic. The WebKit profile
 * (localStorage - which persists dockview layouts) lives under the XDG dirs
 * too, so without this a panel opened in one spec leaks into the next
 * session's layout.
 */
function resetAppState(): void {
  // The previous session's processes (webview, GPU) can outlive wdio's
  // teardown and still be writing caches while we wipe - a file recreated
  // mid-delete makes rmSync throw ENOTEMPTY (seen on CI 2026-08-21 with
  // .cache/mesa_shader_cache). A thrown seed is worse than a slow one: the
  // wdio shim only LOGS beforeSession errors and launches the app anyway,
  // unseeded, so the spec fails on a missing repo tab. Retry the removal,
  // and tolerate leftovers in .cache only - GPU/shader caches cannot leak
  // app state, unlike .local (localStorage/layouts/settings) and .config.
  for (const d of [".local", ".cache", ".config"]) {
    try {
      rmSync(path.join(E2E_HOME, d), {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    } catch (e) {
      if (d !== ".cache") throw e;
    }
  }
}

/** Build the fixture matching the spec file about to run and point the app at it. */
export function seedForSpec(specPath: string): void {
  const name = path.basename(specPath.replace(/^file:\/\//, ""));
  resetAppState();
  const repo = name.startsWith("conflict") ? buildConflictFixture() : buildSmokeFixture();
  seedAppData(repo);
}
