// Regression test for the cross-panel profile staleness bug: creating or
// deleting a profile in Global Settings must update the Repo Settings
// profile dropdown WITHOUT the repo panel being focused (the old code only
// refreshed on panel focus). Repo Settings is activated once so it mounts,
// then left unfocused; all dropdown assertions read the DOM directly.
// Also covers the delete-confirmation gate (destructive setting default ON).
import { browser, $, expect } from "@wdio/globals";
import { waitForTextContent } from "../helpers.ts";

const PROFILE_NAME = "E2E Profile";

/** Click a dockview tab by its title text (works for both docks).
 *  Token-safe class match: contains(@class, "dv-tab") also substring-matches
 *  the "dv-tabs-…" CONTAINER elements, which precede the tab in document
 *  order - $() then returns the container and the click lands on whatever
 *  tab happens to sit at its center (broke when the default layout grouped
 *  three tabs together).
 *
 *  Click-and-VERIFY with bounded retries: during the first seconds after
 *  launch the window's dock geometry is still settling (tab strips scroll
 *  under the pointer between WebDriver's scroll-into-view and its click),
 *  so a single click can land on the neighbouring tab. Root-caused
 *  2026-08-06: the strip sat 200px off its final position at click time;
 *  the click activated Repositories instead of Global Settings. Verifying
 *  `aria-selected` and re-clicking makes the helper immune to WHERE the
 *  click lands, without papering over activation being genuinely broken. */
async function clickDockTab(title: string): Promise<void> {
  const tab = $(
    `//div[contains(concat(" ", normalize-space(@class), " "), " dv-tab ")][contains(., "${title}")]`,
  );
  await tab.waitForDisplayed({ timeout: 15_000 });
  for (let attempt = 0; attempt < 4; attempt++) {
    await tab.click();
    try {
      await browser.waitUntil(
        async () => (await tab.getAttribute("aria-selected")) === "true",
        { timeout: 2_000 },
      );
      return;
    } catch {
      // Strip moved under the click - loop re-clicks at fresh coordinates.
    }
  }
  throw new Error(`dock tab "${title}" did not activate after 4 clicks`);
}

/** Option labels of the repo profile dropdown, read atomically (no focus). */
function repoDropdownOptions(): Promise<string[]> {
  return browser.execute(() =>
    Array.from(
      document.querySelectorAll('[data-testid="repo-profile-select"] option'),
    ).map((o) => o.textContent ?? ""),
  );
}

describe("profiles: cross-panel freshness + delete confirmation", () => {
  it("opens the repo and both settings panels", async () => {
    await $('[data-testid="repo-tab"]').waitForDisplayed({ timeout: 30_000 });
    await waitForTextContent('[data-testid="repo-tab"]', "smoke", "repo tab missing");
    // Activate Repo Settings FIRST so it renders its dropdown, then leave
    // it unfocused for the rest of the test.
    await clickDockTab("Repo Settings");
    await $('[data-testid="repo-profile-select"]').waitForDisplayed({ timeout: 15_000 });
    await clickDockTab("Global Settings");
    await $('[data-testid="profile-new"]').waitForDisplayed({ timeout: 15_000 });
  });

  it("creating a profile updates the unfocused repo dropdown", async () => {
    await $('[data-testid="profile-new"]').click();
    await $('[data-testid="profile-name-input"]').setValue(PROFILE_NAME);
    await $('[data-testid="profile-save"]').click();
    await browser.waitUntil(
      async () => (await repoDropdownOptions()).includes(PROFILE_NAME),
      { timeout: 15_000, timeoutMsg: "new profile did not reach the repo dropdown without focus" },
    );
  });

  it("delete asks for confirmation first", async () => {
    await $('[data-testid="profile-delete"]').click();
    await $('[data-testid="profile-delete-confirm"]').waitForDisplayed({ timeout: 10_000 });
    // Not deleted yet: the repo dropdown still lists it.
    expect(await repoDropdownOptions()).toContain(PROFILE_NAME);
  });

  it("confirming the delete removes it from the unfocused repo dropdown", async () => {
    await $('[data-testid="profile-delete-confirm"]').click();
    await browser.waitUntil(
      async () => !(await repoDropdownOptions()).includes(PROFILE_NAME),
      { timeout: 15_000, timeoutMsg: "deleted profile still in the repo dropdown without focus" },
    );
  });
});
