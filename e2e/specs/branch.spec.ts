// Branch lifecycle: create a branch in the Branches section and switch to it.
// Covers create-form -> backend -> list refresh -> checkout -> current-branch
// marker movement in one pass.
import { browser, $ } from "@wdio/globals";
import { waitForTextContent } from "../helpers.ts";

const BRANCH = "e2e-branch";
const row = (name: string) => `[data-testid="branch-row"][data-branch="${name}"]`;
// The Checkout button renders only on NON-current branches, so its
// presence/absence is the current-branch signal.
const checkoutBtn = (name: string) =>
  // normalize-space() (no arg) matches on the button's whole string value:
  // row actions are ToolbarButtons whose label sits in a nested <span>, so
  // text() (direct text nodes only) never matches them.
  `//div[@data-testid="branch-row" and @data-branch="${name}"]//button[normalize-space()="Checkout"]`;

describe("branch: create and switch", () => {
  it("launches and opens the Branches section", async () => {
    await $('[data-testid="repo-tab"]').waitForDisplayed({ timeout: 30_000 });
    await waitForTextContent(
      '[data-testid="repo-tab"]',
      "smoke",
      "repo tab did not show the fixture repo name",
    );
    await $('[data-testid="view-menu-button"]').waitForClickable();
    await $('[data-testid="view-menu-button"]').click();
    await $('[data-testid="view-menu-refs"]').waitForClickable();
    await $('[data-testid="view-menu-refs"]').click();
    await $(row("main")).waitForDisplayed({ timeout: 15_000 });
  });

  it("creates a branch from the New-branch form and auto-checks it out", async () => {
    const nameInput = $('input[placeholder="name"]');
    await nameInput.waitForDisplayed();
    await nameInput.setValue(BRANCH);
    // Enter submits the form (avoids disambiguating the Create button from
    // other sections' buttons inside the shared Refs paneview).
    await browser.keys("Enter");
    await $(row(BRANCH)).waitForDisplayed({ timeout: 15_000 });
    // The checkout-on-create setting defaults ON: the new branch becomes
    // current right away (no Checkout button on it), and main gains one.
    await $(checkoutBtn(BRANCH)).waitForExist({ reverse: true, timeout: 15_000 });
    await $(checkoutBtn("main")).waitForExist({ timeout: 15_000 });
  });

  it("switches back to main via its Checkout button", async () => {
    const btn = $(checkoutBtn("main"));
    await btn.waitForClickable();
    await btn.click();
    // The marker moves back: main loses its Checkout button, the new
    // branch gains one.
    await $(checkoutBtn("main")).waitForExist({ reverse: true, timeout: 15_000 });
    await $(checkoutBtn(BRANCH)).waitForExist({ timeout: 15_000 });
  });
});
