import { describe, test, expect } from "vitest";
import type { AppliedPropagation, DistroKeyResolution } from "../../lib/types";
import { pendingKeyOffers } from "./distroKeyOffers";

function resolution(over: Partial<DistroKeyResolution>): DistroKeyResolution {
  return {
    distro: "Ubuntu",
    source_path: "C:/Users/s/.ssh/id_work",
    target_path: "/home/u/.ssh/id_work",
    exists: true,
    mismatch: false,
    ...over,
  };
}

function applied(repo: string, distro_key: DistroKeyResolution | null): AppliedPropagation {
  return { repo, distro_key };
}

describe("pendingKeyOffers", () => {
  test("keeps only resolutions that need an offer", () => {
    const offers = pendingKeyOffers([
      applied("local", null),
      applied("fine", resolution({})), // key present and matching
      applied("missing", resolution({ exists: false })),
      applied("foreign", resolution({ mismatch: true })),
    ]);
    expect(offers.map((o) => o.target_path)).toHaveLength(2);
    expect(offers[0].exists).toBe(false);
    expect(offers[1].mismatch).toBe(true);
  });

  test("dedupes the same offer from several repos in one distro", () => {
    const r = resolution({ exists: false });
    const offers = pendingKeyOffers([applied("a", r), applied("b", { ...r })]);
    expect(offers).toHaveLength(1);
  });

  test("keeps offers apart per distro and target", () => {
    const offers = pendingKeyOffers([
      applied("a", resolution({ exists: false })),
      applied("b", resolution({ exists: false, distro: "Debian" })),
      applied("c", resolution({ exists: false, target_path: "/home/u/.ssh/other" })),
    ]);
    expect(offers).toHaveLength(3);
  });
});
