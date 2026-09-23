import { describe, expect, it } from "vitest";
import { authorInitials, gravatarUrl, hashEmail } from "./avatars";

describe("hashEmail", () => {
  it("hashes the SHA-256 of the lowercased, trimmed email", async () => {
    // Known vector: sha256("simon@example.com")
    expect(await hashEmail("simon@example.com")).toBe(
      "214fa93449aa38132c6f168693756e9c176fa5513bcdabed230a15dfec6afb3a",
    );
  });

  it("normalizes case and surrounding whitespace (Gravatar's canonical form)", async () => {
    const canonical = await hashEmail("simon@example.com");
    expect(await hashEmail("  Simon@Example.COM  ")).toBe(canonical);
  });

  it("produces 64 lowercase hex chars", async () => {
    expect(await hashEmail("a@b.c")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("gravatarUrl", () => {
  it("builds the avatar URL with d=404 so 'no avatar' is detectable", () => {
    expect(gravatarUrl("abc123", 64)).toBe(
      "https://www.gravatar.com/avatar/abc123?s=64&d=404",
    );
  });

  it("defaults to a single fixed size (one cache entry per email)", () => {
    const url = gravatarUrl("abc123");
    expect(url).toContain("s=128");
    expect(url).toContain("d=404");
  });
});

describe("authorInitials", () => {
  it("takes the first letters of the first and last words", () => {
    expect(authorInitials("Simon Beck")).toBe("SB");
    expect(authorInitials("Ada King Lovelace")).toBe("AL");
  });

  it("takes the first two letters of a one-word name (2 letters preferred)", () => {
    expect(authorInitials("torvalds")).toBe("TO");
  });

  it("falls back to a single letter only when two are not available", () => {
    expect(authorInitials("q")).toBe("Q");
  });

  it("never yields more than two letters", () => {
    expect(authorInitials("Anna Maria von und zu Liechtenstein").length).toBe(2);
    expect(authorInitials("supercalifragilistic").length).toBe(2);
  });

  it("uppercases and ignores surrounding/multiple whitespace", () => {
    expect(authorInitials("  simon   beck  ")).toBe("SB");
  });

  it("returns an empty string when the name has no letters to use", () => {
    expect(authorInitials("")).toBe("");
    expect(authorInitials("   ")).toBe("");
  });

  it("keeps non-ASCII letters intact", () => {
    expect(authorInitials("Åsa Öberg")).toBe("ÅÖ");
    expect(authorInitials("千葉 直樹")).toBe("千直");
  });

  it("skips a leading non-letter so bracketed bot names still get a letter", () => {
    expect(authorInitials("[bot] deployer")).toBe("BD");
  });
});
