import { describe, it, expect } from "vitest";
import { domainsAfterAutoFetch } from "./useAutoFetch";
import { SYNC_DOMAINS } from "./queries/domains";

describe("domainsAfterAutoFetch", () => {
  it("leaves refreshing to the watcher when it is on", () => {
    expect(domainsAfterAutoFetch(true)).toEqual([]);
  });

  it("refreshes what any fetch refreshes, tags included, when the watcher is off", () => {
    expect(domainsAfterAutoFetch(false)).toEqual(SYNC_DOMAINS);
    expect(domainsAfterAutoFetch(false)).toContain("tags");
  });
});
