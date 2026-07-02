import { readdirSync, readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// CSS-side counterpart of contract.test.ts: every colour in the UI must
// resolve from a theme token (CLAUDE.md — a user theme must be able to render
// the app fully white or fully black). This test greps the source for colour
// literals and fails on any that isn't a `var(--token, <fallback>)` fallback.

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Files whose colour literals are part of the theme system itself. */
const ALLOWED_FILES = new Set([
  // The :root fallback definitions — literals by design (pre-theme-load).
  "styles/theme.css",
  // The built-in default theme document.
  "theme/defaults.ts",
  // Token-filter machinery: colour math + color-mix recipes are the theme
  // system itself, not UI chrome.
  "theme/filters.ts",
  // The Theme Editor manipulates literal colours as *data* (default value for
  // a new palette entry, hex normalization fallbacks) — not UI chrome.
  "panels/ThemeEditor/ThemeEditorPanel.tsx",
]);

const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g;

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (/\.(ts|tsx|css)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe("no literal colours outside the theme system", () => {
  it("every colour is var(--token) or a var() fallback", () => {
    const violations: string[] = [];
    for (const file of listSourceFiles(SRC)) {
      const rel = relative(SRC, file).replace(/\\/g, "/");
      if (ALLOWED_FILES.has(rel)) continue;
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(COLOR_LITERAL)) {
        // Allowed as the fallback inside `var(--token, <literal>)` — the
        // pre-theme-load safety net (must mirror the built-in Dark theme).
        const before = text.slice(Math.max(0, m.index! - 80), m.index!);
        if (/var\(--[a-zA-Z0-9-]+,\s*$/.test(before)) continue;
        const line = text.slice(0, m.index!).split("\n").length;
        violations.push(`${rel}:${line}: ${m[0]}`);
      }
    }
    expect(
      violations,
      `Colour literals must come from theme tokens (var(--token)):\n${violations.join("\n")}`,
    ).toEqual([]);
  });
});
