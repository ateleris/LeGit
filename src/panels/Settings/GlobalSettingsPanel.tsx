import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { confirmDialog } from "../../store/confirm";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePanelFocusEffect, usePanelDirty } from "../PanelApiContext";
import { LinkIcon, UnlinkIcon, WarningIcon } from "../../icons";
import { Button, IconButton } from "../shared/buttons";
import { useDelayedBusy } from "../shared/useDelayedBusy";
import { useRowDragReorder } from "../shared/useRowDragReorder";
import { useDelayedFlag } from "../shared/useDelayedFlag";
import { useAppVersion } from "../../lib/appVersion";

/** localStorage key for the line-height ↔ lane-width link toggle (default on). */
const LANE_LINK_KEY = "legit.commits-lane-link";
import { formatAppError } from "../../lib/types";
import type { ConfigScope, LineEndingsView, PushRecurseMode, RegionPlacement, SwitchDirtyBehavior } from "../../lib/types";
import type { CommitDateFormat } from "../../lib/time";
import { coerceRefsSortMode, type RefsSortMode } from "../../lib/refSort";
import { globalLineEndingsView, globalWriteLineEndings, openLogDir, setLineEndingChipsInChanges, setWarnOnLineEndingCommit } from "../../lib/commands";
import { notify } from "../../store/notifications";
import { useGitStatusStore } from "../../store/git-status";
import { GlobalProfilesSection } from "./GlobalProfilesSection";
import { GlobalGitConfigSection } from "./GlobalGitConfigSection";
import { ConnectedAccountsSection } from "./ConnectedAccountsSection";
import { Section, Row, FieldNote, SettingsGroup, GitConfigPill } from "./primitives";
import { ALL_PANELS, SUPPRESSIBLE_SUMMON_PANELS } from "../registry";
import {
  orderedWorkingChangesSections,
  WORKING_CHANGES_SECTION_LABELS,
} from "../WorkingChanges/sectionOrder";
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
  UI_FONT_SIZE_MIN,
  UI_FONT_SIZE_MAX,
  maxCommitsDotRadius,
  maxCommitsLineWidth,
  minCommitsRowHeight,
} from "../../store/settings";

/** Global Settings panel — edits global-scope settings (DESIGN-v0.2.md §F.6). */
export function GlobalSettingsPanel() {
  const status = useGitStatusStore((s) => s.status);
  const pending = useGitStatusStore((s) => s.pending);
  const setPath = useGitStatusStore((s) => s.setPath);
  const refresh = useGitStatusStore((s) => s.refresh);
  const [draft, setDraft] = useState(status?.user_override ?? "");
  const [error, setError] = useState<string | null>(null);

  const browseFor = async () => {
    const selected = await openDialog({ multiple: false });
    if (typeof selected === "string") setDraft(selected);
  };

  const apply = async (path: string | null) => {
    setError(null);
    try {
      await setPath(path);
    } catch (e) {
      setError(formatAppError(e));
    }
  };

  return (
    <div className="legit-panel">
      <div className="legit-panel__body">
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "6px 14px",
            alignItems: "center",
            fontSize: "var(--fz-sm)",
            color: "var(--subtle-fg)",
            marginBottom: 18,
          }}
        >
          <span>Most settings apply instantly.</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <GitConfigPill /> items change your Git configuration.
          </span>
        </div>

        <SettingsGroup id="appearance" title="Appearance" caption="How LeGit looks">
          <GeneralSection />
          <CommitsGraphSection />
          <RefsSortSection />
          <DiffViewerSection />
          <WorkingChangesLayoutSection />
        </SettingsGroup>

        <SettingsGroup id="behavior" title="Behavior" caption="How LeGit acts">
          <AutoOpenPanelsSection />
          <ConfirmDiscardSection />
          <BranchCreationSection />
          <BranchSwitchingSection />
          <CheckoutRemoteFastForwardSection />
          <PushGuardSection />
          <AutoPushTagsSection />
          <SubmoduleAttachSection />
          <AutoRefreshSection />
          <AutoFetchSection />
          <ExternalEditorSection />
          <LineEndingChangesSection />
        </SettingsGroup>

        <SettingsGroup id="git" title="Git" caption="Integration & configuration">
          <Section title="Git executable (default for all repos)">
            {status ? (
              <>
                <Row label="Resolved path" value={<code>{status.resolved_path}</code>} />
                <Row
                  label="Version"
                  value={
                    status.version ? (
                      <code>{status.version.raw}</code>
                    ) : (
                      <span className="legit-error">{status.error ?? "(unknown)"}</span>
                    )
                  }
                />
                <Row
                  label="Minimum required"
                  value={
                    <code>
                      {status.minimum_required[0]}.{status.minimum_required[1]}.
                      {status.minimum_required[2]}
                    </code>
                  }
                />
                <Row
                  label="Meets minimum"
                  value={
                    status.meets_minimum ? (
                      <span className="legit-success">yes</span>
                    ) : (
                      <span className="legit-error">no</span>
                    )
                  }
                />
                <FieldNote>writes to: global settings</FieldNote>
                <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                  <input
                    style={{ flex: 1 }}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder="/usr/bin/git or leave blank for auto-detect"
                  />
                  <button onClick={browseFor}>Browse…</button>
                  <Button
                    variant="primary"
                    disabled={pending}
                    onClick={() => apply(draft.trim() === "" ? null : draft)}
                  >
                    Apply
                  </Button>
                  <button onClick={() => apply(null)} disabled={pending}>
                    Reset
                  </button>
                  <button onClick={() => refresh()} disabled={pending}>
                    Re-check
                  </button>
                </div>
                {error && <pre className="legit-error">{error}</pre>}
              </>
            ) : (
              <span className="legit-subtle">Probing git…</span>
            )}
          </Section>
          <ConnectedAccountsSection />
          <GlobalGitConfigSection />
          <LineEndingsGlobalSection />
          <GlobalProfilesSection />
        </SettingsGroup>

        <SettingsGroup id="about" title="About">
          <AboutSection />
        </SettingsGroup>
      </div>
    </div>
  );
}

