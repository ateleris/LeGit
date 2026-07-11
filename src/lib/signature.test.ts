// Security-facing mapping: each signature status must keep its severity tier
// (token colour) - a "Bad"/"Revoked" rendering as success-green would
// misrepresent trust.

import { describe, test, expect } from "vitest";
import { signaturePresentation } from "./signature";
import type { SignatureStatus } from "./types";

const ALL: SignatureStatus[] = [
  "Good",
  "Untrusted",
  "Expired",
  "UnknownKey",
  "BadSignature",
  "Revoked",
  "NoSignature",
];

describe("signaturePresentation", () => {
  test("every status maps to a complete presentation", () => {
    for (const s of ALL) {
      const p = signaturePresentation(s);
      expect(p.color).toMatch(/^var\(--/);
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.title.length).toBeGreaterThan(0);
    }
  });

  test("severity tiers use the matching theme token", () => {
    expect(signaturePresentation("Good").color).toBe("var(--success-fg)");
    for (const warn of ["Untrusted", "Expired", "UnknownKey"] as const) {
      expect(signaturePresentation(warn).color).toBe("var(--warning-fg)");
    }
    for (const bad of ["BadSignature", "Revoked"] as const) {
      expect(signaturePresentation(bad).color).toBe("var(--error-fg)");
    }
    expect(signaturePresentation("NoSignature").color).toBe("var(--subtle-fg)");
  });

  test("unsigned commits show no badge glyph", () => {
    expect(signaturePresentation("NoSignature").symbol).toBe("");
  });
});
