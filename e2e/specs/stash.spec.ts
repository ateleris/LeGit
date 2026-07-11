// Stash lifecycle through the UI: stash the fixture's unstaged change from
// the Stashes section, then pop it back. Verifies the working-dir row and
// the stash entry trade places in both directions.
import { browser, $ } from "@wdio/globals";
import { waitForTextContent } from "../helpers.ts";

const STASH_MESSAGE = "e2e stash";

const logSubjects = () =>
  browser.execute(() =>
    Array.from(document.querySelectorAll('[data-testid="commit-subject"]')).map(
      (el) => el.textContent ?? "",
    ),
  );

describe("stash: create and pop", () => {
  it("launches with a dirty tree and opens the Stashes section", async () => {
    await $('[data-testid="repo-tab"]').waitForDisplayed({ timeout: 30_000 });
    await waitForTextContent(
      '[data-testid="repo-tab"]',
      "smoke",
      "repo tab did not show the fixture repo name",
    );
    await browser.waitUntil(
      async () => (await logSubjects()).some((t) => t.includes("Uncommitted changes")),
      { timeout: 15_000, timeoutMsg: "expected a dirty tree before stashing" },
    );
    await $('[data-testid="view-menu-button"]').waitForClickable();
    await $('[data-testid="view-menu-button"]').click();
    await $('[data-testid="view-menu-refs"]').waitForClickable();
    await $('[data-testid="view-menu-refs"]').click();
    await $('input[placeholder="message (optional)"]').waitForDisplayed({ timeout: 15_000 });
  });

  it("stashes the working tree", async () => {
    await $('input[placeholder="message (optional)"]').setValue(STASH_MESSAGE);
    const stashBtn = $('//button[normalize-space(text())="Stash"]');
    await stashBtn.waitForClickable();
    await stashBtn.click();

    // The stash row appears (its Pop button is the stable handle) ...
    await $('//button[normalize-space(text())="Pop"]').waitForDisplayed({ timeout: 15_000 });
    // ... and the tree is clean again.
    await browser.waitUntil(
      async () => !(await logSubjects()).some((t) => t.includes("Uncommitted changes")),
      { timeout: 15_000, timeoutMsg: "working-dir row did not disappear after stashing" },
    );
  });

  it("pops the stash back", async () => {
    const popBtn = $('//button[normalize-space(text())="Pop"]');
    await popBtn.waitForClickable();
    await popBtn.click();

    await $('//button[normalize-space(text())="Pop"]').waitForExist({
      reverse: true,
      timeout: 15_000,
    });
    await browser.waitUntil(
      async () => (await logSubjects()).some((t) => t.includes("Uncommitted changes")),
      { timeout: 15_000, timeoutMsg: "the popped change did not reappear as a dirty tree" },
    );
  });
});
