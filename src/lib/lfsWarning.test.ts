import { describe, expect, it } from "vitest";
import { lfsWarningKind, lfsWarningMessage, shouldShowLfsWarning } from "./lfsWarning";
import type { LfsStatus } from "./types";

const status = (over: Partial<LfsStatus>): LfsStatus => ({
  uses_lfs: true,
  installed: true,
  version: "git-lfs/3.4.1",
  initialized: true,
  ...over,
});

describe("lfsWarningKind", () => {
  it("is null while the query has no data yet", () => {
    expect(lfsWarningKind(undefined)).toBeNull();
  });
  it("is null for repos that do not use LFS, whatever the probes say", () => {
    expect(
      lfsWarningKind(status({ uses_lfs: false, installed: false, initialized: false })),
    ).toBeNull();
  });
  it("reports a missing binary (even when config is also unset)", () => {
    expect(
      lfsWarningKind(status({ installed: false, version: null, initialized: false })),
    ).toBe("not-installed");
  });
  it("reports installed-but-not-initialized", () => {
    expect(lfsWarningKind(status({ initialized: false }))).toBe("not-initialized");
  });
  it("is null when everything is available", () => {
    expect(lfsWarningKind(status({}))).toBeNull();
  });
});

describe("shouldShowLfsWarning", () => {
  const broken = status({ installed: false, version: null });
  it("shows for a broken setup with no dismissals", () => {
    expect(shouldShowLfsWarning(broken, false, null)).toBe(true);
  });
  it("shows when the setting is undefined (settings not loaded yet counts as warn)", () => {
    expect(shouldShowLfsWarning(broken, false, undefined)).toBe(true);
  });
  it("session dismissal wins", () => {
    expect(shouldShowLfsWarning(broken, true, null)).toBe(false);
  });
  it("per-repo opt-out wins", () => {
    expect(shouldShowLfsWarning(broken, false, true)).toBe(false);
  });
  it("an explicit false setting still warns (re-armed)", () => {
    expect(shouldShowLfsWarning(broken, false, false)).toBe(true);
  });
  it("never shows for a healthy repo", () => {
    expect(shouldShowLfsWarning(status({}), false, null)).toBe(false);
  });
});

describe("lfsWarningMessage", () => {
  it("has distinct non-empty messages per kind", () => {
    const a = lfsWarningMessage("not-installed");
    const b = lfsWarningMessage("not-initialized");
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
    expect(a).not.toBe(b);
  });
});
