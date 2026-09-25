// The manifests drive the settings shell's nav and search; these tests pin
// their structural invariants (stable ids, lowercase keywords, no empty
// groups) that the shell and the filter rely on.
import { describe, it, expect } from "vitest";
import { buildGlobalSettingsGroups } from "./globalSettingsManifest";
import { REPO_SETTINGS_GROUPS } from "./repoSettingsManifest";
import type { SearchableGroup, SearchableSection } from "./settingsSearch";

type ManifestGroup = SearchableGroup<SearchableSection & { render: unknown }>;

function checkIntegrity(groups: readonly ManifestGroup[]) {
  const groupIds = groups.map((g) => g.id);
  expect(new Set(groupIds).size).toBe(groupIds.length);

  const sectionIds = groups.flatMap((g) => g.sections.map((s) => s.id));
  expect(new Set(sectionIds).size).toBe(sectionIds.length);

  for (const group of groups) {
    expect(group.title).not.toBe("");
    expect(group.sections.length).toBeGreaterThan(0);
    for (const section of group.sections) {
      expect(section.title).not.toBe("");
      expect(typeof section.render).toBe("function");
      for (const keyword of section.keywords ?? []) {
        expect(keyword).toBe(keyword.toLowerCase());
      }
    }
  }
}

describe("global settings manifest", () => {
  it("holds unique ids, non-empty groups, and lowercase keywords", () => {
    checkIntegrity(buildGlobalSettingsGroups(true));
  });

  it("lists the redesigned taxonomy in order", () => {
    expect(buildGlobalSettingsGroups(false).map((g) => g.id)).toEqual([
      "appearance",
      "branches",
      "remotes-sync",
      "submodules",
      "working-tree",
      "application",
      "git",
      "about",
    ]);
  });

  it("includes the WSL group only when distributions exist", () => {
    expect(buildGlobalSettingsGroups(true).map((g) => g.id)).toContain("git-wsl");
    expect(buildGlobalSettingsGroups(false).map((g) => g.id)).not.toContain("git-wsl");
  });
});

describe("repo settings manifest", () => {
  it("holds unique ids, non-empty groups, and lowercase keywords", () => {
    checkIntegrity(REPO_SETTINGS_GROUPS);
  });

  it("mirrors the global taxonomy with repo-prefixed group ids", () => {
    expect(REPO_SETTINGS_GROUPS.map((g) => g.id)).toEqual([
      "repo-appearance",
      "repo-remotes-sync",
      "repo-submodules",
      "repo-working-tree",
      "repo-application",
      "repo-git",
    ]);
  });
});
