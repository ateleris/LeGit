// Parent choices for cherry-picking/reverting a MERGE commit: which parent
// is the mainline (-m N). Regular commits get no picker; labels carry the
// parent's short SHA and subject so the choice is informed, not a numbers
// quiz.

import { describe, expect, it } from "vitest";
import { mainlineChoices } from "./mainline";

const P1 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const P2 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const subjects: Record<string, string> = {
  [P1]: "main work",
  [P2]: "feature: last commit",
};
const subjectOf = (id: string) => subjects[id] ?? null;

describe("mainlineChoices", () => {
  it("is null for regular commits - no picker needed", () => {
    expect(mainlineChoices({ parents: [P1] }, subjectOf)).toBeNull();
    expect(mainlineChoices({ parents: [] }, subjectOf)).toBeNull();
  });

  it("labels each parent with its 1-based number, short sha, and subject", () => {
    const choices = mainlineChoices({ parents: [P1, P2] }, subjectOf)!;
    expect(choices.map((c) => c.mainline)).toEqual([1, 2]);
    expect(choices[0].label).toBe("Parent 1 (aaaaaaaa): main work");
    expect(choices[1].label).toBe("Parent 2 (bbbbbbbb): feature: last commit");
  });

  it("falls back to the short sha when a parent is not loaded", () => {
    const choices = mainlineChoices({ parents: [P1, P2] }, () => null)!;
    expect(choices[0].label).toBe("Parent 1 (aaaaaaaa)");
  });

  it("uses only the first line of a multi-line message and truncates long subjects", () => {
    const long = "x".repeat(80);
    const choices = mainlineChoices(
      { parents: [P1, P2] },
      (id) => (id === P1 ? "subject line\nbody detail" : long),
    )!;
    expect(choices[0].label).toBe("Parent 1 (aaaaaaaa): subject line");
    expect(choices[1].label.length).toBeLessThanOrEqual("Parent 2 (bbbbbbbb): ".length + 51);
    expect(choices[1].label.endsWith("…")).toBe(true);
  });
});
