import { describe, expect, it } from "vitest";
import {
  editorActionLabel,
  editorFileActionLabel,
  editorOpensFolder,
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

  it("falls back to the folder wording when nothing is configured", () => {
    expect(editorActionLabel("")).toBe("Open folder (no editor configured)");
    expect(editorActionLabel(null)).toBe("Open folder (no editor configured)");
  });
});

describe("editorFileActionLabel", () => {
  it("names the configured program, like the repo action", () => {
    expect(editorFileActionLabel("code $FILE")).toBe("Open in code");
  });

  it("says what the fallback actually does with a FILE: reveal, not open a folder", () => {
    // The file-row action's no-editor fallback selects the file in the OS
    // file manager (repo_open_file_in_editor), so the label must not promise
    // an editor - and must not borrow the repo action's "Open folder" either.
    expect(editorFileActionLabel("")).toBe("Reveal in file manager (no editor configured)");
    expect(editorFileActionLabel(null)).toBe(
      "Reveal in file manager (no editor configured)",
    );
    expect(editorFileActionLabel(undefined)).toBe(
      "Reveal in file manager (no editor configured)",
    );
  });
});

describe("editorOpensFolder", () => {
  it("is true exactly when no program is configured (the folder fallback)", () => {
    expect(editorOpensFolder("")).toBe(true);
    expect(editorOpensFolder("   ")).toBe(true);
    expect(editorOpensFolder(null)).toBe(true);
    expect(editorOpensFolder(undefined)).toBe(true);
    expect(editorOpensFolder("code $REPO")).toBe(false);
  });

  it("agrees with the label's folder wording for the same template", () => {
    for (const template of ["", "  ", "code $REPO", '"C:\\my editor.exe" $REPO']) {
      expect(editorOpensFolder(template)).toBe(
        editorActionLabel(template).startsWith("Open folder"),
      );
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
