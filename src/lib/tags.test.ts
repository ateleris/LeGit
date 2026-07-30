import { describe, expect, it } from "vitest";
import { pickTagRemote, pushedTagNames } from "./tags";
import type { Remote, RemoteTag, TagInfo } from "./types";

const tag = (name: string, sha: string): TagInfo => ({
  name,
  target_sha: sha,
  annotated: false,
  message: null,
  target_on_remote: true,
  created_at: 0,
});
const remoteTag = (name: string, sha: string): RemoteTag => ({ name, target_sha: sha });
const remote = (name: string): Remote => ({ name, fetch_url: "u", push_url: "u" });

describe("pushedTagNames", () => {
  it("marks tags present on the remote with the same target", () => {
    const pushed = pushedTagNames(
      [tag("v1", "aaa"), tag("v2", "bbb")],
      [remoteTag("v1", "aaa")],
    );
    expect(pushed.has("v1")).toBe(true);
    expect(pushed.has("v2")).toBe(false);
  });

  it("does NOT mark a same-named remote tag pointing elsewhere", () => {
    // The local tag was re-created (moved) — the remote still has the old
    // target, so the indicator would misleadingly claim it's pushed.
    const pushed = pushedTagNames([tag("v1", "new")], [remoteTag("v1", "old")]);
    expect(pushed.has("v1")).toBe(false);
  });

  it("handles empty inputs", () => {
    expect(pushedTagNames([], []).size).toBe(0);
    expect(pushedTagNames([tag("v1", "a")], []).size).toBe(0);
  });
});

describe("pickTagRemote", () => {
  it("prefers origin, else the first remote, else null", () => {
    expect(pickTagRemote([remote("up"), remote("origin")])).toBe("origin");
    expect(pickTagRemote([remote("up"), remote("fork")])).toBe("up");
    expect(pickTagRemote([])).toBeNull();
  });
});
