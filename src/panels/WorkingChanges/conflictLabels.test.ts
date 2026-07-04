import { describe, expect, it } from "vitest";
import { takeSideLabels } from "./conflictLabels";

describe("takeSideLabels", () => {
  it("marks the deleting side for delete conflicts", () => {
    expect(takeSideLabels("deleted_by_them").theirs).toBe("Take theirs (delete file)");
    expect(takeSideLabels("deleted_by_them").ours).toBe("Take ours (keep file)");
    expect(takeSideLabels("deleted_by_us").ours).toBe("Take ours (delete file)");
    expect(takeSideLabels("deleted_by_us").theirs).toBe("Take theirs (keep file)");
  });

  it("plain labels for content conflicts and unknown kinds", () => {
    expect(takeSideLabels("both_modified")).toEqual({ ours: "Take ours", theirs: "Take theirs" });
    expect(takeSideLabels("both_added")).toEqual({ ours: "Take ours", theirs: "Take theirs" });
    expect(takeSideLabels(undefined)).toEqual({ ours: "Take ours", theirs: "Take theirs" });
  });
});
