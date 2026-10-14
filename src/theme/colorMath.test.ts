import { describe, expect, test } from "vitest";
import {
  isLightHex,
  luminanceHex,
  mixHex,
  opaqueHex,
  rotateHueHex,
  saturateHex,
  withAlphaHex,
  withLightnessHex,
} from "./colorMath";

describe("colorMath", () => {
  test("mixHex interpolates channels (alpha from the first color)", () => {
    expect(mixHex("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mixHex("#000000", "#ffffff", 0)).toBe("#000000");
    expect(mixHex("#000000", "#ffffff", 1)).toBe("#ffffff");
    expect(mixHex("#123456", "#123456", 0.3)).toBe("#123456");
    expect(mixHex("#00000080", "#ffffff", 0.5)).toBe("#80808080");
  });

  test("withAlphaHex sets the alpha channel", () => {
    expect(withAlphaHex("#112233", 0.2)).toBe("#11223333");
    expect(withAlphaHex("#11223344", 1)).toBe("#112233");
  });

  test("opaqueHex drops alpha", () => {
    expect(opaqueHex("#11223344")).toBe("#112233");
    expect(opaqueHex("#112233")).toBe("#112233");
  });

  test("luminance and polarity", () => {
    expect(luminanceHex("#000000")).toBe(0);
    expect(luminanceHex("#ffffff")).toBe(1);
    expect(isLightHex("#f6f6f6")).toBe(true);
    expect(isLightHex("#1e1e1e")).toBe(false);
  });

  test("rotateHueHex walks the color wheel", () => {
    expect(rotateHueHex("#ff0000", 120)).toBe("#00ff00");
    expect(rotateHueHex("#ff0000", 360)).toBe("#ff0000");
    expect(rotateHueHex("#ff0000", -120)).toBe("#0000ff");
  });

  test("withLightnessHex pins HSL lightness and clamps", () => {
    expect(withLightnessHex("#ff0000", 0.9)).toBe("#ffcccc");
    expect(withLightnessHex("#808080", 2)).toBe("#ffffff");
    expect(withLightnessHex("#808080", -1)).toBe("#000000");
  });

  test("saturateHex scales saturation", () => {
    expect(saturateHex("#ff0000", 0)).toBe("#808080");
    expect(saturateHex("#ff0000", 1)).toBe("#ff0000");
  });
});
