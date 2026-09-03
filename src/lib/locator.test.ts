import { describe, expect, it } from "vitest";
import { formatWslLocator, hostLabel, parseLocator, supportsRepoGitOverride } from "./locator";

describe("parseLocator", () => {
  it("treats bare paths as local, byte-identical", () => {
    for (const p of ["/home/u/proj", "C:\\repos\\proj", "\\\\server\\share\\proj"]) {
      expect(parseLocator(p)).toEqual({ host: null, path: p });
    }
  });

  it("round-trips wsl locators", () => {
    const s = formatWslLocator("Ubuntu", "/home/orell/github/LeGit");
    expect(s).toBe("wsl://Ubuntu/home/orell/github/LeGit");
    expect(parseLocator(s)).toEqual({
      host: { kind: "wsl", distro: "Ubuntu" },
      path: "/home/orell/github/LeGit",
    });
  });

  it("falls back to local for malformed wsl strings", () => {
    for (const s of ["wsl://", "wsl://Ubuntu", "wsl:///home/x"]) {
      expect(parseLocator(s).host).toBeNull();
    }
  });
});

describe("hostLabel", () => {
  it("labels wsl hosts by distro and local as null", () => {
    expect(hostLabel({ kind: "wsl", distro: "Ubuntu" })).toBe("Ubuntu");
    expect(hostLabel(null)).toBeNull();
    expect(hostLabel(undefined)).toBeNull();
  });
});

describe("supportsRepoGitOverride", () => {
  it("allows a per-repo override for local repos only", () => {
    expect(supportsRepoGitOverride(null)).toBe(true);
    expect(supportsRepoGitOverride(undefined)).toBe(true);
  });

  // The backend rejects it (`set_repo_git_path`), and a Windows file dialog
  // cannot pick a binary inside a distro — so the UI must not offer it.
  it("refuses it for a WSL repo", () => {
    expect(supportsRepoGitOverride({ kind: "wsl", distro: "Ubuntu" })).toBe(false);
  });
});
