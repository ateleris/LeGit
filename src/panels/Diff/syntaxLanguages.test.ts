import { describe, expect, it } from "vitest";
import { loadLanguageForPath, loadParserForPath } from "./syntaxLanguages";

describe("loadParserForPath", () => {
  it("resolves a parser for a known extension (git-style path)", async () => {
    const parser = await loadParserForPath("crates/legit-core/src/runner.rs");
    expect(parser).not.toBeNull();
  });

  it("resolves null for an unknown extension", async () => {
    const parser = await loadParserForPath("assets/logo.xcf");
    expect(parser).toBeNull();
  });

  it("loads each language once (repeated loads share the cached load)", async () => {
    expect(loadLanguageForPath("a.ts")).toBe(loadLanguageForPath("b.ts"));
    const [p1, p2] = await Promise.all([loadParserForPath("a.ts"), loadParserForPath("b.ts")]);
    expect(p1).toBe(p2);
  });
});

describe("loadLanguageForPath", () => {
  // Whole-file editors (File View, 3-way resolve panes) attach the language
  // support directly instead of reconstructing text for a bare parser.
  it("resolves a LanguageSupport for a known extension", async () => {
    const support = await loadLanguageForPath("src/lib/commands.ts");
    expect(support).not.toBeNull();
    expect(support!.language).toBeDefined();
  });

  it("resolves null for an unknown extension", async () => {
    expect(await loadLanguageForPath("assets/logo.xcf")).toBeNull();
  });

  it("shares the underlying load with the parser path", async () => {
    const support = await loadLanguageForPath("x.rs");
    const parser = await loadParserForPath("y.rs");
    expect(parser).toBe(support!.language.parser);
  });
});
