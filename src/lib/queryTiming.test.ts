import { readdirSync, readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Companion of noLiteralColors.test.ts: every staleTime in src/ must come
// from the STALE tiers so query freshness is tuned in one place.

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

const ALLOWED_FILES = new Set([
  "lib/queryTiming.ts",
  "lib/queryTiming.test.ts",
]);

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("query staleTime comes from the STALE tiers", () => {
  it("no literal staleTime values outside queryTiming.ts", () => {
    const violations: string[] = [];
    for (const file of listSourceFiles(SRC)) {
      const rel = relative(SRC, file).replace(/\\/g, "/");
      if (ALLOWED_FILES.has(rel)) continue;
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/staleTime:\s*([^,\n]+)/g)) {
        // A ternary over STALE tiers is fine; literal numbers are not.
        if (!/\d|Infinity/.test(m[1])) continue;
        const line = text.slice(0, m.index!).split("\n").length;
        violations.push(`${rel}:${line}: ${m[0]}`);
      }
    }
    expect(
      violations,
      `staleTime must use the STALE constants (lib/queryTiming.ts):\n${violations.join("\n")}`,
    ).toEqual([]);
  });
});
