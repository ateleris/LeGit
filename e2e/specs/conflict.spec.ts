// Conflict flow: merge a conflicting branch from the Branches panel and
// verify the op-state banner reports the merge with 1 conflict remaining.
import { $ } from "@wdio/globals";
import { waitForTextContent } from "../helpers.ts";

describe("conflict: merge with conflicts shows the op-state banner", () => {
  it("launches and opens the conflict fixture repo", async () => {
    await $('[data-testid="repo-tab"]').waitForDisplayed({ timeout: 30_000 });
    await waitForTextContent(
      '[data-testid="repo-tab"]',
      "conflict",
      "repo tab did not show the fixture repo name",
    );
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
    // Right-click the branch NAME, not the row: the row's center can land on
    // its Checkout/Rename/Delete buttons (a run showed the rename editor
    // popping open as collateral). The contextmenu handler sits on the row
    // and the event bubbles, so any child is a valid target.
    const featureName = $(
      '//div[@data-testid="branch-row" and @data-branch="feature"]//span[contains(text(), "feature")]',
    );
    await featureName.waitForDisplayed();
    await featureName.click({ button: "right" });
    // Merge variants live in a submenu: click the trigger to open the flyout,
    // then pick the default merge inside it.
    const mergeSubmenu = $('[data-testid="menu-merge-submenu"]');
    await mergeSubmenu.waitForClickable({ timeout: 10_000 });
    await mergeSubmenu.click();
    const mergeItem = $('[data-testid="menu-merge"]');
    await mergeItem.waitForClickable({ timeout: 10_000 });
    await mergeItem.click();

    await $('[data-testid="op-state-banner"]').waitForDisplayed({ timeout: 15_000 });
    await waitForTextContent(
      '[data-testid="op-state-banner"]',
      "1 conflict remaining",
      "banner did not report the conflict",
    );
  });
});
