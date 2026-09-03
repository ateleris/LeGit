import { describe, expect, it } from "vitest";
import { lfsDownloadErrorMessage, lfsStubWarning } from "./lfsFeedback";

const lfsError = (files: string[], missing: boolean) => ({
  kind: "Git",
  details: {
    kind: "LfsDownloadFailed",
    details: { files, missing_on_remote: missing, stderr: "raw lfs noise" },
  },
});

describe("lfsDownloadErrorMessage", () => {
  it("is null for non-LFS errors", () => {
    expect(lfsDownloadErrorMessage(new Error("x"), "pull")).toBeNull();
    expect(
      lfsDownloadErrorMessage({ kind: "Git", details: { kind: "AuthFailed", details: "x" } }, "pull"),
    ).toBeNull();
  });

  it("explains missing uploads and the aborted pull", () => {
    const m = lfsDownloadErrorMessage(lfsError(["big.bin"], true), "pull")!;
    expect(m).toContain("big.bin");
    expect(m).toContain("git lfs push");
    expect(m.toLowerCase()).toContain("pull was aborted");
    expect(m.toLowerCase()).toContain("unchanged");
  });

  it("tells a switch user they are still on the previous branch", () => {
    const m = lfsDownloadErrorMessage(lfsError(["feat.bin"], true), "switch")!;
    expect(m.toLowerCase()).toContain("previous branch");
  });

  it("tells a clone user the repo exists on disk but was not opened", () => {
    const m = lfsDownloadErrorMessage(lfsError(["big.bin"], true), "clone")!;
    expect(m.toLowerCase()).toContain("clone");
    expect(m.toLowerCase()).toContain("not opened");
  });

  it("does not blame the pusher for network/auth download failures", () => {
    const m = lfsDownloadErrorMessage(lfsError(["big.bin"], false), "pull")!;
    expect(m).not.toContain("git lfs push");
    expect(m.toLowerCase()).toContain("download");
  });

  it("caps long file lists", () => {
    const m = lfsDownloadErrorMessage(lfsError(["a", "b", "c", "d", "e"], true), "pull")!;
    expect(m).toContain("a");
    expect(m).toContain("+2 more");
    expect(m).not.toContain("e,");
  });
});

describe("lfsStubWarning", () => {
  it("is null when the operation left no stubs", () => {
    expect(lfsStubWarning(null, "pull")).toBeNull();
    expect(lfsStubWarning(undefined, "pull")).toBeNull();
  });

  it("says the operation completed but stubs remain, and why", () => {
    const m = lfsStubWarning({ files: ["big.bin"], missing_on_remote: true }, "pull")!;
    expect(m.toLowerCase()).toContain("pull completed");
    expect(m.toLowerCase()).toContain("pointer stub");
    expect(m).toContain("big.bin");
    expect(m).toContain("git lfs push");
  });

  it("names the operation it describes", () => {
    const m = lfsStubWarning({ files: ["f.bin"], missing_on_remote: false }, "switch")!;
    expect(m.toLowerCase()).toContain("switch completed");
  });
});
