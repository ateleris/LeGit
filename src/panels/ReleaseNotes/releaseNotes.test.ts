import { describe, expect, it } from "vitest";
import { formatReleaseNotes, latestTagName } from "./releaseNotes";

describe("formatReleaseNotes", () => {
  it("renders one bare subject line per commit, in the given order", () => {
    const text = formatReleaseNotes([
      { message: "Fix crash when stash list is empty" },
      { message: "Add branch tree view" },
    ]);
    expect(text).toBe("Fix crash when stash list is empty\nAdd branch tree view");
  });

  it("uses only the first line of a multiline message", () => {
    const text = formatReleaseNotes([{ message: "Subject line\n\nBody paragraph." }]);
    expect(text).toBe("Subject line");
  });

  it("is empty for no commits", () => {
    expect(formatReleaseNotes([])).toBe("");
  });
});

describe("latestTagName", () => {
  it("picks the tag with the newest created_at", () => {
    expect(
      latestTagName([
        { name: "v1.0.0", created_at: 100 },
        { name: "v1.1.0", created_at: 300 },
        { name: "v1.0.1", created_at: 200 },
      ]),
    ).toBe("v1.1.0");
  });

  it("is null when there are no tags", () => {
    expect(latestTagName([])).toBeNull();
  });
});
