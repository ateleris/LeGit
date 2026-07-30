// @vitest-environment happy-dom
//
// Ref-row click -> commit graph jump. Two properties are pinned here:
// clicks on interactive elements inside a row never count as a jump gesture,
// and the jump itself only notifies already-open panels - it must never open
// one or leave a queued payload that would pop in on a later mount.
import { describe, it, expect, afterEach } from "vitest";
import { useSummonStore } from "../../store/summon";
import { isRowBackgroundClick, jumpPanelsToCommit } from "./jumpToCommit";

describe("isRowBackgroundClick", () => {
  function row(innerHtml: string): HTMLElement {
    const el = document.createElement("div");
    el.innerHTML = innerHtml;
    return el;
  }

  it("accepts the row container itself", () => {
    expect(isRowBackgroundClick(row(""))).toBe(true);
  });

  it("accepts plain text spans inside the row", () => {
    const el = row('<span id="name">main</span>');
    expect(isRowBackgroundClick(el.querySelector("#name"))).toBe(true);
  });

  it("rejects buttons and elements nested inside them", () => {
    const el = row('<button id="b"><span id="inner">Checkout</span></button>');
    expect(isRowBackgroundClick(el.querySelector("#b"))).toBe(false);
    expect(isRowBackgroundClick(el.querySelector("#inner"))).toBe(false);
  });

  it("rejects form fields (inline rename inputs)", () => {
    const el = row('<input id="i" /><textarea id="t"></textarea><select id="s"></select>');
    expect(isRowBackgroundClick(el.querySelector("#i"))).toBe(false);
    expect(isRowBackgroundClick(el.querySelector("#t"))).toBe(false);
    expect(isRowBackgroundClick(el.querySelector("#s"))).toBe(false);
  });

  it("rejects links", () => {
    const el = row('<a id="a" href="#">origin/main</a>');
    expect(isRowBackgroundClick(el.querySelector("#a"))).toBe(false);
  });

  it("accepts a non-Element target (defensive default)", () => {
    expect(isRowBackgroundClick(null)).toBe(true);
  });
});

describe("jumpPanelsToCommit", () => {
  afterEach(() => {
    const { unregisterTarget } = useSummonStore.getState();
    for (const id of ["log", "commit-details", "changed-files"]) unregisterTarget(id);
    useSummonStore.setState({ payloadQueue: {} });
  });

  it("delivers the sha to every mounted inspection panel", () => {
    const got: Record<string, unknown> = {};
    const { registerTarget } = useSummonStore.getState();
    registerTarget("log", (p) => { got.log = p; });
    registerTarget("commit-details", (p) => { got.details = p; });
    registerTarget("changed-files", (p) => { got.changed = p; });

    jumpPanelsToCommit("abc123");

    expect(got).toEqual({ log: "abc123", details: "abc123", changed: "abc123" });
  });

  it("never opens or queues for unmounted panels", () => {
    // No targets registered = no panels open. The jump must be a no-op:
    // a queued payload would make the panel adopt a stale selection when
    // the user opens it later for an unrelated reason.
    jumpPanelsToCommit("abc123");
    expect(useSummonStore.getState().payloadQueue).toEqual({});
  });

  it("only notifies the panels that are mounted", () => {
    const got: unknown[] = [];
    useSummonStore.getState().registerTarget("log", (p) => got.push(p));

    jumpPanelsToCommit("def456");

    expect(got).toEqual(["def456"]);
    expect(useSummonStore.getState().payloadQueue).toEqual({});
  });

  it("ignores a missing commit id (unborn branch head)", () => {
    const got: unknown[] = [];
    useSummonStore.getState().registerTarget("log", (p) => got.push(p));

    jumpPanelsToCommit(null);
    jumpPanelsToCommit(undefined);

    expect(got).toEqual([]);
  });
});
