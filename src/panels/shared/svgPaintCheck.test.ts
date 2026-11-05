// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { hasVisiblePixels, svgPaintedNothing } from "./svgPaintCheck";

function rgba(pixels: number[][]): Uint8ClampedArray {
  return new Uint8ClampedArray(pixels.flat());
}

describe("hasVisiblePixels", () => {
  it("is false for an empty buffer", () => {
    expect(hasVisiblePixels(new Uint8ClampedArray(0))).toBe(false);
  });

  it("is false when every pixel is fully transparent", () => {
    expect(
      hasVisiblePixels(
        rgba([
          [0, 0, 0, 0],
          [255, 255, 255, 0],
        ]),
      ),
    ).toBe(false);
  });

  it("is true when any pixel has nonzero alpha", () => {
    expect(
      hasVisiblePixels(
        rgba([
          [0, 0, 0, 0],
          [10, 20, 30, 1],
          [0, 0, 0, 0],
        ]),
      ),
    ).toBe(true);
  });
});

describe("svgPaintedNothing", () => {
  const img = {} as HTMLImageElement;

  function stubCanvas(ctx: unknown) {
    const original = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      if (tag === "canvas") return { width: 0, height: 0, getContext: () => ctx } as never;
      return original(tag);
    });
  }

  afterEach(() => vi.restoreAllMocks());

  it("is true when the drawn image has only transparent pixels", () => {
    stubCanvas({
      drawImage: () => {},
      getImageData: () => ({ data: new Uint8ClampedArray(64 * 64 * 4) }),
    });
    expect(svgPaintedNothing(img)).toBe(true);
  });

  it("is false when the drawn image has a visible pixel", () => {
    const data = new Uint8ClampedArray(64 * 64 * 4);
    data[3] = 255;
    stubCanvas({ drawImage: () => {}, getImageData: () => ({ data }) });
    expect(svgPaintedNothing(img)).toBe(false);
  });

  it("is false (inconclusive) when canvas 2d is unavailable", () => {
    stubCanvas(null);
    expect(svgPaintedNothing(img)).toBe(false);
  });

  it("is false (inconclusive) when drawing throws", () => {
    stubCanvas({
      drawImage: () => {
        throw new Error("boom");
      },
      getImageData: () => ({ data: new Uint8ClampedArray(0) }),
    });
    expect(svgPaintedNothing(img)).toBe(false);
  });
});
