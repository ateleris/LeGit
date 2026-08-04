// Unit tests for the shared remote-op error wording: the classified kinds
// (auth, rejected push, submodule guard) get actionable text; everything else
// falls through to git's own message via formatAppError.

import { describe, test, expect } from "vitest";
import { remoteOpErrorMessage } from "./pushFeedback";

const gitError = (kind: string, details?: unknown) => ({
  kind: "Git",
  details: { kind, details },
});

describe("remoteOpErrorMessage", () => {
  test("auth failures point at the repo's git profile", () => {
    expect(remoteOpErrorMessage(gitError("AuthFailed", "fatal: auth"))).toMatch(
      /git profile/i,
    );
  });

  test("rejected pushes suggest pull or force-with-lease", () => {
    const msg = remoteOpErrorMessage(gitError("PushRejected", "rejected"));
    expect(msg).toMatch(/pull first/i);
    expect(msg).toMatch(/force-push/i);
  });

  test("the submodule guard explains pushing the submodule first", () => {
    const msg = remoteOpErrorMessage(gitError("UnpushedSubmodules", "lib"));
    expect(msg).toMatch(/submodule/i);
  });

  test("anything else shows git's own message", () => {
    expect(
      remoteOpErrorMessage(gitError("CommandFailed", { stderr: "fatal: boom" })),
    ).toBe("fatal: boom");
  });
});
