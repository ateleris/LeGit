import { describe, expect, it } from "vitest";
import { shouldToastSyncStatus, syncStatusText, newerVersionHint, supersededNote } from "./syncStatus";

describe("syncStatusText", () => {
  it("renders one line per state", () => {
    expect(syncStatusText(null)).toBe("Not configured");
    expect(syncStatusText({ kind: "disabled", message: null, lastSync: null, newerAppVersion: null, superseded: [] })).toBe(
      "Not configured",
    );
    expect(
      syncStatusText({ kind: "inSync", message: null, lastSync: "2026-10-02T10:00:00Z", newerAppVersion: null, superseded: [] }),
    ).toMatch(/^In sync/);
    expect(syncStatusText({ kind: "ahead", message: null, lastSync: null, newerAppVersion: null, superseded: [] })).toBe(
      "Local changes not pushed yet",
    );
    expect(syncStatusText({ kind: "offline", message: null, lastSync: null, newerAppVersion: null, superseded: [] })).toBe(
      "Offline: will sync when the remote is reachable",
    );
    expect(syncStatusText({ kind: "conflict", message: null, lastSync: null, newerAppVersion: null, superseded: [] })).toMatch(
      /conflict/i,
    );
    expect(syncStatusText({ kind: "error", message: "boom", lastSync: null, newerAppVersion: null, superseded: [] })).toContain("boom");
  });

  it("falls back to a generic error line without a message", () => {
    expect(syncStatusText({ kind: "error", message: null, lastSync: null, newerAppVersion: null, superseded: [] })).toMatch(/failed/i);
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

describe("receive-only", () => {
  it("has its own status line", () => {
    expect(
      syncStatusText({ kind: "receiveOnly", message: null, lastSync: null, newerAppVersion: "1.7.0", superseded: [] }),
    ).toMatch(/Receiving only/);
  });
});

describe("newerVersionHint", () => {
  it("names the newer version and stays silent otherwise", () => {
    const status = { kind: "inSync" as const, message: null, lastSync: null, superseded: [] };
    expect(newerVersionHint({ ...status, newerAppVersion: "1.7.0" })).toMatch(/newer LeGit \(1\.7\.0\).*sends none.*stay as they are/);
    expect(newerVersionHint({ ...status, newerAppVersion: null, superseded: [] })).toBeNull();
    expect(newerVersionHint(null)).toBeNull();
  });
});

describe("supersededNote", () => {
  it("names the settings whose local change was replaced", () => {
    const status = { kind: "inSync", message: null, lastSync: null, newerAppVersion: null } as const;
    expect(supersededNote({ ...status, superseded: ["ui_font_size", "gitProfiles"] })).toMatch(
      /kept: ui_font_size, gitProfiles$/,
    );
    expect(supersededNote({ ...status, superseded: [] })).toBeNull();
  });
});
