/** Downscale target for the paint probe; sampling stays cheap at any image size. */
const SAMPLE = 64;

export function hasVisiblePixels(rgba: Uint8ClampedArray): boolean {
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== 0) return true;
  }
  return false;
}

/**
 * Whether a loaded SVG `<img>` painted nothing. An SVG whose visible content
 * needs scripts or external resources still loads with its declared size -
 * the browser's secure static image mode drops those silently - so blankness
 * is detectable only from the pixels. The data-URL src is same-origin, which
 * keeps the probe canvas readable. Inconclusive environments report false:
 * a missing notice beats a false one.
 */
export function svgPaintedNothing(img: HTMLImageElement): boolean {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = SAMPLE;
    canvas.height = SAMPLE;
    const ctx = canvas.getContext("2d");
    if (!ctx) return false;
    ctx.drawImage(img, 0, 0, SAMPLE, SAMPLE);
    return !hasVisiblePixels(ctx.getImageData(0, 0, SAMPLE, SAMPLE).data);
  } catch {
    return false;
  }
}