function AboutSection() {
  const version = useAppVersion();
  const { busy, run } = useDelayedBusy();
  // Inline status next to the button (settings-form errors stay adjacent to
  // their input; only genuinely async surprises go to toasts).
  const [status, setStatus] = useState<{ error: boolean; text: string } | null>(null);

  const checkForUpdates = () =>
    void run(async () => {
      setStatus(null);
      try {
        const update = await check();
        if (!update) {
          setStatus({ error: false, text: "You are on the latest version." });
          return;
        }
        // Workflow prompt (decision after an async step): always shown,
        // deliberately NOT gated by the destructive-confirmation setting.
        const install = await confirmDialog({
          title: "Update available",
          message: `LeGit v${update.version} is available (you have v${version ?? "?"}). Download and install it now?`,
          confirmLabel: "Download & install",
          danger: false,
        });
        if (!install) {
          setStatus({ error: false, text: `v${update.version} is available - not installed.` });
          return;
        }
        let total = 0;
        let received = 0;
        await update.downloadAndInstall((e) => {
          if (e.event === "Started") {
            total = e.data.contentLength ?? 0;
            setStatus({ error: false, text: "Downloading…" });
          } else if (e.event === "Progress") {
            received += e.data.chunkLength;
            if (total > 0) {
              setStatus({ error: false, text: `Downloading… ${Math.round((received / total) * 100)}%` });
            }
          } else if (e.event === "Finished") {
            setStatus({ error: false, text: "Installing…" });
          }
        });
        setStatus({ error: false, text: `v${update.version} installed - restart to apply.` });
        const restart = await confirmDialog({
          title: "Restart LeGit",
          message: `LeGit v${update.version} is installed. Restart now to apply it?`,
          confirmLabel: "Restart now",
          cancelLabel: "Later",
          danger: false,
        });
        if (restart) await relaunch();
      } catch (e) {
        // Typical here: no network, no published release yet, or a .deb
        // install (the updater covers .msi/NSIS/.AppImage/.app only).
        setStatus({ error: true, text: `Update check failed: ${formatAppError(e)}` });
      }
    });

  return (
    <Section title="About">
      <Row label="LeGit" value={version ? `v${version}` : "…"} />
      <Row
        label="Logs"
        value={
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Button
              onClick={() => openLogDir().catch((e) => notify.error(formatAppError(e)))}
              title="Open the folder holding LeGit's log files (attach the newest one to a bug report)"
            >
              Open log folder
            </Button>
          </div>
        }
      />
      <Row
        label="Updates"
        value={
          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
            <Button onClick={checkForUpdates} disabled={busy}>
              {busy ? "Checking…" : "Check for updates"}
            </Button>
            {status && (
              <span
                style={{
                  fontSize: "var(--fz-sm)",
                  color: status.error ? "var(--status-deleted)" : "var(--subtle-fg)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {status.text}
              </span>
            )}
          </div>
        }
      />
    </Section>
  );
}

// Shared column widths so the control column lines up across the separate
// General and Commits-graph grids (both start at the same left origin, so
// identical label + gutter columns make their inputs/buttons align vertically).
// Em-based: they scale with the grids' --fz-lg font size.
const SETTINGS_LABEL_COL = "10.5em";
const SETTINGS_GUTTER_COL = "1.9em"; // matches the link IconButton width
const SETTINGS_GRID_COLS = `${SETTINGS_LABEL_COL} ${SETTINGS_GUTTER_COL} min-content max-content`;

function GeneralSection() {
  const placement = useSettingsStore((s) => s.settings?.global_region_placement ?? "top");
  const setRegionPlacement = useSettingsStore((s) => s.setRegionPlacement);
  const fontSize = useSettingsStore((s) => s.settings?.ui_font_size ?? UI_FONT_SIZE_DEFAULT);
  const setUiFontSize = useSettingsStore((s) => s.setUiFontSize);
  const { busy: saving, run } = useDelayedBusy();

  const selectPlacement = (p: RegionPlacement) => {
    if (p === placement) return;
    void run(() => setRegionPlacement(p));
  };

  const saveFont = (v: number) => run(() => setUiFontSize(v));

  return (
    <Section title="General">
      <FieldNote>writes to: global settings — base UI size &amp; dock placement for all panels</FieldNote>
      <div
        style={{
          display: "grid",
          // label · gutter · control · range — shared shape/widths with Commits
          // graph so the control column aligns across the two sections.
          gridTemplateColumns: SETTINGS_GRID_COLS,
          gap: "6px 10px",
          alignItems: "center",
          marginTop: 8,
          width: "fit-content",
          fontSize: "var(--fz-lg)",
        }}
      >
        <span className="legit-subtle" style={{ gridColumn: 1, gridRow: 1, whiteSpace: "nowrap" }}>Layout orientation</span>
        <div style={{ gridColumn: "3 / -1", gridRow: 1, display: "flex", gap: 8 }}>
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
      </div>
      {fontSize !== UI_FONT_SIZE_DEFAULT && (
        <div style={{ marginTop: 10 }}>
          <button disabled={saving} onClick={() => saveFont(UI_FONT_SIZE_DEFAULT)}>
            Reset font size to default
          </button>
        </div>
      )}
    </Section>
  );
}

function CommitsGraphSection() {
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
  const { busy: savingAvatars, run: runAvatars } = useDelayedBusy();
  const toggleAvatars = () => runAvatars(() => setCommitAvatars(!avatars));

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
      <FieldNote>writes to: global settings — affects the Commits panel for all repos</FieldNote>
      <div
        style={{
          display: "grid",
          // label · link-gutter · input · range — shared widths with General
          // (see SETTINGS_GRID_COLS) so the input column aligns across sections.
          gridTemplateColumns: SETTINGS_GRID_COLS,
          gap: "6px 10px",
          alignItems: "center",
          marginTop: 8,
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
        {/* Chain-link spanning the two inputs it governs (rows 1–2), in the
            gutter column just left of the inputs — Photoshop style. */}
        <IconButton
          aria-pressed={linked}
          title={
            linked
              ? "Linked: lane width follows line height — click to set it separately"
              : "Unlinked: lane width is set separately — click to link it to line height"
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
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12 }}>
        <input
          type="checkbox"
          id="global-commit-date-absolute"
          checked={dateAbsolute}
          onChange={toggleDateAbsolute}
          disabled={savingDate}
        />
        <label htmlFor="global-commit-date-absolute" style={{ fontSize: "var(--fz-lg)", cursor: "pointer" }}>
          Show the full date in the Date column instead of relative time
        </label>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
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
          style={{ marginLeft: 8 }}
        />
        <label htmlFor="global-commit-date-show-time" style={{ fontSize: "var(--fz-lg)", cursor: "pointer" }}>
          Include the time of day
        </label>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12 }}>
        <input
          type="checkbox"
          id="global-commit-avatars"
          checked={avatars}
          onChange={toggleAvatars}
          disabled={savingAvatars}
        />
        <label htmlFor="global-commit-avatars" style={{ fontSize: "var(--fz-lg)", cursor: "pointer" }}>
          Show author avatars (Gravatar) in the commit dots
        </label>
      </div>
      <FieldNote>
        Privacy: when enabled, a hash of each author's email address is sent to
        gravatar.com to look up their avatar. Nothing is sent while this is off.
      </FieldNote>
    </Section>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  step = 1,
  disabled,
  onCommit,
  grid = false,
  row,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  /** Rounding granularity for committed values. Defaults to whole numbers. */
  step?: number;
  disabled?: boolean;
  onCommit: (value: number) => void;
  /** Render as grid cells (label · input · range) via `display: contents`, so
   *  multiple fields align in a shared grid. Cells are placed at explicit
   *  columns 1/3/4 (column 2 is a gutter the caller uses for the link toggle). */
  grid?: boolean;
  /** 1-based grid row for this field's cells (grid mode). */
  row?: number;
}) {
  // Local draft so typing doesn't clamp/persist mid-edit.
  const [draft, setDraft] = useState(String(value));
  const inputRef = useRef<HTMLInputElement>(null);

  // Keep the field in sync when the stored value changes elsewhere (e.g. Reset).
  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = (raw: string) => {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const snapped = Math.round(parsed / step) * step;
    const clamped = Math.min(max, Math.max(min, snapped));
    setDraft(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };

  // Commit on the native `change` event: it fires when the spinner arrows step
  // the value (so it applies immediately) and on blur/Enter, but not on every
  // typed keystroke — those only fire `input` (React onChange) and update the
  // draft. Reads `el.value` directly since the draft state update is async.
  const commitRef = useRef(commit);
  commitRef.current = commit;
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const onChangeNative = () => commitRef.current(el.value);
    el.addEventListener("change", onChangeNative);
    return () => el.removeEventListener("change", onChangeNative);
  }, []);

  const input = (
    <input
      ref={inputRef}
      type="number"
      min={min}
      max={max}
      step={step}
      value={draft}
      disabled={disabled}
      style={{ width: grid ? "5em" : 72, ...(grid ? { gridColumn: 3, gridRow: row } : {}) }}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );
  const range = (
    <span
      className="legit-subtle"
      style={{
        fontSize: "var(--fz-sm)",
        fontVariantNumeric: "tabular-nums",
        ...(grid ? { gridColumn: 4, gridRow: row } : {}),
      }}
    >
      px ({min}–{max})
    </span>
  );

  if (grid) {
    // Cells participate in the parent grid at explicit columns (label 1,
    // input 3, range 4; column 2 is a gutter the caller uses for the link
    // toggle) so all fields align regardless of label length.
    return (
      <label style={{ display: "contents" }}>
        <span className="legit-subtle" style={{ gridColumn: 1, gridRow: row }}>{label}</span>
        {input}
        {range}
      </label>
    );
  }

  return (
    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "var(--fz-lg)" }}>
      <span className="legit-subtle">{label}</span>
      {input}
      {range}
    </label>
  );
}

