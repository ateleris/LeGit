import { describe, expect, it } from "vitest";
import { gateDecision, localGitUsable } from "./gateDecision";
import type { GitStatus } from "../../lib/types";

const status = (over: Partial<GitStatus>): GitStatus => ({
  resolved_path: "C:\\Program Files\\Git\\cmd\\git.exe",
  version: { raw: "git version 2.44.0", major: 2, minor: 44, patch: 0 },
  meets_minimum: true,
  minimum_required: [2, 34, 0],
  user_override: null,
  error: null,
  ...over,
});

const missing = status({ version: null, meets_minimum: false, error: "program not found" });

describe("gateDecision", () => {
  it("blocks on a missing git when no remote host can run one", () => {
    expect(gateDecision(missing, false)).toBe("install-git");
  });

  it("lets the app through on a missing git when a remote host is available", () => {
    expect(gateDecision(missing, true)).toBe("app");
  });

  it("blocks when the probe errored even though a version parsed", () => {
    expect(gateDecision(status({ error: "exec format error" }), false)).toBe("install-git");
  });

  it("warns about an old local git regardless of remote hosts", () => {
    const old = status({
      version: { raw: "git version 2.20.1", major: 2, minor: 20, patch: 1 },
      meets_minimum: false,
    });
    expect(gateDecision(old, false)).toBe("old-git");
    expect(gateDecision(old, true)).toBe("old-git");
  });

  it("lets a healthy git through", () => {
    expect(gateDecision(status({}), false)).toBe("app");
  });
});

describe("localGitUsable", () => {
  it("is false only when the binary could not be probed at all", () => {
    expect(localGitUsable(missing)).toBe(false);
    expect(localGitUsable(status({ error: "exec format error" }))).toBe(false);
    expect(localGitUsable(status({ meets_minimum: false }))).toBe(true);
    expect(localGitUsable(status({}))).toBe(true);
  });
});
