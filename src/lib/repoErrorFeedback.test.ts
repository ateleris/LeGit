import { describe, expect, it } from "vitest";
import { formatRepoError } from "./repoErrorFeedback";

const appLevel = { kind: "GitUnavailable", details: "not found: git" };
const gitLevel = { kind: "Git", details: { kind: "GitUnavailable", details: "not found: git" } };

describe("formatRepoError", () => {
  it("explains a missing app-machine git for a local target", () => {
    const msg = formatRepoError(appLevel, "C:\\code\\legit");
    expect(msg).toMatch(/not installed on this machine/i);
    expect(msg).toMatch(/Settings/);
    expect(msg).not.toMatch(/GitUnavailable/);
  });

  it("explains it for the nested GitError form too", () => {
    expect(formatRepoError(gitLevel, "/home/u/repo")).toMatch(/not installed on this machine/i);
  });

  it("leaves a remote target's failure alone - that git lives in the distro", () => {
    const msg = formatRepoError(appLevel, "wsl://Ubuntu/home/u/repo");
    expect(msg).not.toMatch(/not installed on this machine/i);
    expect(msg).toContain("not found: git");
  });

  it("passes every other error through unchanged", () => {
    const e = { kind: "NotARepo", details: "not a git repository" };
    expect(formatRepoError(e, "C:\\code\\x")).toBe("NotARepo: not a git repository");
  });
});
