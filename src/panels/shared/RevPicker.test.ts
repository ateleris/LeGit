import { describe, expect, it } from "vitest";
import { buildRevOptions } from "./RevPicker";

const LOCALS = ["main", "dev", "feature/picker"];
const REMOTES = ["origin/main", "origin/dev"];
const TAGS = ["v1.0", "v1.1"];

describe("buildRevOptions", () => {
  it("shows everything grouped when the filter is empty", () => {
    const groups = buildRevOptions("", LOCALS, REMOTES, TAGS);
    expect(groups.map((g) => g.label)).toEqual([null, "Branches", "Remote branches", "Tags"]);
    expect(groups[0].items).toEqual(["HEAD"]);
    expect(groups[1].items).toEqual(LOCALS);
  });

  it("filters case-insensitively by substring and drops empty groups", () => {
    const groups = buildRevOptions("MAIN", LOCALS, REMOTES, TAGS);
    expect(groups.map((g) => g.label)).toEqual(["Branches", "Remote branches"]);
    expect(groups[0].items).toEqual(["main"]);
    expect(groups[1].items).toEqual(["origin/main"]);
  });

  it("matches HEAD too", () => {
    const groups = buildRevOptions("hea", LOCALS, REMOTES, TAGS);
    expect(groups).toEqual([{ label: null, items: ["HEAD"] }]);
  });

  it("returns nothing for a rev only the user knows (free text stays valid)", () => {
    expect(buildRevOptions("abc123", LOCALS, REMOTES, TAGS)).toEqual([]);
  });

  it("caps each group", () => {
    const many = Array.from({ length: 200 }, (_, i) => `branch-${i}`);
    const groups = buildRevOptions("branch", many, [], []);
    expect(groups[0].items).toHaveLength(50);
  });
});
