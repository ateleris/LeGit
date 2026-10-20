// Bulk conflict resolution: multi-select conflicted + clean files, resolve
// the conflicted subset via the "Resolve N conflicted" submenu, and verify
// the selection follow-through - the remaining clean file's menu must act on
// it alone. Regression: takeSide left the pre-resolve selection in place, so
// the surviving row's menu read "Stage 3 selected" after a bulk resolve.
import { readFileSync } from "node:fs";
import path from "node:path";
import { browser, $ } from "@wdio/globals";
import { textContentOf, waitForTextContent } from "../helpers.ts";
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
    // Click the first row, then extend the selection with Shift+ArrowDown
    // (the FileTree container holds focus after the click).
    await $(row("wc-unstaged", "a.txt")).click();
    await browser.keys(["Shift", "ArrowDown"]);
    await browser.keys(["Shift", "ArrowDown"]);

    // The menu content is a snapshot: it only holds the Resolve submenu once
    // the conflict-kind data is in. Retry the right-click until it is
    // (Escape closes a too-early menu via the layer stack).
    await browser.waitUntil(
      async () => {
        await $(row("wc-unstaged", "a.txt")).click({ button: "right" });
        if (await $('[data-testid="resolve-conflicted"]').isDisplayed()) return true;
        await browser.keys("Escape");
        return false;
      },
      { timeout: 15_000, timeoutMsg: "the Resolve submenu never appeared" },
    );
    // Only the 2 conflicted files of the 3 selected count.
    expect(await textContentOf('[data-testid="resolve-conflicted"]')).toContain(
      "Resolve 2 conflicted",
    );

    // Clicking the trigger pins the flyout open; take the incoming side.
    await $('[data-testid="resolve-conflicted"]').click();
    const take = $('[data-testid="resolve-take-theirs"]');
    await take.waitForClickable({ timeout: 10_000 });
    await take.click();
  });

  it("stages the resolved files, keeps the clean one unstaged, writes theirs to disk", async () => {
    await $(row("wc-unstaged", "a.txt")).waitForDisplayed({ reverse: true, timeout: 15_000 });
    await $(row("wc-unstaged", "b.txt")).waitForDisplayed({ reverse: true });
    await $(row("wc-staged", "a.txt")).waitForDisplayed({ timeout: 15_000 });
    await $(row("wc-staged", "b.txt")).waitForDisplayed();
    await $(row("wc-unstaged", "clean.txt")).waitForDisplayed();
    expect(readFileSync(path.join(REPO_DIR, "a.txt"), "utf8")).toBe("feature change\n");
    expect(readFileSync(path.join(REPO_DIR, "b.txt"), "utf8")).toBe("feature change\n");
  });

  it("the surviving file's menu acts on it alone (no stale selection)", async () => {
    await $(row("wc-unstaged", "clean.txt")).click({ button: "right" });
    const stageItem = $('//button[@role="menuitem" and normalize-space(.)="Stage"]');
    await stageItem.waitForDisplayed({
      timeout: 10_000,
      timeoutMsg: "the single-file Stage entry did not appear",
    });
    // The pre-fix bug: the menu still targeted the resolved files too and
    // read "Stage 3 selected".
    const texts = await menuTexts();
    expect(texts.some((t) => t.includes("selected"))).toBe(false);
    await browser.keys("Escape");
  });
});