function DiffViewerSection() {
  const enabled = useSettingsStore((s) => s.settings?.diff_syntax_highlighting ?? false);
  const setDiffSyntaxHighlighting = useSettingsStore((s) => s.setDiffSyntaxHighlighting);
  const { busy: saving, run } = useDelayedBusy();

  const toggle = () => run(() => setDiffSyntaxHighlighting(!enabled));

  return (
    <Section title="Diff viewer">
      <FieldNote>writes to: global settings — applies to all repos</FieldNote>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
        <input
          type="checkbox"
          id="global-diff-syntax"
          checked={enabled}
          onChange={toggle}
          disabled={saving}
        />
        <label htmlFor="global-diff-syntax" style={{ fontSize: "var(--fz-lg)", cursor: "pointer" }}>
          Syntax-highlight code in diffs and file views
        </label>
      </div>
      <FieldNote>
        Colours come from the theme's Syntax tokens. Each hunk is highlighted on
        its own, so constructs opened outside the visible context may colour
        imperfectly. Very large diffs are skipped.
      </FieldNote>
    </Section>
  );
}

/** Stable empty default so the store selector doesn't return a fresh array. */
const EMPTY_PANELS: string[] = [];

function AutoOpenPanelsSection() {
  const suppressed = useSettingsStore(
    (s) => s.settings?.suppressed_auto_open_panels ?? EMPTY_PANELS,
  );
  const setSuppressed = useSettingsStore((s) => s.setSuppressedAutoOpenPanels);
  const { busy: saving, run } = useDelayedBusy();

  const titleFor = (id: string) => ALL_PANELS.find((p) => p.id === id)?.title ?? id;

  const toggle = (id: string, autoOpen: boolean) => {
    // autoOpen = keep it in the auto-open set (not suppressed).
    const next = autoOpen
      ? suppressed.filter((p) => p !== id)
      : suppressed.includes(id)
        ? suppressed
        : [...suppressed, id];
    return run(() => setSuppressed(next));
  };

  return (
    <Section title="Auto-open panels">
      <FieldNote>writes to: global settings — applies to all repos</FieldNote>
      <FieldNote>
        When you click a commit, file, or hunk, LeGit opens the matching detail
        panel. Uncheck one to stop it popping open — it still updates live when
        you already have it open.
      </FieldNote>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 8 }}>
        {SUPPRESSIBLE_SUMMON_PANELS.map((id) => {
          const autoOpen = !suppressed.includes(id);
          return (
            <label
              key={id}
              style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "var(--fz-lg)", cursor: "pointer" }}
            >
              <input
                type="checkbox"
                checked={autoOpen}
                disabled={saving}
                onChange={() => toggle(id, !autoOpen)}
              />
              {titleFor(id)}
            </label>
          );
        })}
      </div>
    </Section>
  );
}

