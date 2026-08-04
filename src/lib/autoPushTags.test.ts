// Unit tests for the auto-push-tags decision (BACKLOG "Auto-push tags with
// their commit"): after a push, exactly the tags whose target commit BECAME
// public through that push are pushed - never a repo-wide sweep of older
// local tags, and never a clobber of a same-named remote tag.

import { describe, test, expect } from "vitest";
import { resolveAutoPushTags, effectiveAutoPushTags } from "./autoPushTags";
import type { TagInfo } from "./types";

function tag(name: string, target: string, onRemote: boolean): TagInfo {
  return {
    name,
    target_sha: target,
    annotated: false,
    message: null,
    target_on_remote: onRemote,
    created_at: 0,
  };
}

describe("resolveAutoPushTags", () => {
  test("pushes a tag whose target flipped to public with this push", () => {
    const before = [tag("v1", "aaa", false)];
    const after = [tag("v1", "aaa", true)];
    expect(resolveAutoPushTags(before, after, [])).toEqual({
      push: ["v1"],
      skipped: [],
    });
  });

  test("a tag that was already publishable before is NOT swept along", () => {
    // Created while the setting was off (or predating it): the user declined
    // to publish it back then - only flips count.
    const before = [tag("old", "aaa", true), tag("v2", "bbb", false)];
    const after = [tag("old", "aaa", true), tag("v2", "bbb", true)];
    expect(resolveAutoPushTags(before, after, [])).toEqual({
      push: ["v2"],
      skipped: [],
    });
  });

  test("a tag still not public after the push is left alone", () => {
    const before = [tag("wip", "ccc", false)];
    const after = [tag("wip", "ccc", false)];
    expect(resolveAutoPushTags(before, after, [])).toEqual({
      push: [],
      skipped: [],
    });
  });

  test("a tag created during the operation (absent before) counts as flipped", () => {
    // Create-time trigger: `before` is the list minus the new tag.
    const after = [tag("v3", "ddd", true)];
    expect(resolveAutoPushTags([], after, [])).toEqual({
      push: ["v3"],
      skipped: [],
    });
  });

  test("already on the remote with the same target: silently skipped", () => {
    const before = [tag("v1", "aaa", false)];
    const after = [tag("v1", "aaa", true)];
    const remote = [{ name: "v1", target_sha: "aaa" }];
    expect(resolveAutoPushTags(before, after, remote)).toEqual({
      push: [],
      skipped: [],
    });
  });

  test("same-named remote tag with a different target: skipped with warning, never clobbered", () => {
    const before = [tag("v1", "aaa", false)];
    const after = [tag("v1", "aaa", true)];
    const remote = [{ name: "v1", target_sha: "fff" }];
    expect(resolveAutoPushTags(before, after, remote)).toEqual({
      push: [],
      skipped: ["v1"],
    });
  });
});

describe("effectiveAutoPushTags", () => {
  test("repo override wins over global", () => {
    expect(effectiveAutoPushTags({ auto_push_tags: true }, { auto_push_tags: false })).toBe(true);
    expect(effectiveAutoPushTags({ auto_push_tags: false }, { auto_push_tags: true })).toBe(false);
  });

  test("null/missing override inherits global; everything absent means off", () => {
    expect(effectiveAutoPushTags({ auto_push_tags: null }, { auto_push_tags: true })).toBe(true);
    expect(effectiveAutoPushTags(null, { auto_push_tags: true })).toBe(true);
    expect(effectiveAutoPushTags(null, null)).toBe(false);
  });
});
