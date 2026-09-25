// Pins: a repo-setting write sends ONLY the changed field. Sending the whole
// cached struct wrote a stale `laneLocks` / `git_profile_id` back and wiped a
// lane lock made since the cache was filled.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RepoSettings } from "../lib/types";

const patchRepoSettings = vi.fn(
  (_repoId: string, patch: Record<string, unknown>): Promise<RepoSettings> =>
    Promise.resolve({ ...fresh, ...patch } as RepoSettings),
);
const getRepoSettings = vi.fn((_repoId: string) => Promise.resolve(fresh));
vi.mock("../lib/commands", () => ({
  api: {
    patchRepoSettings: (id: string, p: Record<string, unknown>) => patchRepoSettings(id, p),
    getRepoSettings: (id: string) => getRepoSettings(id),
  },
}));

import { useRepoStore } from "./repos";

const lock = { refName: "refs/heads/main", laneIndex: 2 };
const fresh: RepoSettings = {
  laneLocks: { format: "legit-lane-locks", formatVersion: 1, locks: [lock] },
  git_path_override: null,
  line_ending_chips_in_changes: null,
  warn_on_line_ending_commit: null,
  git_profile_id: "work",
  show_remote_branches: true,
};
const stale: RepoSettings = {
  laneLocks: { format: "legit-lane-locks", formatVersion: 1, locks: [] },
  git_path_override: null,
  line_ending_chips_in_changes: null,
  warn_on_line_ending_commit: null,
  git_profile_id: null,
  show_remote_branches: true,
};

describe("updateRepoSetting", () => {
  beforeEach(() => {
    patchRepoSettings.mockClear();
    getRepoSettings.mockClear();
    useRepoStore.setState({ repoSettings: { r1: stale } });
  });

  it("sends only the changed field, never the cached lane locks or profile", async () => {
    await useRepoStore.getState().updateRepoSetting("r1", "show_remote_branches", false);

    expect(patchRepoSettings).toHaveBeenCalledTimes(1);
    expect(patchRepoSettings.mock.calls[0]).toEqual(["r1", { show_remote_branches: false }]);
  });

  it("caches the merged settings the backend returns", async () => {
    await useRepoStore.getState().updateRepoSetting("r1", "show_remote_branches", false);

    const cached = useRepoStore.getState().repoSettings.r1;
    expect(cached?.show_remote_branches).toBe(false);
    expect(cached?.laneLocks?.locks).toEqual([lock]);
    expect(cached?.git_profile_id).toBe("work");
  });

  it("works on a cold cache without fetching first", async () => {
    useRepoStore.setState({ repoSettings: {} });

    await useRepoStore.getState().updateRepoSetting("r1", "auto_push_tags", true);

    expect(getRepoSettings).not.toHaveBeenCalled();
    expect(patchRepoSettings.mock.calls[0]).toEqual(["r1", { auto_push_tags: true }]);
  });
});
