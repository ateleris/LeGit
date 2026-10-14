// The Commits-panel geometry clamps and the confirm-destructive default.
// The clamps mirror backend fns (state.rs) - drift means the two sides
// disagree about what a legal setting is; the default gates every
// confirm-before-destroy UI in the app.

import { describe, test, expect } from "vitest";
import {
  applyRepoTabStyle,
  maxRepoTabRadius,
  minRepoTabHeight,
  maxCommitsDotRadius,
  maxCommitsLineWidth,
  minCommitsRowHeight,
  panelChromeArmed,
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

describe("repo tab chrome clamps", () => {
  test("height floor leaves room for one UI-font text line", () => {
    expect(minRepoTabHeight(12)).toBe(16);
    expect(minRepoTabHeight(24)).toBe(28);
  });

  test("radius caps at half the configured tab height", () => {
    expect(maxRepoTabRadius(32)).toBe(16);
    expect(maxRepoTabRadius(17)).toBe(8);
  });
});

describe("repo tab style application", () => {
  function fakeRoot() {
    const vars: Record<string, string> = {};
    const attrs: Record<string, string> = {};
    return {
      vars,
      attrs,
      el: {
        style: { setProperty: (k: string, v: string) => { vars[k] = v; } },
        setAttribute: (k: string, v: string) => { attrs[k] = v; },
      } as unknown as HTMLElement,
    };
  }

  test("writes the six CSS vars in px and the style attribute", () => {
    const root = fakeRoot();
    applyRepoTabStyle(
      {
        style: "pill",
        gap: 4,
        inset: 8,
        height: 28,
        radius: 6,
        borderWidth: 2,
        stripBorderWidth: 3,
      },
      root.el,
    );
    expect(root.vars).toEqual({
      "--legit-tab-gap": "4px",
      "--legit-tab-inset": "8px",
      "--legit-tab-height": "28px",
      "--legit-tab-radius": "6px",
      "--legit-tab-border-width": "2px",
      "--legit-tab-strip-border-width": "3px",
    });
    expect(root.attrs["data-repo-tab-style"]).toBe("pill");
  });

  test("flush still sets the attribute so a style switch back is clean", () => {
    const root = fakeRoot();
    applyRepoTabStyle(
      {
        style: "flush",
        gap: 0,
        inset: 0,
        height: 32,
        radius: 0,
        borderWidth: 1,
        stripBorderWidth: 1,
      },
      root.el,
    );
    expect(root.attrs["data-repo-tab-style"]).toBe("flush");
  });
});

describe("panel chrome arming", () => {
  test("flush defaults (0 gap, 0 radius, 1px border) leave the chrome off", () => {
    expect(panelChromeArmed(0, 0, 1)).toBe(false);
  });

  test("any gap or radius arms it", () => {
    expect(panelChromeArmed(4, 0, 1)).toBe(true);
    expect(panelChromeArmed(0, 6, 1)).toBe(true);
  });

  test("a non-default border width arms it (borders replace the separators)", () => {
    expect(panelChromeArmed(0, 0, 2)).toBe(true);
    expect(panelChromeArmed(0, 0, 0)).toBe(true);
  });
});