function WorkingChangesLayoutSection() {
  const savedOrder = orderedWorkingChangesSections(
    useSettingsStore((s) => s.settings?.working_changes_section_order),
  );
  const setOrder = useSettingsStore((s) => s.setWorkingChangesSectionOrder);
  const { busy: saving, run } = useDelayedBusy();
  // Live order during a drag (null = idle); the setting is written ONCE on
  // release, not per reorder step.
  const [liveOrder, setLiveOrder] = useState<string[] | null>(null);
  const order = (liveOrder ?? savedOrder) as typeof savedOrder;
  const listRef = useRef<HTMLDivElement | null>(null);
  const { draggingKey, dragY, registerItem, beginDrag } = useRowDragReorder({
    container: listRef,
    order,
    onReorder: setLiveOrder,
    onDrop: (next, changed) => {
      setLiveOrder(null);
      if (changed) void run(() => setOrder(next as typeof savedOrder));
    },
    disabled: saving,
  });

  const move = (i: number, delta: number) => {
    const j = i + delta;
    if (j < 0 || j >= order.length) return;
    const next = [...order];
    [next[i], next[j]] = [next[j], next[i]];
    return run(() => setOrder(next));
  };

  return (
    <Section title="Working Changes layout">
      <FieldNote>writes to: global settings — applies to all repos</FieldNote>
      <FieldNote>
        Top-to-bottom order of the three Working Changes sections. Drag rows
        (or use the arrows) to put Staged first, or move the commit box to
        the top.
      </FieldNote>
      <div
        ref={listRef}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 4,
          marginTop: 8,
          // Row offsets resolve against this container (drag math).
          position: "relative",
        }}
      >
        {order.map((id, i) => (
          <div
            key={id}
            ref={registerItem(id)}
            onPointerDown={(e) => beginDrag(e, id)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              // Same metrics as the global `button` base (settings-body
              // buttons like Top/Bottom - Left/Right): --fz-lg text,
              // line-height 1.4, 4px vertical padding, radius 4 - so the
              // rows sit at exactly the neighbouring controls' height.
              fontSize: "var(--fz-lg)",
              lineHeight: 1.4,
              border: "1px solid var(--panel-border)",
              borderRadius: 4,
              padding: "4px 8px",
              background: "var(--panel-bg)",
              // Rows are drag handles (same fix as the repo tabs).
              userSelect: "none",
              cursor: saving ? undefined : draggingKey === id ? "grabbing" : "grab",
              transform: draggingKey === id ? `translateY(${dragY}px)` : undefined,
              zIndex: draggingKey === id ? 1 : undefined,
              boxShadow: draggingKey === id ? "0 2px 8px var(--shadow-color)" : undefined,
              position: "relative",
            }}
          >
            <span style={{ display: "flex", gap: 2 }}>
              <IconButton title="Move up" disabled={saving || i === 0} onClick={() => move(i, -1)}>
                ↑
              </IconButton>
              <IconButton title="Move down" disabled={saving || i === order.length - 1} onClick={() => move(i, 1)}>
                ↓
              </IconButton>
            </span>
            <span style={{ width: "1.5em", textAlign: "right", color: "var(--subtle-fg)" }}>{i + 1}.</span>
            <span>{WORKING_CHANGES_SECTION_LABELS[id]}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}

function AutoRefreshSection() {
  const enabled = useSettingsStore((s) => s.settings?.watcher_enabled ?? true);
  const setWatcherEnabled = useSettingsStore((s) => s.setWatcherEnabled);
  const { busy: saving, run } = useDelayedBusy();

  const toggle = () => run(() => setWatcherEnabled(!enabled));

  return (
    <Section title="Auto-refresh">
      <FieldNote>writes to: global settings — applies to all open repos immediately</FieldNote>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
        <input
          type="checkbox"
          id="global-watcher-enabled"
          checked={enabled}
          onChange={toggle}
          disabled={saving}
        />
        <label htmlFor="global-watcher-enabled" style={{ fontSize: "var(--fz-lg)", cursor: "pointer" }}>
          Watch the filesystem and refresh automatically on changes
        </label>
      </div>
      <FieldNote>
        When off, the UI refreshes only when a panel or the window regains focus.
      </FieldNote>
    </Section>
  );
}

function AutoFetchSection() {
  const enabled = useSettingsStore((s) => s.settings?.auto_fetch_enabled ?? false);
  const minutes = useSettingsStore((s) => s.settings?.auto_fetch_interval_minutes ?? 15);
  const setAutoFetchEnabled = useSettingsStore((s) => s.setAutoFetchEnabled);
  const setAutoFetchIntervalMinutes = useSettingsStore((s) => s.setAutoFetchIntervalMinutes);
  const { busy: saving, run } = useDelayedBusy();
  const [draft, setDraft] = useState(String(minutes));

  // Follow external changes to the stored value (e.g. settings re-init).
  useEffect(() => setDraft(String(minutes)), [minutes]);

  const toggle = () => run(() => setAutoFetchEnabled(!enabled));

  const commitMinutes = () => {
    const parsed = Math.round(Number(draft));
    if (!Number.isFinite(parsed) || parsed < 1) {
      setDraft(String(minutes));
      return;
    }
    if (parsed === minutes) {
      setDraft(String(parsed));
      return;
    }
    return run(() => setAutoFetchIntervalMinutes(parsed));
  };

  return (
    <Section title="Background auto-fetch">
      <FieldNote>writes to: global settings — fetch-only, never pulls or merges</FieldNote>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
        <input
          type="checkbox"
          id="global-auto-fetch"
          checked={enabled}
          onChange={toggle}
          disabled={saving}
        />
        <label htmlFor="global-auto-fetch" style={{ fontSize: "var(--fz-lg)", cursor: "pointer" }}>
          Periodically fetch the active repository's remotes
        </label>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
        <label htmlFor="global-auto-fetch-interval" style={{ fontSize: "var(--fz-lg)" }}>
          Interval (minutes)
        </label>
        <input
          type="number"
          id="global-auto-fetch-interval"
          min={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitMinutes}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitMinutes();
          }}
          disabled={!enabled || saving}
          style={{ width: "5em" }}
        />
      </div>
      <FieldNote>
        Runs quietly in the background: no popups, and the view only refreshes
        when something actually changed. Skipped while the app is hidden,
        offline, or an operation is in progress; paused for the session after
        an authentication failure.
      </FieldNote>
    </Section>
  );
}

