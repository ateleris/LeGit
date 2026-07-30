// @vitest-environment happy-dom
//
// Persisted-layout parsing: the same parser backs the repo dock's startup
// restore and the saved-default snapshot ("Save as default layout"), so its
// tolerance rules are pinned here - envelope format, bare-layout backward
// compatibility, and never throwing on garbage.
import { describe, it, expect } from "vitest";
import { parseRepoLayoutEnvelope } from "./layoutSnapshot";

describe("parseRepoLayoutEnvelope", () => {
  it("parses the envelope format", () => {
    const raw = JSON.stringify({
      dockview: { grid: {} },
      placements: { log: "group-1", diff: "group-2" },
      fallbacks: { diff: { referencePanel: "log", direction: "right" } },
    });
    const env = parseRepoLayoutEnvelope(raw);
    expect(env).not.toBeNull();
    expect(env!.dockview).toEqual({ grid: {} });
    expect(env!.placements).toEqual({ log: "group-1", diff: "group-2" });
    expect(env!.fallbacks).toEqual({ diff: { referencePanel: "log", direction: "right" } });
  });

  it("treats a bare layout (no dockview field) as the layout itself", () => {
    const raw = JSON.stringify({ grid: { root: {} }, panels: {} });
    const env = parseRepoLayoutEnvelope(raw);
    expect(env).not.toBeNull();
    expect(env!.dockview).toEqual({ grid: { root: {} }, panels: {} });
    expect(env!.placements).toEqual({});
    expect(env!.fallbacks).toEqual({});
  });

  it("drops malformed placement and fallback entries but keeps the rest", () => {
    const raw = JSON.stringify({
      dockview: {},
      placements: { log: "group-1", bad: 42 },
      fallbacks: { diff: { referencePanel: "log", direction: "right" }, bad: "nope" },
    });
    const env = parseRepoLayoutEnvelope(raw);
    expect(env!.placements).toEqual({ log: "group-1" });
    expect(env!.fallbacks).toEqual({ diff: { referencePanel: "log", direction: "right" } });
  });

  it("returns null for missing, non-JSON, or non-object input", () => {
    expect(parseRepoLayoutEnvelope(null)).toBeNull();
    expect(parseRepoLayoutEnvelope("")).toBeNull();
    expect(parseRepoLayoutEnvelope("not json {")).toBeNull();
    expect(parseRepoLayoutEnvelope('"a string"')).toBeNull();
    expect(parseRepoLayoutEnvelope("null")).toBeNull();
  });
});
