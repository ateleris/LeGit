import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Controls sharing a toolbar row must share ONE control height (CLAUDE.md).
// The bug this pins: the toolbar input normalization was scoped to
// input[type="text"], so a typeless <input> (a text input to the browser,
// but matching no type selector) kept the fat global input chrome and
// rendered taller than the buttons beside it (Layouts panel toolbar).

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "global.css"),
  "utf8",
);

/** All rules ({selectors, body}) whose selector list mentions `part`. */
function rulesMatching(part: string): { selectors: string; body: string }[] {
  const out: { selectors: string; body: string }[] = [];
  // Good enough for this stylesheet: no nested rules outside @media, and the
  // rules under test are top-level.
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (const m of css.matchAll(re)) {
    if (m[1].includes(part)) out.push({ selectors: m[1].trim(), body: m[2] });
  }
  return out;
}

const heightOf = (body: string) => body.match(/(?:^|;|\s)height:\s*([^;]+);/)?.[1].trim();

describe("toolbar control heights", () => {
  const buttonRules = rulesMatching(".legit-panel__toolbar button");
  const inputRules = rulesMatching(
    '.legit-panel__toolbar input:not([type="checkbox"]):not([type="radio"])',
  );

  it("normalizes EVERY non-checkbox/radio input variant, not specific types", () => {
    // A type-scoped selector silently exempts other input variants (and
    // typeless inputs) from the compact metrics — extend the shared broad
    // rule instead of adding a per-type one.
    expect(inputRules).toHaveLength(1);
    expect(css).not.toMatch(/\.legit-panel__toolbar input\[type=/);
  });

  it("selects share the inputs' normalization rule", () => {
    expect(inputRules[0].selectors).toContain(".legit-panel__toolbar select");
  });

  it("buttons and inputs in a toolbar get the same control height", () => {
    expect(buttonRules).toHaveLength(1);
    const buttonHeight = heightOf(buttonRules[0].body);
    const inputHeight = heightOf(inputRules[0].body);
    expect(buttonHeight).toBeDefined();
    expect(inputHeight).toBe(buttonHeight);
  });
});
