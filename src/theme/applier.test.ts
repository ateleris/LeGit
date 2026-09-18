// @vitest-environment happy-dom
//
// Panel overrides: a theme may rebind the PANEL_OVERRIDE_TOKENS per panel
// id. The applier turns them into rules scoped to the panel wrapper's
// `data-panel-id`, so the cascade re-colours the subtree with no component
// changes. Everything outside the allowlist, referencing an undefined
// palette entry, or under a malformed panel id must be silently skipped.

import { describe, expect, it } from "vitest";
import type { ThemeDocument } from "../lib/types";
import { applyTheme, panelOverridesCss, PANEL_OVERRIDES_STYLE_ID, resolveTheme } from "./applier";
import { DEFAULT_THEME } from "./defaults";

const theme = (panelOverrides?: ThemeDocument["panelOverrides"]): ThemeDocument => ({
  format: "legit-theme",
  formatVersion: 1,
  name: "Test",
  palette: { ...DEFAULT_THEME.palette },
  tokens: { ...DEFAULT_THEME.tokens },
  panelOverrides,
});

describe("panelOverridesCss", () => {
  it("returns an empty string when the theme has no overrides", () => {
    expect(panelOverridesCss(theme())).toBe("");
    expect(panelOverridesCss(theme({}))).toBe("");
  });

  it("emits a rule scoped to the panel id, binding the token var to the palette var", () => {
    const css = panelOverridesCss(theme({ log: { "panel.bg": "accent" } }));
    expect(css).toBe(`[data-panel-id="log"] { --panel-bg: var(--palette-accent); }`);
  });

  it("wraps filtered bindings in the filter's color-mix recipe", () => {
    const css = panelOverridesCss(
      theme({ log: { "panel.fg": { ref: "main-fg", filter: "lighter" } } }),
    );
    expect(css).toBe(
      `[data-panel-id="log"] { --panel-fg: color-mix(in srgb, var(--palette-main-fg), white 15%); }`,
    );
  });

  it("emits one rule per panel with all its declarations", () => {
    const css = panelOverridesCss(
      theme({
        log: { "panel.bg": "accent", "panel.fg": "accent-fg" },
        refs: { "panel.border": "accent" },
      }),
    );
    expect(css).toBe(
      [
        `[data-panel-id="log"] { --panel-bg: var(--palette-accent); --panel-fg: var(--palette-accent-fg); }`,
        `[data-panel-id="refs"] { --panel-border: var(--palette-accent); }`,
        `.legit-panel-chrome .dv-groupview:has(.dv-content-container [data-panel-id="refs"]) { border-color: var(--palette-accent); }`,
      ].join("\n"),
    );
  });

  // The spaced-chrome group border (global.css .legit-panel-chrome
  // .dv-groupview) is painted on an ANCESTOR of the panel wrapper, so the
  // scoped var can't reach it — a panel.border override must also recolour
  // the group currently showing the panel (dockview keeps only the active
  // panel's element in .dv-content-container).
  it("panel.border overrides also recolour the spaced-chrome group border", () => {
    const css = panelOverridesCss(theme({ log: { "panel.border": "accent" } }));
    expect(css).toBe(
      [
        `[data-panel-id="log"] { --panel-border: var(--palette-accent); }`,
        `.legit-panel-chrome .dv-groupview:has(.dv-content-container [data-panel-id="log"]) { border-color: var(--palette-accent); }`,
      ].join("\n"),
    );
  });

  it("non-border overrides emit no group rule", () => {
    const css = panelOverridesCss(theme({ log: { "panel.bg": "accent" } }));
    expect(css).not.toContain("dv-groupview");
  });

  it("skips tokens outside the allowlist", () => {
    const css = panelOverridesCss(
      theme({ log: { "app.bg": "accent", "panel.bg": "accent" } }),
    );
    expect(css).not.toContain("--app-bg");
    expect(css).toContain("--panel-bg");
  });

  it("skips bindings referencing an undefined palette entry", () => {
    const css = panelOverridesCss(theme({ log: { "panel.bg": "no-such-entry" } }));
    expect(css).toBe("");
  });

  it("skips malformed panel ids (attribute-selector injection)", () => {
    const css = panelOverridesCss(theme({ 'bad"] * { color: red } [x="': { "panel.bg": "accent" } }));
    expect(css).toBe("");
  });
});

describe("resolveTheme", () => {
  it("preserves panelOverrides", () => {
    const overrides = { log: { "panel.bg": "accent" } };
    expect(resolveTheme(theme(overrides)).panelOverrides).toEqual(overrides);
  });
});

describe("applyTheme panel-overrides style element", () => {
  it("writes the override rules into the dedicated style element", () => {
    applyTheme(theme({ log: { "panel.bg": "accent" } }));
    const el = document.getElementById(PANEL_OVERRIDES_STYLE_ID);
    expect(el?.textContent).toBe(`[data-panel-id="log"] { --panel-bg: var(--palette-accent); }`);
  });

  it("resolves override refs against the merged palette (default entries work)", () => {
    const doc = theme({ log: { "panel.bg": "accent" } });
    doc.palette = {}; // own palette empty: "accent" comes from the built-in default
    applyTheme(doc);
    const el = document.getElementById(PANEL_OVERRIDES_STYLE_ID);
    expect(el?.textContent).toContain("--panel-bg: var(--palette-accent)");
  });

  it("clears stale rules when the next theme has no overrides", () => {
    applyTheme(theme({ log: { "panel.bg": "accent" } }));
    applyTheme(theme());
    const el = document.getElementById(PANEL_OVERRIDES_STYLE_ID);
    expect(el?.textContent).toBe("");
  });
});
