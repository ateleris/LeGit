import { describe, expect, it } from "vitest";
import { classifyWorktreeRemoveRefusal } from "./worktreeRemoveRefusal";

// Message texts are verbatim from git 2.43; the real-git counterpart
// (worktree_remove_with_submodule_* in git_flows_suite.rs) pins that git
// still produces them.
describe("classifyWorktreeRemoveRefusal", () => {
  it("classifies the dirty-worktree refusal", () => {
    expect(
      classifyWorktreeRemoveRefusal(
        "fatal: '../wt' contains modified or untracked files, use --force to delete it",
      ),
    ).toBe("dirty");
  });

  it("classifies the submodule refusal (which never mentions --force)", () => {
    expect(
      classifyWorktreeRemoveRefusal(
        "fatal: working trees containing submodules cannot be moved or removed",
      ),
    ).toBe("submodules");
  });

  it("does not offer force for a locked worktree", () => {
    // A single --force does not remove a locked worktree anyway; unlocking
    // is the right path, so this refusal must stay a plain error.
    expect(
      classifyWorktreeRemoveRefusal(
        "fatal: cannot remove a locked working tree, lock reason: usb\nuse 'remove -f -f' to override or unlock first",
      ),
    ).toBe(null);
  });

  it("leaves unrelated errors unclassified", () => {
    expect(classifyWorktreeRemoveRefusal("fatal: 'x' is not a working tree")).toBe(null);
  });
});
