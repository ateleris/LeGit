import { readdirSync, readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Spacing counterpart of noLiteralColors.test.ts: paddings, margins, gaps,
// and font sizes must scale with --ui-font-size (CLAUDE.md), so fixed px in
// those properties fails here. Widths/heights/borders are out of scope.

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Deliberately unscaled files. */
const ALLOWED_FILES = new Set([
  // Dev-only ribbon, pinned appearance by decision (like noLiteralColors).
  "panels/DevRibbon.tsx",
]);

// CSS: a spacing property whose value contains a nonzero px length outside
// a var()-anchored calc().
const CSS_DECL = /(?:^|[;{\s])(padding|margin|gap|row-gap|column-gap|font-size)(-[a-z]+)?\s*:\s*([^;}]+)/g;
// TSX: a spacing style prop with a bare number or a px-containing string.
const TSX_DECL = /\b(padding(?:Top|Right|Bottom|Left|Block|Inline)?|margin(?:Top|Right|Bottom|Left|Block|Inline)?|gap|rowGap|columnGap|fontSize)\s*:\s*("[^"\n]*"|'[^'\n]*'|[\d.]+)/g;
const NONZERO_PX = /(?:[1-9]\d*|\d*\.\d*[1-9]\d*)(?:\.\d+)?px/;

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (/\.(tsx|css)$/.test(entry.name) && !/\.test\./.test(entry.name)) out.push(full);
  }
  return out;
}

const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length;

describe("no fixed-px spacing", () => {
  it("padding/margin/gap/font-size scale with the UI font size", () => {
    const violations: string[] = [];
    for (const file of listSourceFiles(SRC)) {
      const rel = relative(SRC, file).replace(/\\/g, "/");
      if (ALLOWED_FILES.has(rel)) continue;
      const text = readFileSync(file, "utf8");
      if (rel.endsWith(".css")) {
        for (const m of text.matchAll(CSS_DECL)) {
          const value = m[3];
          if (!NONZERO_PX.test(value)) continue;
          // calc() anchored to a scale var may carry px offsets.
          if (/calc\([^)]*var\(--(ui-font-size|fz-)/.test(value)) continue;
          violations.push(`${rel}:${lineOf(text, m.index!)}: ${m[1]}${m[2] ?? ""}: ${value.trim()}`);
        }
      } else {
        for (const m of text.matchAll(TSX_DECL)) {
          const value = m[2];
          const bareNumber = /^[\d.]+$/.test(value) && Number(value) !== 0;
          const pxString =
            (value.startsWith('"') || value.startsWith("'")) &&
            NONZERO_PX.test(value) &&
            !/var\(--/.test(value);
          if (bareNumber || pxString) {
            violations.push(`${rel}:${lineOf(text, m.index!)}: ${m[1]}: ${value}`);
          }
        }
      }
    }
    expect(
      violations,
      `Spacing must derive from --ui-font-size (em / calc / scale vars):\n${violations.join("\n")}`,
    ).toEqual([]);
  });
});
