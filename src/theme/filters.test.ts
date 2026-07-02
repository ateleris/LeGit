import { describe, expect, it } from "vitest";
import {
  bindingCssValue,
  bindingFilter,
  bindingRef,
  makeBinding,
  parseHexColor,
  resolveBindingColor,
  withRef,
} from "./filters";

describe("binding helpers", () => {
  it("treats a bare string as an unfiltered binding", () => {
    expect(bindingRef("accent")).toBe("accent");
    expect(bindingFilter("accent")).toBeNull();
  });

  it("extracts ref and filter from the object form", () => {
    const b = { ref: "accent", filter: "lighter" as const };
    expect(bindingRef(b)).toBe("accent");
    expect(bindingFilter(b)).toBe("lighter");
  });

  it("makeBinding collapses no-filter to the bare string form", () => {
    expect(makeBinding("accent", null)).toBe("accent");
    expect(makeBinding("accent", "darker")).toEqual({ ref: "accent", filter: "darker" });
  });

  it("withRef rebinds the palette entry, keeping the filter", () => {
    expect(withRef({ ref: "a", filter: "faded" }, "b")).toEqual({ ref: "b", filter: "faded" });
    expect(withRef("a", "b")).toBe("b");
  });
});

describe("bindingCssValue", () => {
  const V = "var(--palette-accent)";

  it("passes the var through unfiltered", () => {
    expect(bindingCssValue("accent", V)).toBe(V);
  });

  it("wraps the var in color-mix for filters (live palette edits cascade)", () => {
    expect(bindingCssValue({ ref: "accent", filter: "lighter" }, V)).toBe(
      `color-mix(in srgb, ${V}, white 15%)`,
    );
    expect(bindingCssValue({ ref: "accent", filter: "subtle" }, V)).toBe(
      `color-mix(in srgb, ${V}, transparent 85%)`,
    );
  });
});

describe("resolveBindingColor (JS mirror for swatches/contrast)", () => {
  const palette = { accent: "#4080c0", wash: "#4080c080" };

  it("resolves the unfiltered colour directly", () => {
    expect(resolveBindingColor("accent", palette)).toBe("#4080c0");
  });

  it("lightens toward white by 15%", () => {
    // 0x40=64 -> 64 + (255-64)*0.15 ≈ 93 (0x5d); 0x80=128 -> ~147 (0x93);
    // 0xc0=192 -> ~201 (0xc9)
    expect(resolveBindingColor({ ref: "accent", filter: "lighter" }, palette)).toBe("#5d93c9");
  });

  it("darkens toward black by 15%", () => {
    // 64*0.85≈54 (0x36); 128*0.85≈109 (0x6d); 192*0.85≈163 (0xa3)
    expect(resolveBindingColor({ ref: "accent", filter: "darker" }, palette)).toBe("#366da3");
  });

  it("fades by scaling alpha, preserving rgb", () => {
    // faded keeps 45% alpha: 0.45*255 ≈ 115 (0x73)
    expect(resolveBindingColor({ ref: "accent", filter: "faded" }, palette)).toBe("#4080c073");
    // an already-translucent base multiplies: 0x80/255 * 0.45 * 255 ≈ 58 (0x3a)
    expect(resolveBindingColor({ ref: "wash", filter: "faded" }, palette)).toBe("#4080c03a");
  });

  it("returns undefined for a missing palette entry", () => {
    expect(resolveBindingColor("nope", palette)).toBeUndefined();
  });

  it("falls back to the raw value for non-hex palette colours", () => {
    const p = { fancy: "oklch(0.7 0.1 250)" };
    expect(resolveBindingColor({ ref: "fancy", filter: "lighter" }, p)).toBe(
      "oklch(0.7 0.1 250)",
    );
  });
});

describe("parseHexColor", () => {
  it("parses short and long forms with and without alpha", () => {
    expect(parseHexColor("#48c")).toEqual({ r: 0x44, g: 0x88, b: 0xcc, a: 1 });
    expect(parseHexColor("#4080c0")).toEqual({ r: 64, g: 128, b: 192, a: 1 });
    expect(parseHexColor("#4080c080")?.a).toBeCloseTo(128 / 255);
    expect(parseHexColor("rgb(1,2,3)")).toBeNull();
  });
});
