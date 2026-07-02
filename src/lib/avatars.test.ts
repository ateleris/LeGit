import { describe, expect, it } from "vitest";
import { gravatarUrl, hashEmail } from "./avatars";

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
