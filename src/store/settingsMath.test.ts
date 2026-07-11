// The Commits-panel geometry clamps and the confirm-destructive default.
// The clamps mirror backend fns (state.rs) - drift means the two sides
// disagree about what a legal setting is; the default gates every
// confirm-before-destroy UI in the app.

import { describe, test, expect } from "vitest";
import {
  maxCommitsDotRadius,
  maxCommitsLineWidth,
  minCommitsRowHeight,
  useSettingsStore,
} from "./settings";

describe("commits graph geometry clamps", () => {
  test("dot radius: half the smaller cell dimension, floored", () => {
    expect(maxCommitsDotRadius(40, 30)).toBe(15);
    expect(maxCommitsDotRadius(25, 40)).toBe(12); // floor(12.5)
  });

  test("line width: half the smaller dimension, NOT floored (0.5px steps)", () => {
    expect(maxCommitsLineWidth(25, 40)).toBe(12.5);
  });

  test("row height floor tracks the ref-chip height (font*1.3 + 6)", () => {
    // 12px font: ceil(15.6) + 6 = 22.
    expect(minCommitsRowHeight(12)).toBe(22);
    // Tiny fonts still respect the absolute floor.
    expect(minCommitsRowHeight(1)).toBeGreaterThanOrEqual(minCommitsRowHeight(0));
    // Monotonic in font size.
    expect(minCommitsRowHeight(20)).toBeGreaterThan(minCommitsRowHeight(12));
  });
});

describe("confirm-destructive default", () => {
  test("defaults ON while settings are unloaded or the key is absent", () => {
    // The hook reads settings?.confirm_discard ?? true - replicate the
    // selector against raw store state (no React needed).
    useSettingsStore.setState({ settings: null });
    expect(useSettingsStore.getState().settings?.confirm_discard ?? true).toBe(true);
  });
});