function ExternalEditorSection() {
  const stored = useSettingsStore((s) => s.settings?.external_editor_command ?? "");
  const setExternalEditorCommand = useSettingsStore((s) => s.setExternalEditorCommand);
  const [draft, setDraft] = useState(stored ?? "");
  const { busy: saving, run } = useDelayedBusy();

  // Follow external changes to the stored value (e.g. settings re-init).
  useEffect(() => setDraft(stored ?? ""), [stored]);

  const commit = () => {
    const normalized = draft.trim();
    if (normalized === (stored ?? "").trim()) return;
    return run(() => setExternalEditorCommand(normalized === "" ? null : draft));
  };

  const placeholder =
    navigator.platform.toLowerCase().includes("mac")
      ? 'e.g. code "$ROOT"  or  /Applications/Sublime Text.app/Contents/SharedSupport/bin/subl'
      : 'e.g. code "$ROOT"';

  return (
    <Section title="External editor">
      <FieldNote>writes to: global settings</FieldNote>
      <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
        <input
          style={{ flex: 1 }}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
          }}
          placeholder={placeholder}
          disabled={saving}
        />
      </div>
      <FieldNote>
        Command used by "Open in editor" on a repository or a file.{" "}
        <code>$ROOT</code> is replaced by the repository path and{" "}
        <code>$FILE</code> by the file path (appended if the template doesn't
        mention them); quote them against spaces. Leave blank to use the
        system file manager instead.
      </FieldNote>
    </Section>
  );
}

function RefsSortSection() {
  const mode = coerceRefsSortMode(useSettingsStore((s) => s.settings?.refs_sort_mode));
  const setRefsSortMode = useSettingsStore((s) => s.setRefsSortMode);
  const { busy: saving, run } = useDelayedBusy();

  const select = (next: RefsSortMode) => run(() => setRefsSortMode(next));

  return (
    <Section title="Refs sorting">
      <FieldNote>writes to: global settings — applies to all repos</FieldNote>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
        <label htmlFor="global-refs-sort-mode" style={{ fontSize: "var(--fz-lg)" }}>
          Sort branches and tags by
        </label>
        <select
          id="global-refs-sort-mode"
          value={mode}
          disabled={saving}
          onChange={(e) => void select(e.target.value as RefsSortMode)}
        >
          <option value="alphabetical">Name (alphabetical)</option>
          <option value="date">Date (newest first)</option>
          <option value="date_reversed">Date (oldest first)</option>
        </select>
      </div>
      <FieldNote>
        Applies to the Branches and Tags lists in the Refs panel. Stashes keep
        their newest-first order.
      </FieldNote>
    </Section>
  );
}

function BranchCreationSection() {
  const enabled = useSettingsStore((s) => s.settings?.checkout_new_branch ?? true);
  const setCheckoutNewBranch = useSettingsStore((s) => s.setCheckoutNewBranch);
  const { busy: saving, run } = useDelayedBusy();

  const toggle = () => run(() => setCheckoutNewBranch(!enabled));

  return (
    <Section title="Branch creation">
      <FieldNote>writes to: global settings — applies to all repos</FieldNote>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
        <input
          type="checkbox"
          id="global-checkout-new-branch"
          checked={enabled}
          onChange={toggle}
          disabled={saving}
        />
        <label htmlFor="global-checkout-new-branch" style={{ fontSize: "var(--fz-lg)", cursor: "pointer" }}>
          Check out a newly created branch immediately
        </label>
      </div>
      <FieldNote>
        Applies to the Commits panel's inline create and the Branches
        section's form. When the new branch starts at another commit, the
        checkout follows the "Branch switching" behavior below for uncommitted
        changes. "Branch from stash" always checks out.
      </FieldNote>
    </Section>
  );
}

