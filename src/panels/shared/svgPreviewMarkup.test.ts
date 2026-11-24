import { describe, expect, it } from "vitest";
import { decodeBase64Utf8, svgLacksIntrinsicSize, svgUsesInheritedColor } from "./svgPreviewMarkup";

describe("svgLacksIntrinsicSize", () => {
  it("is true without absolute width and height on the root", () => {
    expect(svgLacksIntrinsicSize('<svg viewBox="0 0 24 24"/>')).toBe(true);
    expect(svgLacksIntrinsicSize('<svg width="24" viewBox="0 0 24 24"/>')).toBe(true);
    expect(svgLacksIntrinsicSize('<svg width="100%" height="100%"/>')).toBe(true);
    expect(svgLacksIntrinsicSize('<?xml version="1.0"?>\n<!-- c -->\n<SVG viewBox="0 0 1 1"/>')).toBe(true);
  });

  it("is false with absolute root dimensions, whatever children declare", () => {
    expect(svgLacksIntrinsicSize('<svg width="24" height="24"/>')).toBe(false);
    expect(svgLacksIntrinsicSize("<svg width='2.5em' height='10px'><rect/></svg>")).toBe(false);
    expect(svgLacksIntrinsicSize('<svg viewBox="0 0 1 1"><rect width="1" height="1"/></svg>')).toBe(true);
    expect(svgLacksIntrinsicSize('<svg stroke-width="2" viewBox="0 0 1 1"/>')).toBe(true);
    expect(svgLacksIntrinsicSize("not svg")).toBe(false);
  });
});

describe("svgUsesInheritedColor", () => {
  it("is true only when currentColor paint has no colour set on the root", () => {
    expect(svgUsesInheritedColor('<svg viewBox="0 0 1 1"><path stroke="currentColor"/></svg>')).toBe(true);
    expect(svgUsesInheritedColor('<svg><path fill="CURRENTCOLOR"/></svg>')).toBe(true);
    expect(svgUsesInheritedColor('<svg viewBox="0 0 1 1"><path stroke="red"/></svg>')).toBe(false);
    expect(svgUsesInheritedColor('<svg color="red"><path stroke="currentColor"/></svg>')).toBe(false);
    expect(svgUsesInheritedColor("currentColor but not svg")).toBe(false);
  });
});

describe("decodeBase64Utf8", () => {
  it("decodes non-ASCII markup", () => {
    const markup = "<svg><title>Zahnrad größer</title></svg>";
    const bytes = new TextEncoder().encode(markup);
    expect(decodeBase64Utf8(btoa(String.fromCharCode(...bytes)))).toBe(markup);
  });
});
