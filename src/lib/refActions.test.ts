// Pins the single implementation of branch/tag/stash actions: every panel
// gets the same feedback. The Branches panel's checkout used to show plain
// text where the Commits panel offered the clickable "open that worktree"
// toast.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { AppError, RepoSummary } from "./types";

const notifyError = vi.fn();
const notifyInfo = vi.fn();
const notifySuccess = vi.fn();
vi.mock("../store/notifications", () => ({
  notify: {
    error: (...a: unknown[]) => notifyError(...a),
    info: (...a: unknown[]) => notifyInfo(...a),
    success: (...a: unknown[]) => notifySuccess(...a),
  },
}));

const openRepo = vi.fn(() => Promise.resolve());
vi.mock("../store/repos", () => ({
  useRepoStore: { getState: () => ({ openRepo }) },
}));

vi.mock("./submodules", () => ({ autoUpdateSubmodules: () => Promise.resolve() }));

const cmd = vi.hoisted(() => ({
  repoSwitchBranch: vi.fn(),
  repoCheckoutRemoteBranch: vi.fn(),
  repoStashBranch: vi.fn(),
  repoApplyStash: vi.fn(),
  repoPopStash: vi.fn(),
  repoDeleteRemoteBranch: vi.fn(),
  repoCreateBranch: vi.fn(),
}));
// Rewritten wrappers live on `api`; `repoCreateBranch` stays a named export.
vi.mock("./commands", () => ({ ...cmd, api: cmd }));

import {
  applyStash,
  checkoutBranch,
  checkoutRemoteBranch,
  createBranch,
  deleteRemoteBranch,
  popStash,
  stashBranch,
} from "./refActions";

const repo = { id: "r1", path: "/repo", locator: "/repo" } as RepoSummary;
const worktreeError: AppError = {
  kind: "Git",
  details: {
    kind: "CheckedOutInWorktree",
    details: { branch: "feature", path: "/wt", stderr: "fatal: in use" },
  },
};

let ctx: { queryClient: QueryClient; repo: RepoSummary; remoteNames: string[] };

beforeEach(() => {
  vi.clearAllMocks();
  ctx = { queryClient: new QueryClient(), repo, remoteNames: ["origin"] };
});

describe("checked-out-in-another-worktree refusals", () => {
  const cases: [string, () => Promise<boolean>, keyof typeof cmd][] = [
    ["branch checkout", () => checkoutBranch(ctx, "feature"), "repoSwitchBranch"],
    ["remote checkout", () => checkoutRemoteBranch(ctx, "origin/feature"), "repoCheckoutRemoteBranch"],
    ["branch from stash", () => stashBranch(ctx, "abc123", "feature"), "repoStashBranch"],
  ];
  for (const [name, run, command] of cases) {
    it(`${name} offers the clickable open-worktree toast`, async () => {
      cmd[command].mockRejectedValueOnce(worktreeError);

      expect(await run()).toBe(false);

      expect(notifyError).toHaveBeenCalledTimes(1);
      const [message, opts] = notifyError.mock.calls[0] as [string, { action?: () => void }];
      expect(message).toContain("Click here to open it.");
      opts.action!();
      expect(openRepo).toHaveBeenCalledWith("/wt");
    });
  }
});

describe("results", () => {
  it("resolves true and never throws on success", async () => {
    cmd.repoSwitchBranch.mockResolvedValueOnce({ outcome: { kind: "switched" }, lfs_stubs: null });
    expect(await checkoutBranch(ctx, "main")).toBe(true);
  });

  it("creating with checkout switches to the new branch", async () => {
    cmd.repoCreateBranch.mockResolvedValueOnce(undefined);
    cmd.repoSwitchBranch.mockResolvedValueOnce({ outcome: { kind: "switched" }, lfs_stubs: null });
    expect(await createBranch(ctx, "topic", undefined, { checkout: true })).toBe(true);
    expect(cmd.repoSwitchBranch).toHaveBeenCalledWith("r1", "topic");
  });

  it("deleting a remote branch splits the ref by the known remotes", async () => {
    cmd.repoDeleteRemoteBranch.mockResolvedValueOnce(undefined);
    expect(await deleteRemoteBranch(ctx, "origin/fix/a")).toBe(true);
    expect(cmd.repoDeleteRemoteBranch.mock.calls[0].slice(0, 3)).toEqual(["r1", "origin", "fix/a"]);
  });
});

describe("stash conflicts are an outcome, reported the same everywhere", () => {
  it("apply names the stash and says to resolve", async () => {
    cmd.repoApplyStash.mockResolvedValueOnce({ kind: "conflicts", message: "CONFLICT (content)" });
    expect(await applyStash(ctx, "abc", "stash@{1}")).toBe(true);
    expect(notifyInfo.mock.calls[0][0]).toMatch(/^Applying stash@\{1\} produced conflicts/);
  });

  it("pop says the stash was kept", async () => {
    cmd.repoPopStash.mockResolvedValueOnce({ kind: "conflicts", message: "CONFLICT (content)" });
    expect(await popStash(ctx, "abc")).toBe(true);
    expect(notifyInfo.mock.calls[0][0]).toContain("the stash was kept");
  });
});
