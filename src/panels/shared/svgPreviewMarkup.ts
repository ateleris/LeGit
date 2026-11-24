// Markup-level facts about SVG previews. An SVG shown through an `<img>` is
// an isolated document: it inherits no `color` from the page, and one without
// absolute width/height has no intrinsic size to lay out with.

const ROOT_TAG = /<svg\b[^>]*>/i;
const ABSOLUTE_LENGTH = /^\s*\d*\.?\d+\s*(px|pt|pc|mm|cm|in|em|ex|rem)?\s*$/i;

export function decodeBase64Utf8(base64: string): string {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function rootAttr(rootTag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(rootTag);
  return m ? (m[1] ?? m[2] ?? "") : null;
}

/** Whether the root `<svg>` declares no absolute width AND height. Decided
 * from the markup because engines disagree on what such an image reports:
 * WebKit says 0x0, Chromium invents 150x150 from the viewBox ratio while
 * still laying it out with no intrinsic size (a content-sized box around it
 * collapses to nothing). */
export function svgLacksIntrinsicSize(markup: string): boolean {
  const root = ROOT_TAG.exec(markup)?.[0];
  if (!root) return false;
  const absolute = (name: string) => {
    const v = rootAttr(root, name);
    return v != null && ABSOLUTE_LENGTH.test(v);
  };
  return !(absolute("width") && absolute("height"));
}

/** Whether the image's colour depends on `currentColor` with nothing in the
 * file deciding it: inside an `<img>` that resolves to black, the CSS initial
 * colour, which is what every standalone SVG renderer shows. */
export function svgUsesInheritedColor(markup: string): boolean {
  const root = ROOT_TAG.exec(markup)?.[0];
  return !!root && /currentcolor/i.test(markup) && rootAttr(root, "color") == null;
}
