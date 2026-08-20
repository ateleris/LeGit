// Decision logic for the split commit button: which label the button shows
// and whether (and where) the commit is followed by a push. Pins the four
// backlog rules: contextual Push/Publish label, detached degradation, amend
// never auto-pushes, and the plain-commit default.

import { describe, expect, it } from "vitest";
import {
  commitAndPushMenuLabel,
  commitButtonPlan,
  commitPushFailureMessage,
  commitPushSuccessMessage,
} from "./commitButtonMode";
import type { Branch } from "../../lib/types";

const branch = (over: Partial<Branch> = {}): Branch => ({
  name: "main",
  is_current: true,
  is_remote: false,
  upstream: "refs/remotes/origin/main",
  head: "abc123",
  ahead: null,
  behind: null,
  upstream_gone: false,
  created_at: 0,
  ...over,
});

const plan = (over: Partial<Parameters<typeof commitButtonPlan>[0]> = {}) =>
  commitButtonPlan({
    mode: "commit_and_push",
    amend: false,
    detached: false,
    currentBranch: branch(),
    remotes: ["origin"],
    ...over,
  });

describe("commitButtonPlan", () => {
  it("plain commit mode never pushes", () => {
    expect(plan({ mode: "commit" })).toEqual({ label: "Commit", push: null });
  });

  it("an unset mode (old settings file) defaults to plain commit", () => {
    expect(plan({ mode: null })).toEqual({ label: "Commit", push: null });
    expect(plan({ mode: undefined })).toEqual({ label: "Commit", push: null });
  });

  it("a tracked branch gets Commit & Push to the upstream's remote", () => {
    expect(plan()).toEqual({
      label: "Commit & Push",
      push: { remote: "origin", branch: "main", setUpstream: false },
    });
  });

  it("an untracked branch gets Commit & Publish (push -u)", () => {
    expect(plan({ currentBranch: branch({ upstream: null }) })).toEqual({
      label: "Commit & Publish",
      push: { remote: "origin", branch: "main", setUpstream: true },
    });
  });

  it("a gone upstream re-publishes to the upstream's remote", () => {
    // The remote branch was deleted (e.g. merged-PR cleanup): the push
    // re-creates it, so the label says Publish - even in a multi-remote repo,
    // because the gone upstream still names its remote unambiguously.
    expect(
      plan({
        currentBranch: branch({ upstream_gone: true }),
        remotes: ["origin", "fork"],
      }),
    ).toEqual({
      label: "Commit & Publish",
      push: { remote: "origin", branch: "main", setUpstream: true },
    });
  });

  it("amend never auto-pushes, whatever the mode", () => {
    expect(plan({ amend: true })).toEqual({ label: "Amend", push: null });
  });

  it("detached HEAD degrades to plain Commit", () => {
    expect(plan({ detached: true })).toEqual({ label: "Commit", push: null });
  });

  it("no remotes degrades to plain Commit", () => {
    expect(plan({ currentBranch: branch({ upstream: null }), remotes: [] })).toEqual({
      label: "Commit",
      push: null,
    });
  });

  it("an untracked branch in a multi-remote repo degrades to plain Commit", () => {
    // Publishing needs a deliberate remote choice (it becomes the upstream);
    // a one-click commit button must not pick one silently.
    expect(
      plan({ currentBranch: branch({ upstream: null }), remotes: ["origin", "fork"] }),
    ).toEqual({ label: "Commit", push: null });
  });

  it("no current branch (e.g. data not loaded yet) degrades to plain Commit", () => {
    expect(plan({ currentBranch: null })).toEqual({ label: "Commit", push: null });
  });

  it("handles slashes in branch names via the known-remotes split", () => {
    expect(
      plan({
        currentBranch: branch({
          name: "feat/nested",
          upstream: "refs/remotes/origin/feat/nested",
        }),
      }),
    ).toEqual({
      label: "Commit & Push",
      push: { remote: "origin", branch: "feat/nested", setUpstream: false },
    });
  });
});

describe("commitAndPushMenuLabel", () => {
  it("says Push for a tracked branch", () => {
    expect(commitAndPushMenuLabel(branch(), ["origin"])).toBe("Commit & Push");
  });

  it("says Publish for an untracked branch with one remote", () => {
    expect(commitAndPushMenuLabel(branch({ upstream: null }), ["origin"])).toBe(
      "Commit & Publish",
    );
  });

  it("falls back to the generic Push wording when there is no target", () => {
    expect(commitAndPushMenuLabel(null, ["origin"])).toBe("Commit & Push");
    expect(commitAndPushMenuLabel(branch(), [])).toBe("Commit & Push");
  });
});

describe("push-leg messages", () => {
  it("distinguishes pushed from published", () => {
    expect(
      commitPushSuccessMessage({ remote: "origin", branch: "main", setUpstream: false }),
    ).toBe("Committed and pushed 'main' to origin");
    expect(
      commitPushSuccessMessage({ remote: "origin", branch: "main", setUpstream: true }),
    ).toBe("Committed and published 'main' to origin");
  });

  it("the failure message says the commit itself succeeded", () => {
    const msg = commitPushFailureMessage("Push rejected");
    expect(msg).toContain("commit succeeded");
    expect(msg).toContain("Push rejected");
  });
});
