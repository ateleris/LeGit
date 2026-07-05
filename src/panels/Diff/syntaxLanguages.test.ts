import { describe, expect, it } from "vitest";
import { loadParserForPath } from "./syntaxLanguages";

describe("loadParserForPath", () => {
  it("resolves a parser for a known extension (git-style path)", async () => {
    const parser = await loadParserForPath("crates/legit-core/src/runner.rs");
    expect(parser).not.toBeNull();
  });

  it("resolves null for an unknown extension", async () => {
    const parser = await loadParserForPath("assets/logo.xcf");
    expect(parser).toBeNull();
  });

  it("returns the same promise for repeated loads of one language", () => {
    expect(loadParserForPath("a.ts")).toBe(loadParserForPath("b.ts"));
  });
});
