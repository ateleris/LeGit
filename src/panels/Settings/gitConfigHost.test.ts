import { describe, expect, it } from "vitest";
import {
  GIT_CONFIG_COMMANDS,
  localGitConfigScope,
  wslGitConfigScope,
} from "./gitConfigHost";

const { local, wsl } = GIT_CONFIG_COMMANDS;

describe("git-config command tables", () => {
  it("cover exactly the same operations", () => {
    expect(Object.keys(wsl).sort()).toEqual(Object.keys(local).sort());
  });

  // The isolation guarantee, at the seam where a copy-paste error would land:
  // no WSL form may invoke a `global_*` command (which writes the app
  // machine's ~/.gitconfig), and no local form a `wsl_*` one.
  it("never reach the other host's commands", () => {
    expect(Object.values(local).every((c) => c.startsWith("global_") || c.startsWith("list_"))).toBe(
      true
    );
    expect(Object.values(wsl).every((c) => c.startsWith("wsl_"))).toBe(true);
    const overlap = Object.values(local).filter((c) => (Object.values(wsl) as string[]).includes(c));
    expect(overlap).toEqual([]);
  });
});

describe("scopes", () => {
  it("keep distinct ids — shared ones would merge radio groups and section state", () => {
    expect(localGitConfigScope.id).toBe("global");
    expect(wslGitConfigScope("Ubuntu").id).toBe("wsl-Ubuntu");
    expect(wslGitConfigScope("Ubuntu").id).not.toBe(localGitConfigScope.id);
    expect(wslGitConfigScope("Ubuntu").id).not.toBe(wslGitConfigScope("Debian").id);
  });

  // Both affordances reach the APP MACHINE: `~/.ssh` key tools and the Tauri
  // file dialog. Offered for a distro they would hand a Linux git a C:\ path.
  it("offer app-machine affordances only locally", () => {
    expect(localGitConfigScope.showSshKeys).toBe(true);
    expect(localGitConfigScope.showBrowse).toBe(true);
    expect(wslGitConfigScope("Ubuntu").showSshKeys).toBe(false);
    expect(wslGitConfigScope("Ubuntu").showBrowse).toBe(false);
  });

  it("carries the host ref, null for the app machine", () => {
    expect(localGitConfigScope.host).toBeNull();
    expect(wslGitConfigScope("Ubuntu").host).toEqual({ kind: "wsl", distro: "Ubuntu" });
  });

  // The distro's config file is whatever its login shell resolves (git uses
  // $XDG_CONFIG_HOME/git/config when set), so the label must not claim a path.
  it("does not promise ~/.gitconfig for a distro", () => {
    expect(localGitConfigScope.configFileLabel).toBe("~/.gitconfig");
    expect(wslGitConfigScope("Ubuntu").configFileLabel).not.toContain("~/.gitconfig");
    expect(wslGitConfigScope("Ubuntu").configFileLabel).toContain("Ubuntu");
  });
});
