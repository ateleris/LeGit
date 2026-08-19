import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Cascade-order counterpart of noLiteralColors.test.ts: global.css overrides
// dockview's built-in `.dockview-theme-abyss` variables with theme-token
// mappings at EQUAL selector specificity, so the override only wins if
// dockview's stylesheet is imported BEFORE ours. With the order reversed,
// every element carrying the abyss class (the docks, the Refs paneview) falls
// back to abyss's hardcoded dark colours - the Refs section separators showed
// abyss navy instead of `pane.header.border` in light user themes.

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("stylesheet cascade order", () => {
  it("imports dockview's stylesheet before the LeGit stylesheets", () => {
    const main = readFileSync(join(SRC, "main.tsx"), "utf8");
    const dockview = main.indexOf("dockview-react/dist/styles/dockview.css");
    const theme = main.indexOf("./styles/theme.css");
    const global = main.indexOf("./styles/global.css");
    expect(dockview).toBeGreaterThan(-1);
    expect(theme).toBeGreaterThan(-1);
    expect(global).toBeGreaterThan(-1);
    expect(dockview).toBeLessThan(theme);
    expect(dockview).toBeLessThan(global);
  });
});
