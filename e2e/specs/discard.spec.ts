// Discard flow: the data-loss path behind the confirm-destructive gate.
// Discards the fixture's unstaged modification via the Working Changes
// context menu, passes the central confirm dialog, and verifies the change
// is gone from BOTH the UI and the working tree on disk.
import { readFileSync } from "node:fs";
import path from "node:path";
import { browser, $ } from "@wdio/globals";
import { waitForTextContent } from "../helpers.ts";
import { E2E_HOME } from "../fixtures.ts";

// buildSmokeFixture: notes.txt is "first line\n" at HEAD with an unstaged
// second line in the working tree.
const FIXTURE_FILE = path.join(E2E_HOME, "fixtures", "smoke", "notes.txt");

const logSubjects = () =>
  browser.execute(() =>
    Array.from(document.querySelectorAll('[data-testid="commit-subject"]')).map(
      (el) => el.textContent ?? "",
    ),
  );

describe("discard: confirm-gated discard of an unstaged change", () => {
  it("launches and opens Working Changes", async () => {
    await $('[data-testid="repo-tab"]').waitForDisplayed({ timeout: 30_000 });
    await waitForTextContent(
      '[data-testid="repo-tab"]',
      "smoke",
      "repo tab did not show the fixture repo name",
    );
    const wcRow = $('//span[@data-testid="commit-subject"][contains(., "Uncommitted changes")]');
    await wcRow.waitForDisplayed({ timeout: 15_000 });
    await wcRow.click();
    await $('[data-testid="wc-unstaged"]').waitForDisplayed();
  });

  it("requests the discard from the file row's context menu", async () => {
    const row = $('[data-testid="wc-unstaged"] [data-testid="file-row"][data-path="notes.txt"]');
    await row.waitForDisplayed();
    await row.click({ button: "right" });
    const discardItem = $('//button[@role="menuitem" and contains(., "Discard changes")]');
    await discardItem.waitForClickable({ timeout: 10_000 });
    await discardItem.click();
  });

  it("confirms the dialog (confirm-destructive defaults ON)", async () => {
    // The central confirm dialog (ConfirmDialogHost). Target it by testid: a
    // bare //button[text()="Discard"] is ambiguous (the Diff toolbar has a
    // hunk-level "Discard" too, earlier in DOM order) and the dialog's
    // full-screen backdrop makes that first match unclickable - the modal
    // would time the wait out.
    const confirmBtn = $('[data-testid="confirm-dialog-confirm"]');
    await confirmBtn.waitForClickable({
      timeout: 10_000,
      timeoutMsg: "the discard confirmation dialog did not appear",
    });
    await confirmBtn.click();
  });

  it("removes the change from the UI and from disk", async () => {
    await $('[data-testid="wc-unstaged"] [data-testid="file-row"][data-path="notes.txt"]')
      .waitForDisplayed({ reverse: true, timeout: 15_000 });
    // Clean tree: the synthetic working-dir row leaves the log.
    await browser.waitUntil(
      async () => !(await logSubjects()).some((t) => t.includes("Uncommitted changes")),
      { timeout: 15_000, timeoutMsg: "working-dir row did not disappear after discard" },
    );
    // And the file on disk is back at its HEAD content.
    expect(readFileSync(FIXTURE_FILE, "utf8")).toBe("first line\n");
  });
});
