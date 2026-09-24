import { useState } from "react";
import { LinkIcon, UnlinkIcon } from "../../icons";
import { IconButton } from "../shared/buttons";
import { useDelayedBusy } from "../shared/useDelayedBusy";
import type { CommitDateFormat } from "../../lib/time";
import {
  useSettingsStore,
  COMMITS_ROW_HEIGHT_DEFAULT,
  COMMITS_LANE_WIDTH_DEFAULT,
  COMMITS_DOT_RADIUS_DEFAULT,
  COMMITS_LINE_WIDTH_DEFAULT,
  COMMITS_ROW_HEIGHT_MAX,
  COMMITS_LANE_WIDTH_MAX,
  COMMITS_DOT_RADIUS_MIN,
  COMMITS_LINE_WIDTH_MIN,
  UI_FONT_SIZE_DEFAULT,
  maxCommitsDotRadius,
  maxCommitsLineWidth,
  minCommitsRowHeight,
} from "../../store/settings";
import { FieldNote, Section, SettingCheckbox, WritesTo } from "./primitives";
import { NumberField, SETTINGS_GRID_COLS } from "./NumberField";

/** localStorage key for the line-height / lane-width link toggle (default on). */
const LANE_LINK_KEY = "legit.commits-lane-link";

export function CommitsGraphSection() {
  const rowHeight = useSettingsStore(
    (s) => s.settings?.commits_row_height ?? COMMITS_ROW_HEIGHT_DEFAULT,
  );
  // The minimum row height clears a ref chip (chips scale with the UI font).
  const uiFontSize = useSettingsStore(
    (s) => s.settings?.ui_font_size ?? UI_FONT_SIZE_DEFAULT,
  );
  const rowHeightMin = minCommitsRowHeight(uiFontSize);
  // The stored value can sit below the font-derived floor (the font size may
  // have been raised after it was saved); the panel — like the Commits panel
  // itself — works with the effective (floored) value, so the lane-width
  // minimum tracks font-size changes too.
  const effectiveRowHeight = Math.max(rowHeight, rowHeightMin);
  const laneWidth = useSettingsStore(
    (s) => s.settings?.commits_lane_width ?? COMMITS_LANE_WIDTH_DEFAULT,
  );
  const dotRadius = useSettingsStore(
    (s) => s.settings?.commits_dot_radius ?? COMMITS_DOT_RADIUS_DEFAULT,
  );
  const lineWidth = useSettingsStore(
    (s) => s.settings?.commits_line_width ?? COMMITS_LINE_WIDTH_DEFAULT,
  );
  const setMetrics = useSettingsStore((s) => s.setCommitsGraphMetrics);
  const { busy: saving, run } = useDelayedBusy();

  // Author avatars are strictly opt-in: off by default, because fetching one
  // sends the hashed author email to gravatar.com.
  const avatars = useSettingsStore((s) => s.settings?.commit_avatars ?? false);
  const setCommitAvatars = useSettingsStore((s) => s.setCommitAvatars);
  const initials = useSettingsStore((s) => s.settings?.commit_initials ?? false);
  const setCommitInitials = useSettingsStore((s) => s.setCommitInitials);
  const { busy: savingAvatars, run: runAvatars } = useDelayedBusy();
  const toggleAvatars = () => runAvatars(() => setCommitAvatars(!avatars));
  const toggleInitials = () => runAvatars(() => setCommitInitials(!initials));

  // Lane colouring: on/off is a viewing preference here; the per-part chip
  // filters stay in the theme (Theme Editor → Refs).
  const laneChips = useSettingsStore((s) => s.settings?.lane_colored_branch_chips ?? false);
  const stashBaseLane = useSettingsStore((s) => s.settings?.stash_base_lane_color ?? false);
  const setLaneColoredBranchChips = useSettingsStore((s) => s.setLaneColoredBranchChips);
  const setStashBaseLaneColor = useSettingsStore((s) => s.setStashBaseLaneColor);
  const { busy: savingLanes, run: runLanes } = useDelayedBusy();
  const toggleLaneChips = () => runLanes(() => setLaneColoredBranchChips(!laneChips));
  const toggleStashBaseLane = () => runLanes(() => setStashBaseLaneColor(!stashBaseLane));

  // Date column: relative ("2d ago", the default) vs the full author datetime,
  // in a user-picked format.
  const dateAbsolute = useSettingsStore((s) => s.settings?.commit_date_absolute ?? false);
  const dateFormat = useSettingsStore((s) => s.settings?.commit_date_format ?? "iso");
  const dateShowTime = useSettingsStore((s) => s.settings?.commit_date_show_time ?? true);
  const setCommitDateAbsolute = useSettingsStore((s) => s.setCommitDateAbsolute);
  const setCommitDateFormat = useSettingsStore((s) => s.setCommitDateFormat);
  const setCommitDateShowTime = useSettingsStore((s) => s.setCommitDateShowTime);
  const { busy: savingDate, run: runDate } = useDelayedBusy();
  const toggleDateAbsolute = () => runDate(() => setCommitDateAbsolute(!dateAbsolute));
  const selectDateFormat = (format: CommitDateFormat) =>
    runDate(() => setCommitDateFormat(format));
  const toggleDateShowTime = () => runDate(() => setCommitDateShowTime(!dateShowTime));
  // Option labels are format patterns (YYYY-MM-DD style), tracking the time
  // toggle so they always mirror the column's shape.
  const datePattern = (format: CommitDateFormat) => {
    const base = {
      iso: "YYYY-MM-DD",
      swiss: "DD.MM.YYYY",
      uk: "DD/MM/YYYY",
      us: "MM/DD/YYYY",
    }[format];
    if (!dateShowTime) return base;
    return format === "us" ? `${base} h:mm AM/PM` : `${base} HH:mm`;
  };

  const save = (
    nextRow: number,
    nextLane: number,
    nextDot: number,
    nextLine: number,
  ) => run(() => setMetrics(nextRow, nextLane, nextDot, nextLine));

  // Lane width shares the row height's font-derived floor.
  const effectiveLaneWidth = Math.max(laneWidth, rowHeightMin);

  // Photoshop-style link between line height and lane width: while linked
  // (the default) the lane width mirrors the line height and can't be edited;
  // unlink to set it separately. Frontend-only preference, like the layouts.
  const [linked, setLinked] = useState(
    () => localStorage.getItem(LANE_LINK_KEY) !== "0",
  );
  const toggleLink = () => {
    const next = !linked;
    setLinked(next);
    try { localStorage.setItem(LANE_LINK_KEY, next ? "1" : "0"); } catch { /* quota */ }
    // Re-linking applies the constraint immediately (like Photoshop).
    if (next && effectiveLaneWidth !== effectiveRowHeight) {
      void save(effectiveRowHeight, effectiveRowHeight, dotRadius, lineWidth);
    }
  };
  const shownLaneWidth = linked ? effectiveRowHeight : effectiveLaneWidth;

  // The dot and the line width can't exceed half the smaller cell dimension;
  // bound the fields accordingly so they reflect the current height/width.
  const dotMax = maxCommitsDotRadius(effectiveRowHeight, effectiveLaneWidth);
  const lineMax = maxCommitsLineWidth(effectiveRowHeight, effectiveLaneWidth);

  return (
    <Section title="Commits graph">
      <WritesTo note="affects the Commits panel for all repos" />
      <div
        style={{
          display: "grid",
          // label · link-gutter · input · range: shared widths with General
          // (see SETTINGS_GRID_COLS) so the input column aligns across sections.
          gridTemplateColumns: SETTINGS_GRID_COLS,
          gap: "0.5em 0.833em",
          alignItems: "center",
          marginTop: "0.667em",
          width: "fit-content",
          fontSize: "var(--fz-lg)",
        }}
      >
        <NumberField
          grid
          row={1}
          label="Line height"
          value={effectiveRowHeight}
          min={rowHeightMin}
          max={COMMITS_ROW_HEIGHT_MAX}
          disabled={saving}
          onCommit={(v) => save(v, linked ? v : effectiveLaneWidth, dotRadius, lineWidth)}
        />
        {/* Chain-link spanning the two inputs it governs (rows 1-2), in the
            gutter column just left of the inputs - Photoshop style. */}
        <IconButton
          aria-pressed={linked}
          title={
            linked
              ? "Linked: lane width follows line height; click to set it separately"
              : "Unlinked: lane width is set separately; click to link it to line height"
          }
          onClick={toggleLink}
          disabled={saving}
          style={{
            gridColumn: 2,
            gridRow: "1 / span 2",
            justifySelf: "center",
            alignSelf: "center",
            width: "1.9em",
            height: "1.7em",
            padding: 0,
            fontSize: "inherit",
            background: linked ? "var(--accent)" : "transparent",
            color: linked ? "var(--accent-fg)" : "var(--subtle-fg)",
            border: `1px solid ${linked ? "var(--accent)" : "transparent"}`,
          }}
        >
          {linked ? <LinkIcon /> : <UnlinkIcon />}
        </IconButton>
        <NumberField
          grid
          row={2}
          label="Graph lane width"
          value={shownLaneWidth}
          // Same font-derived floor as the line height.
          min={rowHeightMin}
          max={COMMITS_LANE_WIDTH_MAX}
          disabled={saving || linked}
          onCommit={(v) => save(effectiveRowHeight, v, dotRadius, lineWidth)}
        />
        <NumberField
          grid
          row={3}
          label="Commit dot radius"
          value={dotRadius}
          min={COMMITS_DOT_RADIUS_MIN}
          max={dotMax}
          disabled={saving}
          onCommit={(v) => save(effectiveRowHeight, effectiveLaneWidth, v, lineWidth)}
        />
        <NumberField
          grid
          row={4}
          label="Line width"
          value={lineWidth}
          min={COMMITS_LINE_WIDTH_MIN}
          max={lineMax}
          step={0.5}
          disabled={saving}
          onCommit={(v) => save(effectiveRowHeight, effectiveLaneWidth, dotRadius, v)}
        />
      </div>
      <SettingCheckbox
        id="global-commit-date-absolute"
        label="Show the full date in the Date column instead of relative time"
        checked={dateAbsolute}
        onChange={toggleDateAbsolute}
        disabled={savingDate}
        topGap="1em"
      />
      <div style={{ display: "flex", alignItems: "center", gap: "0.667em", marginTop: "0.667em" }}>
        <label htmlFor="global-commit-date-format" style={{ fontSize: "var(--fz-lg)" }}>
          Date format
        </label>
        <select
          id="global-commit-date-format"
          value={dateFormat}
          disabled={savingDate || !dateAbsolute}
          onChange={(e) => void selectDateFormat(e.target.value as CommitDateFormat)}
        >
          <option value="iso">{datePattern("iso")}</option>
          <option value="swiss">{datePattern("swiss")}</option>
          <option value="uk">{datePattern("uk")}</option>
          <option value="us">{datePattern("us")}</option>
        </select>
        <input
          type="checkbox"
          id="global-commit-date-show-time"
          checked={dateShowTime}
          onChange={toggleDateShowTime}
          disabled={savingDate || !dateAbsolute}
          style={{ marginLeft: "0.667em" }}
        />
        <label htmlFor="global-commit-date-show-time" style={{ fontSize: "var(--fz-lg)", cursor: "pointer" }}>
          Include the time of day
        </label>
      </div>
      <SettingCheckbox
        id="global-lane-colored-chips"
        label="Color branch chips by graph lane (chip shades come from the theme)"
        checked={laneChips}
        onChange={toggleLaneChips}
        disabled={savingLanes}
        topGap="1em"
      />
      <SettingCheckbox
        id="global-stash-base-lane"
        label="Color stashes by their base commit's lane"
        checked={stashBaseLane}
        onChange={toggleStashBaseLane}
        disabled={savingLanes}
      />
      <SettingCheckbox
        id="global-commit-avatars"
        label="Show author avatars (Gravatar) in the commit dots"
        checked={avatars}
        onChange={toggleAvatars}
        disabled={savingAvatars}
        topGap="1em"
      />
      <FieldNote>
        Privacy: when enabled, a hash of each author's email address is sent to
        gravatar.com to look up their avatar. Nothing is sent while this is off.
      </FieldNote>
      <SettingCheckbox
        id="global-commit-initials"
        label="Show author initials in the commit dots"
        checked={initials}
        onChange={toggleInitials}
        disabled={savingAvatars}
      />
      <FieldNote>
        Initials are computed locally; nothing is sent anywhere. With Gravatar
        avatars also on, initials appear only for authors without a Gravatar.
      </FieldNote>
    </Section>
  );
}
