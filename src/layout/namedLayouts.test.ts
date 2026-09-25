// @vitest-environment happy-dom
//
// Named-layout document rules: layouts arrange the repository section only,
// imported files are validated structurally, and the legacy "saved default"
// localStorage snapshot migrates into a well-formed document.
import { describe, it, expect } from "vitest";
import {
  applyLayoutDocument,
  asLayoutBundle,
  asLayoutDocument,
  buildLayoutBundle,
  buildLayoutDocument,
  captureLayoutDocument,
  chooseUniqueName,
  migrateLegacyDefaultLayout,
} from "./namedLayouts";
describe("asLayoutDocument", () => {
  const good = () =>
    buildLayoutDocument("X", { grid: {}, panels: {} }, { dockview: {}, placements: {}, fallbacks: {} });

  it("accepts a well-formed document", () => {
    expect(asLayoutDocument(good())).not.toBeNull();
  });

  it("accepts one null dock but not both", () => {
    expect(asLayoutDocument({ ...good(), global: null })).not.toBeNull();
    expect(asLayoutDocument({ ...good(), repo: null })).not.toBeNull();
    expect(asLayoutDocument({ ...good(), global: null, repo: null })).toBeNull();
  });

  it("rejects wrong format, missing keys, and bad shapes", () => {
    expect(asLayoutDocument(null)).toBeNull();
    expect(asLayoutDocument("x")).toBeNull();
    expect(asLayoutDocument({ ...good(), format: "legit-theme" })).toBeNull();
    expect(asLayoutDocument({ ...good(), formatVersion: "1" })).toBeNull();
    expect(asLayoutDocument({ ...good(), name: "  " })).toBeNull();
    expect(asLayoutDocument({ ...good(), global: [1, 2] })).toBeNull();
    const missingRepo: Record<string, unknown> = { ...good() };
    delete missingRepo.repo;
    expect(asLayoutDocument(missingRepo)).toBeNull();
  });
});

describe("asLayoutBundle", () => {
  const doc = (name: string) =>
    buildLayoutDocument(name, { grid: {}, panels: {} }, { dockview: {}, placements: {}, fallbacks: {} });

  it("round-trips a built bundle", () => {
    const docs = asLayoutBundle(buildLayoutBundle([doc("A"), doc("B")]));
    expect(docs).not.toBeNull();
    expect(docs!.map((d) => d.name)).toEqual(["A", "B"]);
  });

  it("drops invalid entries but keeps the rest", () => {
    const bundle = buildLayoutBundle([doc("A")]);
    (bundle.layouts as unknown[]).push({ format: "legit-theme" }, null);
    const docs = asLayoutBundle(bundle);
    expect(docs!.map((d) => d.name)).toEqual(["A"]);
  });

  it("rejects non-bundles and bundles with nothing usable", () => {
    expect(asLayoutBundle(null)).toBeNull();
    expect(asLayoutBundle(doc("A"))).toBeNull();
    expect(asLayoutBundle({ format: "legit-layout-bundle", formatVersion: 1, layouts: [] })).toBeNull();
    expect(asLayoutBundle({ format: "legit-layout-bundle", formatVersion: 1, layouts: [{}] })).toBeNull();
    expect(asLayoutBundle({ format: "legit-layout-bundle", formatVersion: "1", layouts: [doc("A")] })).toBeNull();
  });
});

describe("chooseUniqueName", () => {
  it("returns the base when free, otherwise numbers up", () => {
    expect(chooseUniqueName("My layout", new Set())).toBe("My layout");
    expect(chooseUniqueName("My layout", new Set(["My layout"]))).toBe("My layout 2");
    expect(chooseUniqueName("My layout", new Set(["My layout", "My layout 2"]))).toBe(
      "My layout 3",
    );
  });
});

describe("migrateLegacyDefaultLayout", () => {
  const repoRaw = JSON.stringify({
    dockview: { grid: {} },
    placements: { log: "group-1" },
    fallbacks: {},
  });
  const globalRaw = JSON.stringify({ grid: { root: {} }, panels: {} });

  it("builds a document from both legacy snapshots", () => {
    const doc = migrateLegacyDefaultLayout(repoRaw, globalRaw, new Set());
    expect(doc).not.toBeNull();
    expect(doc!.name).toBe("My layout");
    expect(doc!.global).toEqual({ grid: { root: {} }, panels: {} });
    expect((doc!.repo as { placements: unknown }).placements).toEqual({ log: "group-1" });
    // The migrated document must survive its own validation round-trip.
    expect(asLayoutDocument(doc)).not.toBeNull();
  });

  it("migrates a single surviving part", () => {
    const doc = migrateLegacyDefaultLayout(repoRaw, null, new Set());
    expect(doc).not.toBeNull();
    expect(doc!.global).toBeNull();
  });

  it("avoids clashing with an existing layout name", () => {
    const doc = migrateLegacyDefaultLayout(repoRaw, globalRaw, new Set(["My layout"]));
    expect(doc!.name).toBe("My layout 2");
  });

  it("returns null when nothing parses", () => {
    expect(migrateLegacyDefaultLayout(null, null, new Set())).toBeNull();
    expect(migrateLegacyDefaultLayout("not json {", '"a string"', new Set())).toBeNull();
  });
});

// Layouts arrange the REPOSITORY section only: capture never snapshots the
// global dock, and apply ignores a (legacy) global part outright.
describe("repo-only capture and apply", () => {
  const fakeRepoApi = { toJSON: () => ({ grid: {} }) } as unknown as Parameters<
    typeof captureLayoutDocument
  >[1];

  it("capture snapshots only the repo dock (global always null)", () => {
    const doc = captureLayoutDocument("Reviewing", fakeRepoApi);
    expect(doc).not.toBeNull();
    expect(doc!.global).toBeNull();
    expect(doc!.repo).not.toBeNull();
  });

  it("capture without a repo dock has nothing to capture", () => {
    expect(captureLayoutDocument("Reviewing", null)).toBeNull();
  });

  it("apply ignores a legacy global part and succeeds on the repo part alone", () => {
    const doc = buildLayoutDocument("Old", { grid: { root: {} } }, null);
    // Repo part null -> nothing to do; the global part must not make this
    // fail (or touch anything - the signature no longer accepts a global
    // dock at all).
    expect(applyLayoutDocument(doc, null)).toBe(true);
  });
});
