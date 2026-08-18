import { describe, expect, it } from "vitest";
import { binarySizes, hasImageSide, sideNotice } from "./previewSurface";
import type { FilePreview } from "./types";

const img: FilePreview = { kind: "image", format: "png", size: 10, base64: "aa" };
const big: FilePreview = { kind: "too_large", size: 30 * 1024 * 1024 };
const bin: FilePreview = { kind: "not_previewable", size: 2048 };
const lfs: FilePreview = { kind: "lfs_missing", oid: "a".repeat(64), size: 4096 };

describe("previewSurface", () => {
  it("shows the image surface when at least one side is an image", () => {
    expect(hasImageSide(img, undefined)).toBe(true);
    expect(hasImageSide(undefined, img)).toBe(true);
    expect(hasImageSide(bin, img)).toBe(true);
    expect(hasImageSide(bin, big)).toBe(false);
    expect(hasImageSide(undefined, undefined)).toBe(false);
  });

  it("describes non-image sides", () => {
    expect(sideNotice(undefined)).toBe("(no file)");
    expect(sideNotice({ kind: "absent" })).toBe("(no file)");
    expect(sideNotice(big)).toContain("30.0 MiB");
    expect(sideNotice(big)).toContain("cap 20 MiB");
    expect(sideNotice(bin)).toContain("binary");
    expect(sideNotice(bin)).toContain("2.0 KiB");
    expect(sideNotice(lfs)).toContain("git lfs pull");
    expect(sideNotice(lfs)).toContain("aaaaaaaaaaaa");
  });

  it("summarizes sizes for the no-preview fallback", () => {
    expect(binarySizes(bin, big)).toContain("2.0 KiB");
    expect(binarySizes(bin, big)).toContain("→");
    expect(binarySizes(bin, big)).toContain("30.0 MiB");
    expect(binarySizes({ kind: "absent" }, bin)).toMatch(/^added, /);
    expect(binarySizes(bin, { kind: "absent" })).toMatch(/, removed$/);
    expect(binarySizes(undefined, undefined)).toBeNull();
    // An image side still reports its size in the fallback summary.
    expect(binarySizes(img, undefined)).toContain("10 bytes");
  });
});
