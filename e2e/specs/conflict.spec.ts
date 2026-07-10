// Conflict flow: merge a conflicting branch from the Branches panel and
// verify the op-state banner reports the merge with 1 conflict remaining.
import { browser, $, expect } from "@wdio/globals";

describe("conflict: merge with conflicts shows the op-state banner", () => {
  it("launches and opens the conflict fixture repo", async () => {
    // (dockview panel tabs also have role="tab" - the dedicated testid keeps
    // this from matching the "Repositories" panel tab.)
    const tab = $('[data-testid="repo-tab"]');
    await tab.waitForDisplayed({ timeout: 30_000 });
    await expect(tab).toHaveText(expect.stringContaining("conflict"));
  });

  it("opens the Refs panel (Branches section) via the View menu", async () => {
    // The branch list is the Branches section inside the "refs" paneview
    // panel; the section is expanded by default on a fresh profile.
    await $('[data-testid="view-menu-button"]').waitForClickable();
    await $('[data-testid="view-menu-button"]').click();
    await $('[data-testid="view-menu-refs"]').waitForClickable();
    await $('[data-testid="view-menu-refs"]').click();
    await $('[data-testid="branch-row"][data-branch="feature"]')
      .waitForDisplayed({ timeout: 15_000 });
  });

  it("merges 'feature' into 'main' and hits the conflict banner", async () => {
    const featureRow = $('[data-testid="branch-row"][data-branch="feature"]');
    await featureRow.click({ button: "right" });
    const mergeItem = $('[data-testid="menu-merge"]');
    await mergeItem.waitForClickable({ timeout: 10_000 });
    await mergeItem.click();

    const banner = $('[data-testid="op-state-banner"]');
    await banner.waitForDisplayed({ timeout: 15_000 });
    await browser.waitUntil(
      async () => (await banner.getText()).includes("1 conflict remaining"),
      { timeout: 15_000, timeoutMsg: "banner did not report the conflict" },
    );
  });
});
