import { describe, expect, it, beforeEach } from "vitest";
import { isPanelDirty, usePanelDirtyStore } from "./panel-dirty";

describe("isPanelDirty", () => {
  it("is false for a panel nothing registered", () => {
    expect(isPanelDirty({}, "global-settings")).toBe(false);
    expect(isPanelDirty({ "global-settings": {} }, "global-settings")).toBe(false);
  });

  it("is true when any form is dirty", () => {
    const dirty = { "global-settings": { "git-config-global": false, "git-config-wsl-Ubuntu": true } };
    expect(isPanelDirty(dirty, "global-settings")).toBe(true);
  });

  it("is false only when every form is clean", () => {
    const dirty = { "global-settings": { a: false, b: false } };
    expect(isPanelDirty(dirty, "global-settings")).toBe(false);
  });

  it("does not leak across panels", () => {
    const dirty = { "repo-settings": { a: true } };
    expect(isPanelDirty(dirty, "global-settings")).toBe(false);
  });
});

describe("usePanelDirtyStore", () => {
  beforeEach(() => usePanelDirtyStore.setState({ dirty: {} }));

  // The regression: several forms share one panel, and a clean one used to
  // erase a dirty sibling's state (one boolean per panel), so closing the
  // panel skipped the unsaved-changes confirmation.
  it("a clean form does not clear a dirty sibling", () => {
    const { setDirty } = usePanelDirtyStore.getState();
    setDirty("global-settings", "git-config-wsl-Ubuntu", true);
    setDirty("global-settings", "line-endings-global", false);

    expect(isPanelDirty(usePanelDirtyStore.getState().dirty, "global-settings")).toBe(true);
  });

  it("clearing one form leaves the others intact", () => {
    const { setDirty } = usePanelDirtyStore.getState();
    setDirty("global-settings", "a", true);
    setDirty("global-settings", "b", true);
    setDirty("global-settings", "a", false);

    const { dirty } = usePanelDirtyStore.getState();
    expect(dirty["global-settings"]).toEqual({ a: false, b: true });
    expect(isPanelDirty(dirty, "global-settings")).toBe(true);

    setDirty("global-settings", "b", false);
    expect(isPanelDirty(usePanelDirtyStore.getState().dirty, "global-settings")).toBe(false);
  });
});
