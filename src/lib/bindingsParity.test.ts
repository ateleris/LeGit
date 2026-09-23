import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (f: string) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8");
const names = (src: string, re: RegExp) => new Set([...src.matchAll(re)].map((m) => m[1]));

describe("bindingsParity", () => {
  it("asserts every type that is both hand-mirrored and generated", () => {
    const mirrored = names(read("./types.ts"), /^export (?:interface|type) (\w+)/gm);
    const generated = names(read("./bindings.ts"), /^export type (\w+)/gm);
    const shared = [...mirrored].filter((n) => generated.has(n)).sort();
    const asserted = [...names(read("./bindingsParity.ts"), /Equal<Mirror\.(\w+), Gen\.\1>/g)].sort();
    expect(asserted).toEqual(shared);
  });
});
