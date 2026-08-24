// Core smoke: the app launches, opens the fixture repo, and a stage -> commit
// round-trip lands in the log. Exercises UI -> IPC -> GitRunner -> real git ->
// watcher/React Query refresh in one pass.
import { browser, $, expect } from "@wdio/globals";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { waitForTextContent } from "../helpers.ts";
import { SMOKE_REPO_DIR } from "../fixtures.ts";

// The fixture (e2e/fixtures.ts buildSmokeFixture): repo "smoke", 2 commits
// ("initial commit", "add readme"), notes.txt modified but unstaged.
const COMMIT_MESSAGE = "e2e: smoke commit";

describe("smoke: stage and commit", () => {
  it("launches and opens the fixture repo", async () => {
    // First render after startup + restore_open_repos can take a while on CI.
    await $('[data-testid="repo-tab"]').waitForDisplayed({ timeout: 30_000 });
    await waitForTextContent(
      '[data-testid="repo-tab"]',
      "smoke",
      "repo tab did not show the fixture repo name",
    );
  });

  it("shows the uncommitted-changes row and opens Working Changes", async () => {
    const wcRow = $('//span[@data-testid="commit-subject"][contains(., "Uncommitted changes")]');
    await wcRow.waitForDisplayed({ timeout: 15_000 });
    await wcRow.click();
    await $('[data-testid="wc-unstaged"]').waitForDisplayed();
  });

  it("stages the modified file", async () => {
    const rowSel = '[data-testid="wc-unstaged"] [data-testid="file-row"][data-path="notes.txt"]';
    const row = $(rowSel);
    await row.waitForDisplayed();
    // The Stage icon-button mounts only while the row is hovered - and hover
    // must NOT be established via moveTo(): WebKitWebDriver parks the virtual
    // pointer (a sweep to the top-left corner) a few hundred ms after every
    // action sequence, firing mouseleave and unmounting the button BETWEEN
    // wdio commands. Whether the click won that race depended on runner
    // speed (flaked on CI 2026-08-24). Instead, drive the row's onMouseEnter
    // in-page right before the click; the click itself re-hovers the row
    // atomically inside one command.
    const hoverRow = (sel: string) =>
      browser.execute((s: string) => {
        document.querySelector(s)!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      }, sel);
    await hoverRow(rowSel);
    const stageBtn = $('[data-testid="wc-unstaged"] button[title="Stage"]');
    await stageBtn.waitForClickable();
    await hoverRow(rowSel); // re-arm in case the park raced the wait above
    await stageBtn.click();
    await $('[data-testid="wc-staged"] [data-testid="file-row"][data-path="notes.txt"]')
      .waitForDisplayed({ timeout: 10_000 });
  });

  it("commits and sees the commit in the log", async () => {
    await $('textarea[placeholder="Commit message"]').setValue(COMMIT_MESSAGE);
    const commitBtn = $('[data-testid="commit-button"]');
    await commitBtn.waitForEnabled();
    await commitBtn.click();

    // The new commit appears at the top of the log and the synthetic
    // working-dir row disappears (tree is clean again). Read the subjects
    // atomically via execute(): element handles from $$() go stale while the
    // log re-renders after the commit, which made per-element getText() throw.
    const logSubjects = () =>
      browser.execute(() =>
        Array.from(document.querySelectorAll('[data-testid="commit-subject"]')).map(
          (el) => el.textContent ?? "",
        ),
      );
    await browser.waitUntil(
      async () => (await logSubjects()).some((t) => t.includes(COMMIT_MESSAGE)),
      { timeout: 15_000, timeoutMsg: "new commit did not appear in the log" },
    );
    await browser.waitUntil(
      async () => !(await logSubjects()).some((t) => t.includes("Uncommitted changes")),
      { timeout: 15_000, timeoutMsg: "working-dir row did not disappear after commit" },
    );
  });

  it("ellipsizes an overlong filename instead of overlapping the diffstat", async () => {
    // Regression (fixed 2026-08-24): in flat view the filename span never
    // shrank, so a name wider than the pane painted over the +/- diffstat
    // column. Stage a scratch file with an overlong name (the watcher picks
    // up the external write, the app's primary live-update path) and assert
    // the name's box ends before the diffstat's begins.
    const longName =
      "a-regression-guard-for-very-long-filenames-that-must-ellipsize-inside-the-file-row-instead-of-overlapping-the-diffstat-numbers.txt";
    writeFileSync(path.join(SMOKE_REPO_DIR, longName), "one\ntwo\nthree\n");
    execFileSync("git", ["add", longName], { cwd: SMOKE_REPO_DIR, stdio: "pipe" });

    const rowSel =
      `[data-testid="wc-staged"] [data-testid="file-row"][data-path="${longName}"]`;
    await $(rowSel).waitForDisplayed({ timeout: 15_000 });
    const rects = await browser.execute((sel: string) => {
      const row = document.querySelector(sel)!;
      const name = row.querySelector('[data-testid="file-row-name"]')!.getBoundingClientRect();
      const stats = row.querySelector('[data-testid="file-row-stats"]')!.getBoundingClientRect();
      return { nameRight: name.right, statsLeft: stats.left, statsWidth: stats.width };
    }, rowSel);
    // The diffstat is actually rendered (guards against a vacuous pass) ...
    expect(rects.statsWidth).toBeGreaterThan(0);
    // ... and the filename ends before it starts.
    expect(rects.nameRight).toBeLessThanOrEqual(rects.statsLeft);
  });
});
