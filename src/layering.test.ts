// Lower layers never import panel code: store/keys/lib/layout must stay
// loadable without React components, and a panel import from them is how
// import cycles through the panel registry start.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = dirname(fileURLToPath(import.meta.url));
const LOWER_LAYERS = ["store", "keys", "lib", "layout"];
const PANELS = join(SRC, "panels");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("layering", () => {
  it("store, keys, lib and layout never import from panels", () => {
    const offenders: string[] = [];
    for (const layer of LOWER_LAYERS) {
      for (const file of sourceFiles(join(SRC, layer))) {
        const text = readFileSync(file, "utf8");
        for (const m of text.matchAll(/from\s+["'](\.{1,2}\/[^"']+)["']/g)) {
          const target = resolve(dirname(file), m[1]);
          if (target === PANELS || target.startsWith(PANELS + "/") || target.startsWith(PANELS + "\\")) {
            offenders.push(`${relative(SRC, file)} -> ${m[1]}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
