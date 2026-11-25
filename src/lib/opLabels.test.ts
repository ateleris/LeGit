import { describe, expect, it } from "vitest";
import { commands } from "./bindings";
import { OP_LABELS, opLabel } from "./opLabels";

describe("opLabel", () => {
  it("names the operation from its arguments", () => {
    expect(opLabel("repoMerge", ["repo", "main", {}])).toBe("Merging main…");
    expect(opLabel("repoMergeAbort", ["repo"])).toBe("Aborting the merge…");
    expect(opLabel("repoCherryPick", ["repo", ["a", "b"], null])).toBe("Cherry-picking 2 commits…");
    expect(opLabel("repoCheckoutRemoteBranch", ["repo", "refs/remotes/origin/x"])).toBe(
      "Checking out origin/x…",
    );
    expect(opLabel("repoDeleteRemoteTag", ["repo", "origin", "v1", "op"])).toBe(
      "Deleting tag v1 on origin…",
    );
  });

  it("gives reads and self-reporting commands no busy notice", () => {
    for (const name of ["repoStatus", "repoLog", "repoFetch", "repoPull", "repoPush"]) {
      expect(opLabel(name, ["repo"]), name).toBeNull();
    }
  });

  it("only labels commands that exist", () => {
    for (const name of Object.keys(OP_LABELS)) expect(commands, name).toHaveProperty(name);
  });

  // Every operation the in-progress banner and the history menus can start
  // must report activity: a missing entry is a silent wait.
  it("covers every merge, rebase, cherry-pick, revert, reset, checkout and stash command", () => {
    const mustCover = Object.keys(commands).filter((n) =>
      /^repo(Merge|Rebase|CherryPick|Revert)(Continue|Skip|Abort|Interactive)?$|^repo(Reset|SwitchBranch|CheckoutRemoteBranch|CheckoutCommit|Discard|Commit)$|^repo(Create|Apply|Pop|Drop)Stash/.test(
        n,
      ),
    );
    expect(mustCover.length).toBeGreaterThan(20);
    for (const name of mustCover) expect(OP_LABELS, name).toHaveProperty(name);
  });
});
