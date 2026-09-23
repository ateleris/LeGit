import { describe, expect, it } from "vitest";
import { dotHoverTitle, subjectHoverTitle } from "./hoverTitles";

describe("subjectHoverTitle", () => {
  it("shows the full message when the subject is visually clipped", () => {
    expect(subjectHoverTitle("A long subject line", true)).toBe("A long subject line");
  });

  it("shows the full message when a body is hidden behind the subject", () => {
    const message = "Subject\n\nBody paragraph.";
    expect(subjectHoverTitle(message, false)).toBe(message);
  });

  it("shows nothing when the subject fits and there is no body", () => {
    expect(subjectHoverTitle("Fits fine", false)).toBe("");
  });

  it("trims trailing newlines so the tooltip has no blank tail", () => {
    expect(subjectHoverTitle("Subject\n\nBody\n\n", true)).toBe("Subject\n\nBody");
  });

  it("treats whitespace-only continuation as subject-only", () => {
    expect(subjectHoverTitle("Subject\n\n   \n", false)).toBe("");
  });
});

describe("dotHoverTitle", () => {
  it("formats name and email in the conventional git signature form", () => {
    expect(dotHoverTitle("Simon Beck", "simon@example.com")).toBe(
      "Simon Beck <simon@example.com>",
    );
  });

  it("falls back to the name alone when the email is empty", () => {
    expect(dotHoverTitle("Simon Beck", "")).toBe("Simon Beck");
    expect(dotHoverTitle("Simon Beck", "   ")).toBe("Simon Beck");
  });

  it("falls back to the email alone when the name is empty", () => {
    expect(dotHoverTitle("", "simon@example.com")).toBe("<simon@example.com>");
  });

  it("is empty when neither is present (no tooltip)", () => {
    expect(dotHoverTitle("", "")).toBe("");
  });
});
