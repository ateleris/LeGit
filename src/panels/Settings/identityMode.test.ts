import { describe, test, expect } from "vitest";
import type { GitProfile } from "../../lib/types";
import {
  INHERIT_VALUE,
  CUSTOM_VALUE,
  dropdownValueFromMatch,
  profileValues,
} from "./identityMode";

describe("dropdownValueFromMatch", () => {
  test("maps the three detection kinds onto dropdown values", () => {
    expect(dropdownValueFromMatch({ kind: "inherit" })).toBe(INHERIT_VALUE);
    expect(dropdownValueFromMatch({ kind: "active", profile_id: "p1" })).toBe("p1");
    expect(dropdownValueFromMatch({ kind: "custom" })).toBe(CUSTOM_VALUE);
  });
});

describe("profileValues", () => {
  test("projects a profile into ManagedKeys shape", () => {
    const p: GitProfile = {
      id: "p1",
      name: "Work",
      userName: "N",
      userEmail: "e@x.com",
      gpgFormat: "ssh",
      signingKey: "/k.pub",
      commitGpgsign: "true",
      allowedSignersFile: null,
      authSshKey: "/k",
      credentialHelper: "manager",
    };
    expect(profileValues(p)).toEqual({
      user_name: "N",
      user_email: "e@x.com",
      gpg_format: "ssh",
      signing_key: "/k.pub",
      commit_gpgsign: "true",
      allowed_signers_file: null,
      auth_ssh_key: "/k",
      credential_helper: "manager",
    });
  });
});
