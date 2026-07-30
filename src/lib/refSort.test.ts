import { describe, it, expect } from "vitest";
import { coerceRefsSortMode, sortRefs } from "./refSort";

interface Ref {
  name: string;
  created_at: number;
}

const refs: Ref[] = [
  { name: "main", created_at: 300 },
  { name: "v1.10", created_at: 100 },
  { name: "v1.9", created_at: 200 },
];

const sort = (mode: Parameters<typeof sortRefs>[1]) =>
  sortRefs(refs, mode, (r) => r.name, (r) => r.created_at).map((r) => r.name);

describe("sortRefs", () => {
  it("alphabetical is natural order (v1.9 before v1.10)", () => {
    expect(sort("alphabetical")).toEqual(["main", "v1.9", "v1.10"]);
  });

  it("date is newest first", () => {
    expect(sort("date")).toEqual(["main", "v1.9", "v1.10"]);
    expect(sortRefs(refs, "date", (r) => r.name, (r) => r.created_at)[0].created_at).toBe(300);
  });

  it("date_reversed is oldest first", () => {
    expect(sort("date_reversed")).toEqual(["v1.10", "v1.9", "main"]);
  });

  it("date ties fall back to the name for a deterministic order", () => {
    const tied: Ref[] = [
      { name: "b", created_at: 5 },
      { name: "a", created_at: 5 },
    ];
    expect(sortRefs(tied, "date", (r) => r.name, (r) => r.created_at).map((r) => r.name))
      .toEqual(["a", "b"]);
  });

  it("does not mutate the input array", () => {
    const input = [...refs];
    sortRefs(input, "date", (r) => r.name, (r) => r.created_at);
    expect(input).toEqual(refs);
  });
});

describe("coerceRefsSortMode", () => {
  it("accepts the three known modes", () => {
    expect(coerceRefsSortMode("alphabetical")).toBe("alphabetical");
    expect(coerceRefsSortMode("date")).toBe("date");
    expect(coerceRefsSortMode("date_reversed")).toBe("date_reversed");
  });

  it("falls back to alphabetical for unknown/missing values", () => {
    expect(coerceRefsSortMode(null)).toBe("alphabetical");
    expect(coerceRefsSortMode(undefined)).toBe("alphabetical");
    expect(coerceRefsSortMode("newest")).toBe("alphabetical");
  });
});
