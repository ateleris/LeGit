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
