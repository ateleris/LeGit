// Decision logic for the split commit button: which label the button shows
// and whether (and where) the commit is followed by a push. Pins the backlog
// rules: contextual Push/Publish label, detached degradation, amend pushes
// only through the explicit (transient) force-push choice, and the
// plain-commit default.

import { describe, expect, it } from "vitest";
import {
  commitAndPushMenuLabel,
  commitButtonPlan,
  commitContext,
  commitMenuChoices,
  commitPushFailureDetail,
  commitPushFailureMessage,
  commitPushSuccessMessage,
  forcePushRemoteLoss,
  parkedPushLeg,
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
    forcePush: false,
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
      push: { remote: "origin", branch: "main", setUpstream: false, force: false },
    });
  });

  it("an untracked branch gets Commit & Publish (push -u)", () => {
    expect(plan({ currentBranch: branch({ upstream: null }) })).toEqual({
      label: "Commit & Publish",
      push: { remote: "origin", branch: "main", setUpstream: true, force: false },
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
      push: { remote: "origin", branch: "main", setUpstream: true, force: false },
    });
  });

  it("amend never auto-pushes through the persisted mode", () => {
    expect(plan({ amend: true })).toEqual({ label: "Amend", push: null });
  });

  it("amend + force-push choice force-pushes (with lease) to the upstream", () => {
    expect(plan({ mode: "commit", amend: true, forcePush: true })).toEqual({
      label: "Amend & Force Push",
      push: { remote: "origin", branch: "main", setUpstream: false, force: true },
    });
  });

  it("the force-push choice never applies to a plain (non-amend) commit", () => {
    expect(plan({ mode: "commit", forcePush: true })).toEqual({ label: "Commit", push: null });
    expect(plan({ forcePush: true }).push?.force).toBe(false);
  });

  it("amend + force-push on an untracked branch publishes without force", () => {
    expect(
      plan({ amend: true, forcePush: true, currentBranch: branch({ upstream: null }) }),
    ).toEqual({
      label: "Amend & Publish",
      push: { remote: "origin", branch: "main", setUpstream: true, force: false },
    });
  });

  it("amend + force-push degrades to plain Amend without a target or when detached", () => {
    expect(plan({ amend: true, forcePush: true, remotes: [] })).toEqual({
      label: "Amend",
      push: null,
    });
    expect(plan({ amend: true, forcePush: true, detached: true })).toEqual({
      label: "Amend",
      push: null,
    });
  });

  it("amend + force-push on an unpushed tip pushes without force", () => {
    expect(
      plan({ amend: true, forcePush: true, currentBranch: branch({ ahead: 2 }) }),
    ).toEqual({
      label: "Amend & Push",
      push: { remote: "origin", branch: "main", setUpstream: false, force: false },
    });
  });

  it("amend + force-push on a diverged branch still forces", () => {
    const diverged = plan({
      amend: true,
      forcePush: true,
      currentBranch: branch({ ahead: 1, behind: 2 }),
    });
    expect(diverged.label).toBe("Amend & Force Push");
    expect(diverged.push?.force).toBe(true);
  });

  it("amend + force-push degrades to plain Amend when the upstream has another name", () => {
    expect(
      plan({
        amend: true,
        forcePush: true,
        currentBranch: branch({ name: "fix", upstream: "refs/remotes/origin/main" }),
      }),
    ).toEqual({ label: "Amend", push: null });
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
      push: { remote: "origin", branch: "feat/nested", setUpstream: false, force: false },
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

describe("commitMenuChoices", () => {
  it("offers force push only while amending", () => {
    expect(commitMenuChoices(false, true)).toEqual(["commit", "commit_and_push"]);
    expect(commitMenuChoices(true, true)).toEqual([
      "commit",
      "commit_and_push",
      "amend_force_push",
    ]);
  });

  it("hides force push when amending cannot push anywhere", () => {
    expect(commitMenuChoices(true, false)).toEqual(["commit", "commit_and_push"]);
  });
});

describe("forcePushRemoteLoss", () => {
  const forced = (currentBranch: Branch) =>
    forcePushRemoteLoss(plan({ amend: true, forcePush: true, currentBranch }), currentBranch);

  it("counts the upstream commits a force push would remove", () => {
    expect(forced(branch({ behind: 2 }))).toBe(2);
    expect(forced(branch({ ahead: 1, behind: 3 }))).toBe(3);
  });

  it("is zero when the branch is not behind", () => {
    expect(forced(branch())).toBe(0);
  });

  it("is zero when the plan does not force", () => {
    const behind = branch({ behind: 2 });
    expect(forcePushRemoteLoss(plan({ currentBranch: behind }), behind)).toBe(0);
    expect(forcePushRemoteLoss(plan({ amend: true, currentBranch: behind }), behind)).toBe(0);
  });
});

describe("parkedPushLeg", () => {
  const target = (force: boolean) => ({
    remote: "origin",
    branch: "main",
    setUpstream: false,
    force,
  });
  const here = commitContext("repo-a", branch());

  it("keeps the push when repo and branch are unchanged", () => {
    expect(parkedPushLeg({ push: target(true), context: here }, here)).toEqual({
      push: target(true),
      dropped: false,
    });
  });

  it("drops a force push parked on another branch", () => {
    const other = commitContext("repo-a", branch({ name: "other" }));
    expect(parkedPushLeg({ push: target(true), context: here }, other)).toEqual({
      push: null,
      dropped: true,
    });
  });

  it("drops a force push parked in another repo", () => {
    const other = commitContext("repo-b", branch());
    expect(parkedPushLeg({ push: target(true), context: here }, other)).toEqual({
      push: null,
      dropped: true,
    });
  });

  it("leaves a plain push alone", () => {
    const other = commitContext("repo-a", branch({ name: "other" }));
    expect(parkedPushLeg({ push: target(false), context: here }, other)).toEqual({
      push: target(false),
      dropped: false,
    });
  });

  it("has nothing to drop without a push", () => {
    expect(parkedPushLeg(null, here)).toEqual({ push: null, dropped: false });
    expect(parkedPushLeg({ push: null, context: "x" }, here)).toEqual({
      push: null,
      dropped: false,
    });
  });
});

describe("push-leg messages", () => {
  it("distinguishes pushed from published", () => {
    expect(
      commitPushSuccessMessage({ remote: "origin", branch: "main", setUpstream: false, force: false }),
    ).toBe("Committed and pushed 'main' to origin");
    expect(
      commitPushSuccessMessage({ remote: "origin", branch: "main", setUpstream: true, force: false }),
    ).toBe("Committed and published 'main' to origin");
    expect(
      commitPushSuccessMessage({ remote: "origin", branch: "main", setUpstream: false, force: true }),
    ).toBe("Amended and force-pushed 'main' to origin");
  });

  it("says Amended after an amend", () => {
    expect(
      commitPushSuccessMessage(
        { remote: "origin", branch: "main", setUpstream: true, force: false },
        true,
      ),
    ).toBe("Amended and published 'main' to origin");
    expect(
      commitPushSuccessMessage(
        { remote: "origin", branch: "main", setUpstream: false, force: false },
        true,
      ),
    ).toBe("Amended and pushed 'main' to origin");
  });

  it("a rejected force push blames the moved remote, not a missing pull", () => {
    const forced = { remote: "origin", branch: "main", setUpstream: false, force: true };
    expect(commitPushFailureDetail(forced, "PushRejected", "Pull first")).toBe(
      "the remote branch changed since the last fetch. Fetch and review before force-pushing again.",
    );
    expect(commitPushFailureDetail(forced, "AuthFailed", "Auth text")).toBe("Auth text");
    expect(
      commitPushFailureDetail({ ...forced, force: false }, "PushRejected", "Pull first"),
    ).toBe("Pull first");
  });

  it("the failure message says the commit itself succeeded", () => {
    const msg = commitPushFailureMessage("Push rejected");
    expect(msg).toContain("commit succeeded");
    expect(msg).toContain("Push rejected");
  });
});
