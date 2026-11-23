import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The bug this pins: the spaced panel chrome hid dockview's separator lines
// for every themed dockview surface, including the bare splitviews of the
// popup windows (Work Log, File History). Those have no groupviews to carry
// the replacement border, so their panes lost every visible divider.

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "global.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

describe("dockview separator lines", () => {
  it("are hidden only inside the docks", () => {
    const hiding = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) =>
      /--dv-separator-border:\s*transparent/.test(m[2]),
    );
    expect(hiding.length).toBeGreaterThan(0);
    for (const rule of hiding) {
      for (const selector of rule[1].split(",")) {
        expect(selector.trim()).toContain(".legit-dock ");
      }
    }
  });
});
