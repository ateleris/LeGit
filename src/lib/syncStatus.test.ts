import { describe, expect, it } from "vitest";
import { shouldToastSyncStatus, syncStatusText } from "./syncStatus";

describe("syncStatusText", () => {
  it("renders one line per state", () => {
    expect(syncStatusText(null)).toBe("Not configured");
    expect(syncStatusText({ kind: "disabled", message: null, lastSync: null })).toBe(
      "Not configured",
    );
    expect(
      syncStatusText({ kind: "inSync", message: null, lastSync: "2026-10-02T10:00:00Z" }),
    ).toMatch(/^In sync/);
    expect(syncStatusText({ kind: "ahead", message: null, lastSync: null })).toBe(
      "Local changes not pushed yet",
    );
    expect(syncStatusText({ kind: "offline", message: null, lastSync: null })).toBe(
      "Offline: will sync when the remote is reachable",
    );
    expect(syncStatusText({ kind: "conflict", message: null, lastSync: null })).toMatch(
      /conflict/i,
    );
    expect(syncStatusText({ kind: "error", message: "boom", lastSync: null })).toContain("boom");
  });

  it("falls back to a generic error line without a message", () => {
    expect(syncStatusText({ kind: "error", message: null, lastSync: null })).toMatch(/failed/i);
  });
});

describe("shouldToastSyncStatus", () => {
  it("toasts only on entering conflict or error", () => {
    expect(shouldToastSyncStatus(null, "error")).toBe(true);
    expect(shouldToastSyncStatus(null, "conflict")).toBe(true);
    expect(shouldToastSyncStatus("error", "error")).toBe(false);
    expect(shouldToastSyncStatus("error", "conflict")).toBe(true);
    expect(shouldToastSyncStatus(null, "offline")).toBe(false);
    expect(shouldToastSyncStatus(null, "ahead")).toBe(false);
    expect(shouldToastSyncStatus(null, "inSync")).toBe(false);
    expect(shouldToastSyncStatus("conflict", "inSync")).toBe(false);
  });
});