function ConfirmDiscardSection() {
  const confirm = useSettingsStore((s) => s.settings?.confirm_discard ?? true);
  const setConfirmDiscard = useSettingsStore((s) => s.setConfirmDiscard);
  const { busy: saving, run } = useDelayedBusy();

  const toggle = () => run(() => setConfirmDiscard(!confirm));

  return (
    <Section title="Destructive action confirmation">
      <FieldNote>writes to: global settings — applies to all repos</FieldNote>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
        <input
          type="checkbox"
          id="global-confirm-discard"
          checked={confirm}
          onChange={toggle}
          disabled={saving}
        />
        <label htmlFor="global-confirm-discard" style={{ fontSize: "var(--fz-lg)", cursor: "pointer" }}>
          Ask for confirmation before destructive actions
        </label>
      </div>
      <FieldNote>
        Covers discarding changes, deleting branches, dropping stashes, and
        removing remotes or themes. When off, these run immediately without a
        prompt.
      </FieldNote>
    </Section>
  );
}

function CheckoutRemoteFastForwardSection() {
  const enabled = useSettingsStore((s) => s.settings?.checkout_remote_fast_forward ?? true);
  const setCheckoutRemoteFastForward = useSettingsStore((s) => s.setCheckoutRemoteFastForward);
  const { busy: saving, run } = useDelayedBusy();

  const toggle = () => run(() => setCheckoutRemoteFastForward(!enabled));

  return (
    <Section title="Remote branch checkout">
      <FieldNote>writes to: global settings (applies to all repos)</FieldNote>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
        <input
          type="checkbox"
          id="global-checkout-remote-ff"
          checked={enabled}
          onChange={toggle}
          disabled={saving}
        />
        <label htmlFor="global-checkout-remote-ff" style={{ fontSize: "var(--fz-lg)", cursor: "pointer" }}>
          Fast-forward the local branch when checking out a remote branch
        </label>
      </div>
      <FieldNote>
        Checking out a remote branch (double-clicking its chip, or the context
        menu) switches to the local branch and moves it up to date with the
        remote tip. Purely local (fast-forward only, no network): if local and
        remote have diverged, the branch is left as-is and a toast says so.
        When off, checkout leaves a stale local branch where it was.
      </FieldNote>
    </Section>
  );
}

function SubmoduleAttachSection() {
  const enabled = useSettingsStore((s) => s.settings?.submodule_attach_branch ?? false);
  const setSubmoduleAttachBranch = useSettingsStore((s) => s.setSubmoduleAttachBranch);
  const { busy: saving, run } = useDelayedBusy();

  const toggle = () => run(() => setSubmoduleAttachBranch(!enabled));

  return (
    <Section title="Submodule branch attach">
      <FieldNote>writes to: global settings (applies to all repos)</FieldNote>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
        <input
          type="checkbox"
          id="global-submodule-attach"
          checked={enabled}
          onChange={toggle}
          disabled={saving}
        />
        <label htmlFor="global-submodule-attach" style={{ fontSize: "var(--fz-lg)", cursor: "pointer" }}>
          Attach submodule HEAD to its branch after updates
        </label>
      </div>
      <FieldNote>
        When a submodule update lands on a commit that a branch already points
        at (the tracked branch, or a single matching local branch), check out
        that branch instead of leaving a detached HEAD. The submodule then
        follows the branch, so its recorded pointer shows as changed when the
        branch moves.
      </FieldNote>
    </Section>
  );
}

function PushGuardSection() {
  const mode = useSettingsStore((s) => s.settings?.push_recurse_submodules ?? null);
  const setPushRecurseSubmodules = useSettingsStore((s) => s.setPushRecurseSubmodules);
  const { busy: saving, run } = useDelayedBusy();

  const select = (m: PushRecurseMode | null) => {
    if (m === mode) return;
    return run(() => setPushRecurseSubmodules(m));
  };

  return (
    <Section title="Submodule push guard">
      <FieldNote>writes to: global settings — applies to all repos</FieldNote>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: saving ? "default" : "pointer" }}>
          <input type="radio" checked={mode === null} onChange={() => select(null)} disabled={saving} />
          <span style={{ fontSize: "var(--fz-lg)" }}>Off</span>
          <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)" }}>
            — pushes never look at submodules (git default)
          </span>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: saving ? "default" : "pointer" }}>
          <input type="radio" checked={mode === "check"} onChange={() => select("check")} disabled={saving} />
          <span style={{ fontSize: "var(--fz-lg)" }}>Check</span>
          <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)" }}>
            — block the push when it references submodule commits that exist on no remote
          </span>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: saving ? "default" : "pointer" }}>
          <input type="radio" checked={mode === "on_demand"} onChange={() => select("on_demand")} disabled={saving} />
          <span style={{ fontSize: "var(--fz-lg)" }}>On demand</span>
          <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)" }}>
            — push the needed submodule branches first, then the superproject
          </span>
        </label>
      </div>
    </Section>
  );
}

function AutoPushTagsSection() {
  const enabled = useSettingsStore((s) => s.settings?.auto_push_tags ?? false);
  const setAutoPushTags = useSettingsStore((s) => s.setAutoPushTags);
  const { busy: saving, run } = useDelayedBusy();

  const toggle = () => run(() => setAutoPushTags(!enabled));

  return (
    <Section title="Auto-push tags">
      <FieldNote>writes to: global settings — applies to all repos (repo-overridable)</FieldNote>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
        <input
          type="checkbox"
          id="global-auto-push-tags"
          checked={enabled}
          onChange={toggle}
          disabled={saving}
        />
        <label htmlFor="global-auto-push-tags" style={{ fontSize: "var(--fz-lg)", cursor: "pointer" }}>
          Push tags with their commit automatically
        </label>
      </div>
      <FieldNote>
        Pushing a branch also pushes the tags whose commits became public
        through that push, and a tag created on an already-pushed commit is
        pushed immediately. Off by default: tag pushes commonly trigger CI
        release pipelines, and removing a published tag is a separate,
        deliberate action. Tags never overwrite a same-named tag on the
        remote; older local-only tags are never swept along.
      </FieldNote>
    </Section>
  );
}

