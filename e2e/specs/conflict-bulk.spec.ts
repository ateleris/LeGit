// Bulk conflict resolution: multi-select conflicted + clean files, resolve
// the conflicted subset via the "Resolve N conflicted" submenu, and verify
// the selection follow-through - the remaining clean file's menu must act on
// it alone. Regression: takeSide left the pre-resolve selection in place, so
// the surviving row's menu read "Stage 3 selected" after a bulk resolve.
import { readFileSync } from "node:fs";
import path from "node:path";
import { browser, $ } from "@wdio/globals";
import { Key } from "webdriverio";
import { rightClick, textContentOf, waitForTextContent } from "../helpers.ts";
import { E2E_HOME } from "../fixtures.ts";

const REPO_DIR = path.join(E2E_HOME, "fixtures", "conflict-bulk");

const row = (section: "wc-unstaged" | "wc-staged", file: string) =>
  `[data-testid="${section}"] [data-testid="file-row"][data-path="${file}"]`;

const menuTexts = () =>
  browser.execute(() =>
    Array.from(document.querySelectorAll('[role="menuitem"]')).map(
      (el) => el.textContent ?? "",
    ),
  );

describe("bulk conflict resolve from the context-menu submenu", () => {
  it("launches mid-merge and opens Working Changes", async () => {
    await $('[data-testid="repo-tab"]').waitForDisplayed({ timeout: 30_000 });
    await waitForTextContent(
      '[data-testid="repo-tab"]',
      "conflict-bulk",
      "repo tab did not show the fixture repo name",
    );
    await waitForTextContent(
      '[data-testid="op-state-banner"]',
      "2 conflicts remaining",
      "banner did not report the in-progress merge's conflicts",
    );
    const wcRow = $('//span[@data-testid="commit-subject"][contains(., "Uncommitted changes")]');
    await wcRow.waitForDisplayed({ timeout: 15_000 });
    await wcRow.click();
    await $(row("wc-unstaged", "a.txt")).waitForDisplayed({ timeout: 15_000 });
    await $(row("wc-unstaged", "clean.txt")).waitForDisplayed();
  });

  it("multi-selects all three files and takes incoming for the conflicted two", async () => {
    // The whole interaction retries until its real outcome - a.txt leaving
    // the unstaged list - is on screen. Each attempt redoes the selection
    // and the menu dance from scratch: WebKitWebDriver's synthetic pointer
    // can silently lose a step against the menu layers (a menu left open by
    // a previous attempt overlays the row; a click that lands next to the
    // flyout dismisses the menu instead of activating the entry), and the
    // menu content is a snapshot that only holds the Resolve submenu once
    // the conflict-kind data is in. A first CI run failed exactly this way:
    // every step reported success, yet the end state showed up late.
    await browser.waitUntil(
      async () => {
        if (!(await $(row("wc-unstaged", "a.txt")).isExisting())) return true;
        try {
          // Close any surface a previous attempt left open (layer stack).
          await browser.keys(Key.Escape);
          // Select a.txt, extend over b.txt and clean.txt (the FileTree
          // container holds focus after the click).
          await $(row("wc-unstaged", "a.txt")).click();
          await browser.keys([Key.Shift, Key.ArrowDown]);
          await browser.keys([Key.Shift, Key.ArrowDown]);
          await rightClick($(row("wc-unstaged", "a.txt")));
          const trigger = $('[data-testid="resolve-conflicted"]');
          await trigger.waitForDisplayed({ timeout: 2_000 });
          // Only the 2 conflicted files of the 3 selected count. A wrong
          // count keeps failing every attempt - the timeout reports it.
          const label = await textContentOf('[data-testid="resolve-conflicted"]');
          if (!label.includes("Resolve 2 conflicted")) {
            throw new Error(`unexpected submenu label: ${label}`);
          }
          // Clicking the trigger pins the flyout open; take incoming.
          await trigger.click();
          const take = $('[data-testid="resolve-take-theirs"]');
          await take.waitForClickable({ timeout: 2_000 });
          await take.click();
          // The action closes the menu and moves the row; a still-open
          // flyout or a lingering row means a step was swallowed - retry.
          await take.waitForDisplayed({ reverse: true, timeout: 2_000 });
          await $(row("wc-unstaged", "a.txt")).waitForDisplayed({
            reverse: true,
            timeout: 5_000,
          });
          return true;
        } catch {
          return false;
        }
      },
      {
        timeout: 60_000,
        interval: 1_000,
        timeoutMsg: "bulk take-incoming never resolved the conflicted files",
      },
    );
  });

  it("stages the resolved files, keeps the clean one unstaged, writes theirs to disk", async () => {
    await $(row("wc-unstaged", "a.txt")).waitForDisplayed({ reverse: true, timeout: 30_000 });
    await $(row("wc-unstaged", "b.txt")).waitForDisplayed({ reverse: true, timeout: 15_000 });
    await $(row("wc-staged", "a.txt")).waitForDisplayed({ timeout: 15_000 });
    await $(row("wc-staged", "b.txt")).waitForDisplayed();
    await $(row("wc-unstaged", "clean.txt")).waitForDisplayed();
    expect(readFileSync(path.join(REPO_DIR, "a.txt"), "utf8")).toBe("feature change\n");
    expect(readFileSync(path.join(REPO_DIR, "b.txt"), "utf8")).toBe("feature change\n");
  });

  it("the surviving file's menu acts on it alone (no stale selection)", async () => {
    await rightClick($(row("wc-unstaged", "clean.txt")));
    const stageItem = $('//button[@role="menuitem" and normalize-space(.)="Stage"]');
    await stageItem.waitForDisplayed({
      timeout: 10_000,
      timeoutMsg: "the single-file Stage entry did not appear",
    });
    // The pre-fix bug: the menu still targeted the resolved files too and
    // read "Stage 3 selected".
    const texts = await menuTexts();
    expect(texts.some((t) => t.includes("selected"))).toBe(false);
    await browser.keys(Key.Escape);
  });
});
