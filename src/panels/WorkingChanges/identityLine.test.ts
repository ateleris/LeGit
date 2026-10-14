import { describe, expect, it } from "vitest";
import { identityLineText } from "./identityLine";
import type { GitProfile, ProfileMatch, ResolvedIdentity } from "../../lib/types";

const identity: ResolvedIdentity = {
  user_name: "Simon Beck",
  user_email: "simon@example.ch",
};

function profile(id: string, name: string): GitProfile {
  return {
    id,
    name,
    userName: null,
    userEmail: null,
    gpgFormat: null,
    signingKey: null,
    commitGpgsign: null,
    allowedSignersFile: null,
    authSshKey: null,
    credentialHelper: null,
  };
}

const BASE = 'Committing as Simon Beck <simon@example.ch>';

describe("identityLineText", () => {
  it("is null while the identity has not loaded", () => {
    expect(identityLineText(undefined, { kind: "inherit" }, [])).toBeNull();
  });

  it("is null when name or email is missing (the warning banner owns that case)", () => {
    expect(
      identityLineText({ user_name: null, user_email: "a@b.c" }, { kind: "inherit" }, []),
    ).toBeNull();
    expect(
      identityLineText({ user_name: "A", user_email: null }, { kind: "inherit" }, []),
    ).toBeNull();
  });

  it("shows only the identity when the repo inherits the global config", () => {
    expect(identityLineText(identity, { kind: "inherit" }, [])).toBe(BASE);
  });

  it("shows only the identity while the profile match has not loaded", () => {
    expect(identityLineText(identity, undefined, [])).toBe(BASE);
  });

  it("appends the profile name when a profile is active", () => {
    const match: ProfileMatch = { kind: "active", profile_id: "p1" };
    expect(identityLineText(identity, match, [profile("p1", "Work")])).toBe(
      `${BASE} - profile "Work"`,
    );
  });

  it("omits the profile suffix when the active profile is unknown or unnamed", () => {
    const match: ProfileMatch = { kind: "active", profile_id: "p1" };
    expect(identityLineText(identity, match, [])).toBe(BASE);
    expect(identityLineText(identity, match, [profile("p1", "")])).toBe(BASE);
  });

  it("marks a repo-specific config as custom", () => {
    expect(identityLineText(identity, { kind: "custom" }, [])).toBe(
      `${BASE} - custom (this repo)`,
    );
  });
});