function BranchSwitchingSection() {
  const behavior = useSettingsStore(
    (s) => s.settings?.switch_dirty_behavior ?? "try_directly",
  );
  const setSwitchDirtyBehavior = useSettingsStore((s) => s.setSwitchDirtyBehavior);
  const { busy: saving, run } = useDelayedBusy();

  const select = (b: SwitchDirtyBehavior) => {
    if (b === behavior) return;
    return run(() => setSwitchDirtyBehavior(b));
  };

  return (
    <Section title="Branch switching">
      <FieldNote>writes to: global settings — applies to all repos</FieldNote>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            cursor: saving ? "default" : "pointer",
          }}
        >
          <input
            type="radio"
            checked={behavior === "try_directly"}
            onChange={() => select("try_directly")}
            disabled={saving}
          />
          <span style={{ fontSize: "var(--fz-lg)" }}>Try switching directly</span>
          <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)" }}>
            — git decides; fails with an error if the working tree conflicts
          </span>
        </label>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            cursor: saving ? "default" : "pointer",
          }}
        >
          <input
            type="radio"
            checked={behavior === "auto_stash"}
            onChange={() => select("auto_stash")}
            disabled={saving}
          />
          <span style={{ fontSize: "var(--fz-lg)" }}>Auto-stash, then switch</span>
          <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)" }}>
            — stashes changes, switches branch, then pops the stash (changes travel along)
          </span>
        </label>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            cursor: saving ? "default" : "pointer",
          }}
        >
          <input
            type="radio"
            checked={behavior === "stash_and_keep"}
            onChange={() => select("stash_and_keep")}
            disabled={saving}
          />
          <span style={{ fontSize: "var(--fz-lg)" }}>Auto-stash and keep stashed</span>
          <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)" }}>
            — stashes changes and leaves them parked; the new branch starts clean
          </span>
        </label>
      </div>
    </Section>
  );
}

function LineEndingChangesSection() {
  const chips = useSettingsStore((s) => s.settings?.line_ending_chips_in_changes ?? true);
  const warn = useSettingsStore((s) => s.settings?.warn_on_line_ending_commit ?? true);
  const { busy: saving, run } = useDelayedBusy();

  const toggle = (key: "chips" | "warn") =>
    run(async () => {
      if (key === "chips") {
        await setLineEndingChipsInChanges(!chips);
        useSettingsStore.setState((s) =>
          s.settings ? { settings: { ...s.settings, line_ending_chips_in_changes: !chips } } : {}
        );
      } else {
        await setWarnOnLineEndingCommit(!warn);
        useSettingsStore.setState((s) =>
          s.settings ? { settings: { ...s.settings, warn_on_line_ending_commit: !warn } } : {}
        );
      }
    });

  return (
    <Section title="Line ending changes">
      <FieldNote>writes to: global settings — default for all repos</FieldNote>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
        <input
          type="checkbox"
          id="global-eol-chips"
          checked={chips}
          onChange={() => toggle("chips")}
          disabled={saving}
        />
        <label htmlFor="global-eol-chips" style={{ fontSize: "var(--fz-lg)", cursor: "pointer" }}>
          Show line-ending change chips on Working Changes files
        </label>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
        <input
          type="checkbox"
          id="global-eol-warn"
          checked={warn}
          onChange={() => toggle("warn")}
          disabled={saving}
        />
        <label htmlFor="global-eol-warn" style={{ fontSize: "var(--fz-lg)", cursor: "pointer" }}>
          Warn when committing files whose line endings change
        </label>
      </div>
    </Section>
  );
}

