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
 * Open a context menu by dispatching `contextmenu` at the element's center.
 * WebKitWebDriver's pointer Actions API is unreliable here: element- and
 * viewport-origin moves fail ("element not interactable" / "move target out
 * of bounds") or land offset from the target, and wdio v10 routes
 * el.click({ button: "right" }) through an elementFromPoint pre-check that
 * WebKitGTK answers wrongly inside paneview content, scrolling the pane and
 * misplacing the click. The dispatched event is what a native right-click
 * bubbles to the app's onContextMenu handlers, with clientX/Y for menu
 * placement.
 */
export async function rightClick(el: ChainablePromiseElement): Promise<void> {
  const elem = await el;
  await browser.execute((node) => {
    const target = node as Element;
    const r = target.getBoundingClientRect();
    target.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: Math.round(r.x + r.width / 2),
        clientY: Math.round(r.y + r.height / 2),
        button: 2,
      }),
    );
  }, elem);
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
