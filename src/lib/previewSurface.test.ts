import { describe, expect, it } from "vitest";
import {
  binarySizes,
  fileViewSurface,
  fileViewWantsPreview,
  hasImageSide,
  sideNotice,
  isSvgPath,
} from "./previewSurface";
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

describe("isSvgPath", () => {
  it("matches the .svg extension case-insensitively", () => {
    expect(isSvgPath("icons/logo.svg")).toBe(true);
    expect(isSvgPath("LOGO.SVG")).toBe(true);
    expect(isSvgPath("logo.svg.bak")).toBe(false);
    expect(isSvgPath("svg")).toBe(false);
  });
});

describe("fileViewSurface", () => {
  const image: FilePreview = { kind: "image", format: "svg", size: 1, base64: "" };
  const base = { binary: false, lfsPointer: false, preview: undefined, previewPending: false };

  it("draws an svg as an image once its preview arrives, never flashing the source", () => {
    expect(fileViewSurface({ ...base, path: "gear.svg", previewPending: true })).toBe("pending");
    expect(fileViewSurface({ ...base, path: "gear.svg", preview: image })).toBe("image");
  });

  it("falls back to the source for an svg that does not preview as an image", () => {
    expect(fileViewSurface({ ...base, path: "x.svg", preview: { kind: "not_previewable", size: 9 } })).toBe("text");
    expect(fileViewSurface({ ...base, path: "x.svg" })).toBe("text");
  });

  it("never waits on a preview for plain text", () => {
    expect(fileViewWantsPreview({ binary: false, lfsPointer: false, path: "a.ts" })).toBe(false);
    expect(fileViewSurface({ ...base, path: "a.ts", previewPending: true })).toBe("text");
  });

  it("keeps the binary and LFS placeholders until an image arrives", () => {
    expect(fileViewSurface({ ...base, binary: true, path: "a.bin", previewPending: true })).toBe("binary");
    expect(fileViewSurface({ ...base, lfsPointer: true, path: "a.psd" })).toBe("lfs");
    expect(fileViewSurface({ ...base, binary: true, path: "a.png", preview: { ...image, format: "png" } })).toBe("image");
  });
});
