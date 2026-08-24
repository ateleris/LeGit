import { describe, expect, test } from "vitest";
import { releaseNotesFromBody } from "./releaseNotes";

// Shape assembled by release.yml: the tag's CHANGELOG.md section, a "---"
// horizontal rule, then the static download/signing footer.
const RELEASE_BODY = `### Added

- Multi-commit selection in the Commits panel.

### Fixed

- Crash when closing the last repo.

---

Desktop Git GUI - download the installer for your OS below.

Builds are **not code-signed**: your OS may warn on first launch.
`;

describe("releaseNotesFromBody", () => {
  test("returns the changelog section without the static footer", () => {
    const notes = releaseNotesFromBody(RELEASE_BODY);
    expect(notes).toContain("Multi-commit selection");
    expect(notes).toContain("Crash when closing the last repo.");
    expect(notes).not.toContain("not code-signed");
    expect(notes).not.toContain("---");
  });

  test("handles CRLF line endings", () => {
    const notes = releaseNotesFromBody(RELEASE_BODY.replace(/\n/g, "\r\n"));
    expect(notes).toContain("Multi-commit selection");
    expect(notes).not.toContain("not code-signed");
  });

  test("a body without a separator is returned whole (hand-written notes)", () => {
    expect(releaseNotesFromBody("Just some notes.\nSecond line.")).toBe(
      "Just some notes.\nSecond line.",
    );
  });

  test("returns null for missing or effectively empty bodies", () => {
    expect(releaseNotesFromBody(undefined)).toBeNull();
    expect(releaseNotesFromBody("")).toBeNull();
    expect(releaseNotesFromBody("   \n\n  ")).toBeNull();
    // Separator with nothing before it: no notes to show.
    expect(releaseNotesFromBody("---\n\nfooter only")).toBeNull();
  });
});
