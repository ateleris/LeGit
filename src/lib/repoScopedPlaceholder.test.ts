import { describe, expect, test } from "vitest";
import { keepPreviousDataForRepo } from "./repoScopedPlaceholder";

// Minimal shape of the previous query react-query hands to a placeholderData
// function - only the key is consulted.
const prevQuery = (key: readonly unknown[]) => ({ queryKey: key }) as never;

describe("keepPreviousDataForRepo", () => {
  test("keeps the previous data when the previous key belongs to the same repo", () => {
    const placeholder = keepPreviousDataForRepo<string[]>("repo-a");
    const prev = ["c1", "c2"];
    // Same repo, different rest-of-key (e.g. a grown totalToFetch page).
    expect(placeholder(prev, prevQuery(["repo-a", "log", 1000]))).toBe(prev);
  });

  test("drops the previous data when it came from another repo", () => {
    // Regression: switching repos flashed the previously selected repo's
    // commit graph while the new repo's log was still loading, because an
    // unscoped keepPreviousData carried data across the repo-id key change.
    const placeholder = keepPreviousDataForRepo<string[]>("repo-b");
    expect(placeholder(["old-repo-rows"], prevQuery(["repo-a", "log", 500]))).toBeUndefined();
  });

  test("returns undefined without a previous query", () => {
    const placeholder = keepPreviousDataForRepo<string[]>("repo-a");
    expect(placeholder(undefined, undefined)).toBeUndefined();
    expect(placeholder(["rows"], undefined)).toBeUndefined();
  });

  test("never matches while no repo is active", () => {
    const placeholder = keepPreviousDataForRepo<string[]>(undefined);
    expect(placeholder(["rows"], prevQuery(["repo-a", "log", 500]))).toBeUndefined();
    // Even a previous key whose repo slot is undefined must not leak data.
    expect(placeholder(["rows"], prevQuery([undefined, "log", 500]))).toBeUndefined();
  });
});