function LineEndingsGlobalSection() {
  const [view, setView] = useState<LineEndingsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [draftAutocrlf, setDraftAutocrlf] = useState<string | null>(null);
  const [draftEol, setDraftEol] = useState<string | null>(null);
  const { busy: saving, run } = useDelayedBusy();
  const [error, setError] = useState<string | null>(null);
  const [confirmPending, setConfirmPending] = useState(false);
  // Debounced loading indicator: fast loads never flash "Loading…".
  const showLoading = useDelayedFlag(loading);

  const load = useCallback(() => {
    setLoading(true);
    globalLineEndingsView()
      .then((v) => {
        setView(v);
        setDraftAutocrlf(v.autocrlf_global.value ?? null);
        setDraftEol(v.eol_global.value ?? null);
      })
      .catch((e) => setError(formatAppError(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);
  usePanelFocusEffect(load);

  const dirty = view !== null && (
    draftAutocrlf !== (view.autocrlf_global.value ?? null) ||
    draftEol !== (view.eol_global.value ?? null)
  );

  usePanelDirty(dirty);

  if (loading) {
    return (
      <Section title="Line endings (global)" scope="git">
        {showLoading && <span className="legit-subtle">Loading…</span>}
      </Section>
    );
  }
  if (!view) return null;

  const changes = getChangedValues(
    { autocrlf: view.autocrlf_global.value, eol: view.eol_global.value },
    { autocrlf: draftAutocrlf, eol: draftEol }
  );

  const handleSave = () => setConfirmPending(true);

  const handleConfirm = () =>
    run(async () => {
      setConfirmPending(false);
      setError(null);
      try {
        const updated = await globalWriteLineEndings(draftAutocrlf, draftEol);
        setView(updated);
        setDraftAutocrlf(updated.autocrlf_global.value ?? null);
        setDraftEol(updated.eol_global.value ?? null);
      } catch (e) {
        setError(formatAppError(e));
      }
    });

  const handleCancel = () => {
    setDraftAutocrlf(view.autocrlf_global.value ?? null);
    setDraftEol(view.eol_global.value ?? null);
  };

  return (
    <Section title="Line endings (global)" scope="git">
      <FieldNote>writes to: ~/.gitconfig — affects all repos that don't override these values</FieldNote>

      <div style={{ marginTop: 10 }}>
        <ConfigRow label="core.autocrlf">
          <RadioGroup
            name="global-autocrlf"
            value={draftAutocrlf}
            options={AUTOCRLF_OPTIONS}
            onChange={setDraftAutocrlf}
          />
          <ResolvedBadge label="system" value={view.autocrlf_system.value} source={view.autocrlf_system.source} />
          <ResolvedBadge label="resolved" value={view.autocrlf_resolved.value} source={view.autocrlf_resolved.source} isResolved />
        </ConfigRow>

        <ConfigRow label="core.eol">
          <RadioGroup
            name="global-eol"
            value={draftEol}
            options={EOL_OPTIONS}
            onChange={setDraftEol}
          />
          <ResolvedBadge label="system" value={view.eol_system.value} source={view.eol_system.source} />
          <ResolvedBadge label="resolved" value={view.eol_resolved.value} source={view.eol_resolved.source} isResolved />
        </ConfigRow>
      </div>

      {confirmPending && (
        <div style={{ marginTop: 10, padding: "10px 12px", background: "var(--button-hover-bg)", border: "1px solid var(--panel-border)", borderRadius: 4 }}>
          <div style={{ fontWeight: 600, marginBottom: 6, color: "var(--error-fg)", display: "flex", alignItems: "center", gap: 6 }}>
            <WarningIcon /> Save line-ending changes to your global Git config (~/.gitconfig)?
          </div>
          <div style={{ marginBottom: 8, fontSize: "var(--fz-md)" }}>
            {changes.map((c) => (
              <div key={c.key} style={{ fontFamily: "monospace" }}>
                <code>{c.key}</code>: <code>{c.before ?? "unset"}</code> → <code>{c.after ?? "unset"}</code>
              </div>
            ))}
          </div>
          <div style={{ fontSize: "var(--fz-md)", color: "var(--subtle-fg)", marginBottom: 10 }}>
            These changes affect every Git repository on this machine that doesn't override these values locally,
            and every tool that reads your global Git config — terminal git, other GUIs, CI scripts, IDE integrations.
            If you only want this for one repo, cancel and edit that repo's settings instead.
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <Button variant="primary" onClick={handleConfirm} disabled={saving}>Save globally</Button>
            <button onClick={() => setConfirmPending(false)}>Cancel</button>
          </div>
        </div>
      )}

      {!confirmPending && (
        <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
          <Button variant="primary" disabled={!dirty || saving} onClick={handleSave}>
            Save
          </Button>
          <button disabled={!dirty || saving} onClick={handleCancel}>
            Cancel
          </button>
        </div>
      )}

      {error && <pre className="legit-error" style={{ marginTop: 6 }}>{error}</pre>}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const AUTOCRLF_OPTIONS: { label: string; value: string | null }[] = [
  { label: "true", value: "true" },
  { label: "input", value: "input" },
  { label: "false", value: "false" },
  { label: "Inherit", value: null },
];

const EOL_OPTIONS: { label: string; value: string | null }[] = [
  { label: "lf", value: "lf" },
  { label: "crlf", value: "crlf" },
  { label: "native", value: "native" },
  { label: "Inherit", value: null },
];

interface ChangeItem { key: string; before: string | null; after: string | null }

function getChangedValues(
  before: { autocrlf: string | null; eol: string | null },
  after: { autocrlf: string | null; eol: string | null }
): ChangeItem[] {
  const result: ChangeItem[] = [];
  if (before.autocrlf !== after.autocrlf) {
    result.push({ key: "core.autocrlf", before: before.autocrlf, after: after.autocrlf });
  }
  if (before.eol !== after.eol) {
    result.push({ key: "core.eol", before: before.eol, after: after.eol });
  }
  return result;
}

function scopeLabel(scope: ConfigScope): string {
  switch (scope) {
    case "local": return "local";
    case "global": return "global";
    case "system": return "system";
    default: return "";
  }
}

function RadioGroup({
  name,
  value,
  options,
  onChange,
  disabled,
}: {
  name: string;
  value: string | null;
  options: { label: string; value: string | null }[];
  onChange: (v: string | null) => void;
  disabled?: boolean;
}) {
  return (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
      {options.map((opt) => (
        <label key={opt.label} style={{ display: "flex", alignItems: "center", gap: 4, cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.5 : 1 }}>
          <input
            type="radio"
            name={name}
            checked={value === opt.value}
            onChange={() => onChange(opt.value)}
            disabled={disabled}
          />
          <code style={{ fontSize: "var(--fz-md)" }}>{opt.label}</code>
        </label>
      ))}
    </div>
  );
}

function ConfigRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: "var(--fz-md)", fontFamily: "monospace", color: "var(--subtle-fg)", marginBottom: 4 }}>{label}</div>
      <div style={{ paddingLeft: 8 }}>{children}</div>
    </div>
  );
}

function ResolvedBadge({
  label,
  value,
  source,
  isResolved,
}: {
  label: string;
  value: string | null;
  source: ConfigScope;
  isResolved?: boolean;
}) {
  if (!value) return null;
  const fromLabel = source !== "unset" ? ` (from ${scopeLabel(source)})` : "";
  return (
    <div style={{ marginTop: 4, fontSize: "var(--fz-sm)", color: isResolved ? "var(--success-fg)" : "var(--subtle-fg)" }}>
      {label}: <code>{value}</code>{fromLabel}
    </div>
  );
}

