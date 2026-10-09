import { describe, expect, it } from "vitest";
import { sshProgramWarning } from "./sshProgramWarning";

describe("sshProgramWarning", () => {
  it("is silent when the key is healthy or absent", () => {
    expect(sshProgramWarning(null)).toBeNull();
    // Scopes the global view never reports; must not produce a warning if
    // they ever appear.
    expect(sshProgramWarning("local")).toBeNull();
    expect(sshProgramWarning("unset")).toBeNull();
  });

  it("flags an empty global entry as fixable", () => {
    const w = sshProgramWarning("global");
    expect(w).not.toBeNull();
    expect(w!.fixable).toBe(true);
    expect(w!.text).toMatch(/gpg\.ssh\.program/);
    expect(w!.text).toMatch(/signed commit/i);
  });

  it("flags an empty system entry as not fixable from LeGit", () => {
    const w = sshProgramWarning("system");
    expect(w).not.toBeNull();
    expect(w!.fixable).toBe(false);
    expect(w!.text).toMatch(/system/);
  });
});
