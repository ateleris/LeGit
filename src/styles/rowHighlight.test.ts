import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "global.css"), "utf8");

const bodyOf = (selector: string) => {
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1].split(",").map((s) => s.replace(/\/\*[\s\S]*?\*\//g, "").trim());
    if (selectors.includes(selector)) return m[2];
  }
  return null;
};

describe.each(["legit-commit-row", "legit-file-row"])("%s highlight", (row) => {
  it("washes a hovered row that is not selected", () => {
    expect(bodyOf(`.${row}:not(.${row}--selected):hover`)).toContain(
      "background: var(--graph-row-hover-bg)",
    );
  });

  it("keeps the selection colour stable under the pointer", () => {
    expect(bodyOf(`.${row}--selected`)).toContain("background: var(--graph-row-selected-bg)");
    expect(bodyOf(`.${row}:hover`)).toBeNull();
  });
});

describe("legit-file-row keyboard focus", () => {
  it("washes the focused row", () => {
    expect(bodyOf(".legit-file-row--focused")).toContain(
      "background: var(--graph-row-focused-bg)",
    );
  });
});

describe("button rows", () => {
  it("rest transparent instead of taking the button background", () => {
    expect(bodyOf("button.legit-commit-row")).toContain("background: transparent");
  });

  it("stay selected under the pointer despite the global button hover", () => {
    expect(bodyOf("button.legit-commit-row--selected:hover:not(:disabled)")).toContain(
      "background: var(--graph-row-selected-bg)",
    );
    expect(css.indexOf("button.legit-commit-row--selected,")).toBeGreaterThan(
      css.indexOf("button.legit-commit-row {"),
    );
  });
});
