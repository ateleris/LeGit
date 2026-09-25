import { describe, it, expect } from "vitest";
import { filterSettingsGroups, pickActiveGroup } from "./settingsSearch";

const groups = [
  {
    id: "appearance",
    title: "Appearance",
    caption: "How LeGit looks",
    sections: [
      { id: "general", title: "General", keywords: ["font", "zoom"] },
      { id: "diff-viewer", title: "Diff viewer", keywords: ["syntax"] },
    ],
  },
  {
    id: "working-tree",
    title: "Working tree",
    sections: [
      { id: "line-endings", title: "Line ending changes", keywords: ["autocrlf", "eol"] },
      { id: "case-renames", title: "Case-only renames" },
    ],
  },
  {
    id: "git-wsl",
    title: "Git (WSL)",
    caption: "Integration & configuration",
    sections: [{ id: "wsl-exe", title: "Git executable" }],
  },
];

describe("filterSettingsGroups", () => {
  it("returns all groups unchanged for an empty or whitespace query", () => {
    expect(filterSettingsGroups(groups, "")).toEqual(groups);
    expect(filterSettingsGroups(groups, "   ")).toEqual(groups);
  });

  it("keeps only sections whose title matches, dropping empty groups", () => {
    const result = filterSettingsGroups(groups, "diff");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("appearance");
    expect(result[0].sections.map((s) => s.id)).toEqual(["diff-viewer"]);
  });

  it("matches case-insensitively", () => {
    const result = filterSettingsGroups(groups, "DIFF");
    expect(result.flatMap((g) => g.sections.map((s) => s.id))).toEqual(["diff-viewer"]);
  });

  it("matches on section keywords", () => {
    const result = filterSettingsGroups(groups, "autocrlf");
    expect(result.flatMap((g) => g.sections.map((s) => s.id))).toEqual(["line-endings"]);
  });

  it("keeps a whole group when the group title matches", () => {
    const result = filterSettingsGroups(groups, "appearance");
    expect(result).toHaveLength(1);
    expect(result[0].sections.map((s) => s.id)).toEqual(["general", "diff-viewer"]);
  });

  it("keeps a whole group when the group caption matches", () => {
    const result = filterSettingsGroups(groups, "integration");
    expect(result.map((g) => g.id)).toEqual(["git-wsl"]);
    expect(result[0].sections.map((s) => s.id)).toEqual(["wsl-exe"]);
  });

  it("requires every term to match (terms may hit different fields)", () => {
    // "line" matches the section title, "eol" a keyword.
    expect(
      filterSettingsGroups(groups, "line eol").flatMap((g) => g.sections.map((s) => s.id)),
    ).toEqual(["line-endings"]);
    // A term that matches nothing kills the section even when the other hits.
    expect(filterSettingsGroups(groups, "line zzz")).toEqual([]);
  });

  it("lets a group-level term narrow to a section-level term", () => {
    // "wsl" matches the group title, "executable" the section title.
    const result = filterSettingsGroups(groups, "wsl executable");
    expect(result.map((g) => g.id)).toEqual(["git-wsl"]);
    expect(result[0].sections.map((s) => s.id)).toEqual(["wsl-exe"]);
  });

  it("returns no groups when nothing matches", () => {
    expect(filterSettingsGroups(groups, "no such setting")).toEqual([]);
  });
});

describe("pickActiveGroup", () => {
  const tops = [
    { id: "a", top: 0 },
    { id: "b", top: 200 },
    { id: "c", top: 500 },
  ];

  it("returns null for no groups", () => {
    expect(pickActiveGroup([], 100)).toBeNull();
  });

  it("returns the first group before any header is passed", () => {
    expect(pickActiveGroup(tops, 0)).toBe("a");
    expect(pickActiveGroup(tops, 150)).toBe("a");
  });

  it("returns the last group whose top was reached", () => {
    expect(pickActiveGroup(tops, 200)).toBe("b");
    expect(pickActiveGroup(tops, 499)).toBe("b");
    expect(pickActiveGroup(tops, 500)).toBe("c");
    expect(pickActiveGroup(tops, 9000)).toBe("c");
  });

  it("tolerates unsorted input", () => {
    expect(pickActiveGroup([tops[2], tops[0], tops[1]], 250)).toBe("b");
  });
});
