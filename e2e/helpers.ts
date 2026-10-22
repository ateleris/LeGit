// Shared spec helpers.
import { browser } from "@wdio/globals";

/**
 * DOM textContent of the first match ("" when absent), read atomically via
 * execute(). WebKitWebDriver's getText() returns "" for text inside
 * overflow:hidden containers (tabs, banners, subject cells), and per-element
 * getText() also throws on nodes that go stale mid-poll - textContent via
 * execute() avoids both.
 */
export function textContentOf(selector: string): Promise<string> {
  return browser.execute(
    (sel: string) => document.querySelector(sel)?.textContent ?? "",
    selector,
  );
}

/**
 * Right-click via a raw W3C action chain: move to the element's geometric
 * center, press and release button 2. wdio v10's el.click({ button: "right" })
 * first hit-tests the element with elementFromPoint and scrolls on a miss;
 * WebKitGTK's hit-testing disagrees with the layout inside dockview's
 * overflow:hidden paneview content, so that scroll fires and the click then
 * lands on whatever sits at the stale coordinates (observed: the Branches
 * filter input instead of the branch row). The raw chain skips the hit-test,
 * which is exactly what wdio v9 did.
 */
export async function rightClick(el: ChainablePromiseElement): Promise<void> {
  await browser
    .action("pointer")
    .move({ origin: await el })
    .down({ button: 2 })
    .up({ button: 2 })
    .perform();
}

/** Poll until the element's textContent contains `needle`. */
export async function waitForTextContent(
  selector: string,
  needle: string,
  timeoutMsg: string,
): Promise<void> {
  await browser.waitUntil(async () => (await textContentOf(selector)).includes(needle), {
    timeout: 15_000,
    timeoutMsg,
  });
}
