import { describe, expect, it } from "vitest";
import {
  editorActionLabel,
  editorConfigured,
  effectiveEditorTemplate,
  templateProgram,
} from "./editorAction";

describe("templateProgram", () => {
  it("takes the first word of a plain command", () => {
    expect(templateProgram("code $REPO")).toBe("code");
  });

  it("takes the whole first double-quoted string so paths with spaces stay intact", () => {
    expect(templateProgram('"C:\\Program Files\\Editor\\ed.exe" $REPO')).toBe(
      "C:\\Program Files\\Editor\\ed.exe",
    );
  });

  it("is empty for a blank or whitespace-only template", () => {
    expect(templateProgram("")).toBe("");
    expect(templateProgram("   ")).toBe("");
  });
});

describe("editorActionLabel", () => {
  it("names the configured program", () => {
    expect(editorActionLabel("code $REPO")).toBe("Open in code");
  });

  it("is empty when nothing is configured - the repo-level button is hidden", () => {
    expect(editorActionLabel("")).toBe("");
    expect(editorActionLabel(null)).toBe("");
  });
});

describe("editorConfigured", () => {
  it("is true exactly when a program is configured", () => {
    expect(editorConfigured("")).toBe(false);
    expect(editorConfigured("   ")).toBe(false);
    expect(editorConfigured(null)).toBe(false);
    expect(editorConfigured(undefined)).toBe(false);
    expect(editorConfigured("code $REPO")).toBe(true);
  });

  it("agrees with the label being non-empty for the same template", () => {
    for (const template of ["", "  ", "code $REPO", '"C:\\my editor.exe" $REPO']) {
      expect(editorConfigured(template)).toBe(editorActionLabel(template) !== "");
    }
  });
});

describe("effectiveEditorTemplate", () => {
  it("prefers a non-blank repo override, else the global template", () => {
    expect(effectiveEditorTemplate("subl $REPO", "code $REPO")).toBe("subl $REPO");
    expect(effectiveEditorTemplate("", "code $REPO")).toBe("code $REPO");
    expect(effectiveEditorTemplate(null, "code $REPO")).toBe("code $REPO");
    expect(effectiveEditorTemplate(null, null)).toBe("");
  });
});
