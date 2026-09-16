import { describe, expect, it } from "vitest";
import { remoteHostGitMessage } from "./remoteHostGit";
import type { RemoteHostGitPayload } from "./types";

const payload = (over: Partial<RemoteHostGitPayload["status"]>): RemoteHostGitPayload => ({
  distro: "Ubuntu",
  status: {
    resolved_path: "git",
    version: { raw: "git version 2.20.1", major: 2, minor: 20, patch: 1 },
    meets_minimum: false,
    minimum_required: [2, 34, 0],
    user_override: null,
    error: null,
    ...over,
  },
});

describe("remoteHostGitMessage", () => {
  it("reports a distro without git, naming the distro", () => {
    const msg = remoteHostGitMessage(payload({ version: null, error: "not found" }));
    expect(msg).toContain("Ubuntu");
    expect(msg).toMatch(/no git|not found|not installed/i);
  });

  it("reports a distro whose git is below the floor, with both versions", () => {
    const msg = remoteHostGitMessage(payload({}));
    expect(msg).toContain("Ubuntu");
    expect(msg).toContain("2.20.1");
    expect(msg).toContain("2.34.0");
  });

  it("says nothing about a healthy distro git", () => {
    expect(
      remoteHostGitMessage(
        payload({
          version: { raw: "git version 2.44.0", major: 2, minor: 44, patch: 0 },
          meets_minimum: true,
        })
      )
    ).toBeNull();
  });
});
