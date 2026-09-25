import { useState } from "react";
import { LinkIcon, UnlinkIcon } from "../../icons";
import { Button, IconButton } from "../shared/buttons";
import { useDelayedBusy } from "../shared/useDelayedBusy";
import type { RegionPlacement } from "../../lib/types";
import {
  useSettingsStore,
  UI_FONT_SIZE_DEFAULT,
  UI_FONT_SIZE_MIN,
  UI_FONT_SIZE_MAX,
  PANEL_BORDER_WIDTH_DEFAULT,
  PANEL_BORDER_WIDTH_MAX,
  PANEL_GAP_MAX,
  PANEL_RADIUS_MAX,
} from "../../store/settings";
import { Section, WritesTo } from "./primitives";
import { NumberField, SETTINGS_GRID_COLS } from "./NumberField";

/** localStorage key for the panel spacing / corner radius link (default on). */
const PANEL_CHROME_LINK_KEY = "legit.panel-chrome-link";

export function GeneralSection() {
  const placement = useSettingsStore((s) => s.settings?.global_region_placement ?? "left");
  const setRegionPlacement = useSettingsStore((s) => s.setRegionPlacement);
  const fontSize = useSettingsStore((s) => s.settings?.ui_font_size ?? UI_FONT_SIZE_DEFAULT);
  const setUiFontSize = useSettingsStore((s) => s.setUiFontSize);
  const panelGap = useSettingsStore((s) => s.settings?.panel_gap ?? 0);
  const panelRadius = useSettingsStore((s) => s.settings?.panel_corner_radius ?? 0);
  const panelBorder = useSettingsStore(
    (s) => s.settings?.panel_border_width ?? PANEL_BORDER_WIDTH_DEFAULT,
  );
  const setPanelChrome = useSettingsStore((s) => s.setPanelChrome);
  const { busy: saving, run } = useDelayedBusy();

  // Photoshop-style link between panel spacing and corner radius: while
  // linked (the default) the radius mirrors the gap (capped at its own max)
  // and can't be edited; unlink to set it separately. Frontend-only
  // preference, like the graph's line-height/lane-width link.
  const [chromeLinked, setChromeLinked] = useState(
    () => localStorage.getItem(PANEL_CHROME_LINK_KEY) !== "0",
  );
  const linkedRadius = (gap: number) => Math.min(gap, PANEL_RADIUS_MAX);
  const toggleChromeLink = () => {
    const next = !chromeLinked;
    setChromeLinked(next);
    try { localStorage.setItem(PANEL_CHROME_LINK_KEY, next ? "1" : "0"); } catch { /* quota */ }
    // Re-linking applies the constraint immediately.
    if (next && panelRadius !== linkedRadius(panelGap)) {
      void run(() => setPanelChrome(panelGap, linkedRadius(panelGap), panelBorder));
    }
  };
  const shownRadius = chromeLinked ? linkedRadius(panelGap) : panelRadius;

  const selectPlacement = (p: RegionPlacement) => {
    if (p === placement) return;
    void run(() => setRegionPlacement(p));
  };

  const saveFont = (v: number) => run(() => setUiFontSize(v));

  return (
    <Section title="General">
      <WritesTo note="base UI size and dock placement for all panels" />
      <div
        style={{
          display: "grid",
          // label · gutter · control · range: shared shape/widths with Commits
          // graph so the control column aligns across the two sections.
          gridTemplateColumns: SETTINGS_GRID_COLS,
          gap: "0.5em 0.833em",
          alignItems: "center",
          marginTop: "0.667em",
          width: "fit-content",
          fontSize: "var(--fz-lg)",
        }}
      >
        <span className="legit-subtle" style={{ gridColumn: 1, gridRow: 1, whiteSpace: "nowrap" }}>Layout orientation</span>
        <div style={{ gridColumn: "3 / -1", gridRow: 1, display: "flex", gap: "0.667em" }}>
          <Button variant={placement === "top" ? "primary" : "default"} disabled={saving} onClick={() => selectPlacement("top")}>
            Top / Bottom
          </Button>
          <Button variant={placement === "left" ? "primary" : "default"} disabled={saving} onClick={() => selectPlacement("left")}>
            Left / Right
          </Button>
        </div>
        <NumberField
          grid
          row={2}
          label="UI font size"
          value={fontSize}
          min={UI_FONT_SIZE_MIN}
          max={UI_FONT_SIZE_MAX}
          disabled={saving}
          onCommit={saveFont}
        />
        <NumberField
          grid
          row={3}
          label="Panel spacing"
          value={panelGap}
          min={0}
          max={PANEL_GAP_MAX}
          disabled={saving}
          onCommit={(v) =>
            run(() => setPanelChrome(v, chromeLinked ? linkedRadius(v) : panelRadius, panelBorder))
          }
        />
        {/* Chain-link spanning the two inputs it governs (rows 3-4), in the
            gutter column just left of the inputs - same pattern as the
            Commits graph's line-height/lane-width link. */}
        <IconButton
          aria-pressed={chromeLinked}
          title={
            chromeLinked
              ? "Linked: corner radius follows panel spacing; click to set it separately"
              : "Unlinked: corner radius is set separately; click to link it to panel spacing"
          }
          onClick={toggleChromeLink}
          disabled={saving}
          style={{
            gridColumn: 2,
            gridRow: "3 / span 2",
            justifySelf: "center",
            alignSelf: "center",
            width: "1.9em",
            height: "1.7em",
            padding: 0,
            fontSize: "inherit",
            background: chromeLinked ? "var(--accent)" : "transparent",
            color: chromeLinked ? "var(--accent-fg)" : "var(--subtle-fg)",
            border: `1px solid ${chromeLinked ? "var(--accent)" : "transparent"}`,
          }}
        >
          {chromeLinked ? <LinkIcon /> : <UnlinkIcon />}
        </IconButton>
        <NumberField
          grid
          row={4}
          label="Panel corner radius"
          value={shownRadius}
          min={0}
          max={PANEL_RADIUS_MAX}
          disabled={saving || chromeLinked}
          onCommit={(v) => run(() => setPanelChrome(panelGap, v, panelBorder))}
        />
        <NumberField
          grid
          row={5}
          label="Panel border thickness"
          value={panelBorder}
          min={0}
          max={PANEL_BORDER_WIDTH_MAX}
          disabled={saving}
          onCommit={(v) => run(() => setPanelChrome(panelGap, shownRadius, v))}
        />
      </div>
      {fontSize !== UI_FONT_SIZE_DEFAULT && (
        <div style={{ marginTop: "0.833em" }}>
          <button disabled={saving} onClick={() => saveFont(UI_FONT_SIZE_DEFAULT)}>
            Reset font size to default
          </button>
        </div>
      )}
    </Section>
  );
}
