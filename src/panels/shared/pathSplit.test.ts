// Path-aware truncation splits for ref rows: the prefix shrinks away first so
// the leaf (the branch/tag name itself) stays visible, mirroring the file-row
// behavior in FileTree. Invariant everywhere: prefix + leaf === input.

import { describe, test, expect } from "vitest";
import { splitRefName, splitStashMessage } from "./pathSplit";

describe("splitRefName", () => {
  test("splits at the last slash, prefix keeps its trailing slash", () => {
    expect(splitRefName("feature/simon/rework-xyz")).toEqual({
      prefix: "feature/simon/",
      leaf: "rework-xyz",
    });
    expect(splitRefName("release/v1.2.3")).toEqual({
      prefix: "release/",
      leaf: "v1.2.3",
    });
  });

  test("no slash means no prefix", () => {
    expect(splitRefName("main")).toEqual({ prefix: "", leaf: "main" });
  });

  test("a trailing slash stays attached to the leaf", () => {
    expect(splitRefName("a/b/")).toEqual({ prefix: "a/", leaf: "b/" });
  });

  test("empty string", () => {
    expect(splitRefName("")).toEqual({ prefix: "", leaf: "" });
  });
});

describe("splitStashMessage", () => {
  test("splits inside the branch of an 'On <branch>:' subject", () => {
    expect(splitStashMessage("On feature/foo/bar: fix thing")).toEqual({
      prefix: "On feature/foo/",
      leaf: "bar: fix thing",
    });
  });

  test("splits inside the branch of a 'WIP on <branch>:' subject", () => {
    expect(splitStashMessage("WIP on feature/foo/bar: 1234abc subject")).toEqual({
      prefix: "WIP on feature/foo/",
      leaf: "bar: 1234abc subject",
    });
  });

  test("slash in the message text, not the branch, does not split", () => {
    expect(splitStashMessage("On main: fix src/lib/foo.ts")).toEqual({
      prefix: "",
      leaf: "On main: fix src/lib/foo.ts",
    });
  });

  test("message not matching the reflog shapes does not split", () => {
    expect(splitStashMessage("custom message with/slash")).toEqual({
      prefix: "",
      leaf: "custom message with/slash",
    });
  });

  test("detached-HEAD subject does not split", () => {
    expect(splitStashMessage("WIP on (no branch): abc subject")).toEqual({
      prefix: "",
      leaf: "WIP on (no branch): abc subject",
    });
  });
});
