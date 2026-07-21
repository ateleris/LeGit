// The hook itself is a thin useQuery wrapper; the testable contract is the
// shared key + invalidation helper that all profile mutations call.
import { describe, test, expect } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { GIT_PROFILES_KEY, invalidateGitProfiles } from "./useGitProfiles";

describe("invalidateGitProfiles", () => {
  test("marks the shared profiles query invalidated", () => {
    const qc = new QueryClient();
    qc.setQueryData(GIT_PROFILES_KEY, []);
    expect(qc.getQueryState(GIT_PROFILES_KEY)?.isInvalidated).toBe(false);
    invalidateGitProfiles(qc);
    expect(qc.getQueryState(GIT_PROFILES_KEY)?.isInvalidated).toBe(true);
  });

  test("does not touch unrelated query keys", () => {
    const qc = new QueryClient();
    qc.setQueryData(["some-repo-id", "branches"], []);
    invalidateGitProfiles(qc);
    expect(qc.getQueryState(["some-repo-id", "branches"])?.isInvalidated).toBe(false);
  });
});
