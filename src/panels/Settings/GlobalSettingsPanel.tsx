import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePanelFocusEffect, usePanelDirty } from "../PanelApiContext";
import { LinkIcon, UnlinkIcon, WarningIcon } from "../../icons";
import { IconButton } from "../shared/buttons";
import { useAppVersion } from "../../lib/appVersion";

/** localStorage key for the line-height ↔ lane-width link toggle (default on). */
const LANE_LINK_KEY = "legit.commits-lane-link";
import { formatAppError } from "../../lib/types";
import type { ConfigScope, LineEndingsView, RegionPlacement, SwitchDirtyBehavior } from "../../lib/types";
import { globalLineEndingsView, globalWriteLineEndings, setWarnOnMixedEndings } from "../../lib/commands";
import { useGitStatusStore } from "../../store/git-status";
import { SigningSettings } from "./SigningSettings";
import { GlobalProfilesSection } from "./GlobalProfilesSection";
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
      <div className="legit-panel__toolbar">
        <strong>Global Settings (this LeGit install)</strong>
      </div>
      <div className="legit-panel__body">
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
                <button
                  className="primary"
                  disabled={pending}
                  onClick={() => apply(draft.trim() === "" ? null : draft)}
                >
                  Apply
                </button>
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

        <LayoutOrientationSection />
        <AppearanceSection />
        <CommitsGraphSection />
        <DiffViewerSection />
        <AutoRefreshSection />
        <ConfirmDiscardSection />
        <BranchSwitchingSection />
        <MixedEndingDetectionSection />
        <LineEndingsGlobalSection />
        <SigningSettings scope="global" />
        <GlobalProfilesSection />
        <AboutSection />
      </div>
    </div>
  );
}

function AboutSection() {
  const version = useAppVersion();
  const status = useGitStatusStore((s) => s.status);
  return (
    <Section title="About">
      <Row label="LeGit" value={version ? `v${version}` : "…"} />
      {status?.version && <Row label="git" value={<code>{status.version.raw}</code>} />}
    </Section>
  );
}

function LayoutOrientationSection() {
  const placement = useSettingsStore((s) => s.settings?.global_region_placement ?? "top");
  const setRegionPlacement = useSettingsStore((s) => s.setRegionPlacement);
  const [saving, setSaving] = useState(false);

  const select = async (p: RegionPlacement) => {
    if (p === placement || saving) return;
    setSaving(true);
    try {
      await setRegionPlacement(p);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section title="Layout orientation">
      <FieldNote>writes to: global settings</FieldNote>
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button
          className={placement === "top" ? "primary" : ""}
          disabled={saving}
          onClick={() => select("top")}
        >
          Top / Bottom
        </button>
        <button
          className={placement === "left" ? "primary" : ""}
          disabled={saving}
          onClick={() => select("left")}
        >
          Left / Right
        </button>
      </div>
    </Section>
  );
}

function AppearanceSection() {
  const fontSize = useSettingsStore((s) => s.settings?.ui_font_size ?? UI_FONT_SIZE_DEFAULT);
  const setUiFontSize = useSettingsStore((s) => s.setUiFontSize);
  const [saving, setSaving] = useState(false);

  const save = async (v: number) => {
    setSaving(true);
    try {
      await setUiFontSize(v);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section title="Appearance">
      <FieldNote>writes to: global settings — base text size for all panels (other sizes scale from it)</FieldNote>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginTop: 8 }}>
        <NumberField
          label="UI font size"
          value={fontSize}
          min={UI_FONT_SIZE_MIN}
          max={UI_FONT_SIZE_MAX}
          disabled={saving}
          onCommit={save}
        />
      </div>
      {fontSize !== UI_FONT_SIZE_DEFAULT && (
        <div style={{ marginTop: 10 }}>
          <button disabled={saving} onClick={() => save(UI_FONT_SIZE_DEFAULT)}>
            Reset to default
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
  const [saving, setSaving] = useState(false);

  // Author avatars are strictly opt-in: off by default, because fetching one
  // sends the hashed author email to gravatar.com.
  const avatars = useSettingsStore((s) => s.settings?.commit_avatars ?? false);
  const setCommitAvatars = useSettingsStore((s) => s.setCommitAvatars);
  const [savingAvatars, setSavingAvatars] = useState(false);
  const toggleAvatars = async () => {
    setSavingAvatars(true);
    try {
      await setCommitAvatars(!avatars);
    } finally {
      setSavingAvatars(false);
    }
  };

  const save = async (
    nextRow: number,
    nextLane: number,
    nextDot: number,
    nextLine: number,
  ) => {
    setSaving(true);
    try {
      await setMetrics(nextRow, nextLane, nextDot, nextLine);
    } finally {
      setSaving(false);
    }
  };

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

  const isDefault =
    rowHeight === COMMITS_ROW_HEIGHT_DEFAULT &&
    laneWidth === COMMITS_LANE_WIDTH_DEFAULT &&
    dotRadius === COMMITS_DOT_RADIUS_DEFAULT &&
    lineWidth === COMMITS_LINE_WIDTH_DEFAULT;

  return (
    <Section title="Commits graph">
      <FieldNote>writes to: global settings — affects the Commits panel for all repos</FieldNote>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 16, marginTop: 8 }}>
        <NumberField
          label="Line height"
          value={effectiveRowHeight}
          min={rowHeightMin}
          max={COMMITS_ROW_HEIGHT_MAX}
          disabled={saving}
          onCommit={(v) => save(v, linked ? v : effectiveLaneWidth, dotRadius, lineWidth)}
        />
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
            // Fixed box (scales with the font) so the two states can never
            // differ in size — only the fill/colour changes.
            width: "1.9em",
            height: "1.7em",
            padding: 0,
            marginLeft: -8,
            marginRight: -8,
            fontSize: "inherit",
            background: linked ? "var(--accent)" : "transparent",
            color: linked ? "var(--accent-fg)" : "var(--subtle-fg)",
            // Transparent (not none) when unlinked so toggling doesn't shift layout.
            border: `1px solid ${linked ? "var(--accent)" : "transparent"}`,
          }}
        >
          {linked ? <LinkIcon /> : <UnlinkIcon />}
        </IconButton>
        <NumberField
          label="Graph lane width"
          value={shownLaneWidth}
          // Same font-derived floor as the line height.
          min={rowHeightMin}
          max={COMMITS_LANE_WIDTH_MAX}
          disabled={saving || linked}
          onCommit={(v) => save(effectiveRowHeight, v, dotRadius, lineWidth)}
        />
        <NumberField
          label="Commit dot radius"
          value={dotRadius}
          min={COMMITS_DOT_RADIUS_MIN}
          max={dotMax}
          disabled={saving}
          onCommit={(v) => save(effectiveRowHeight, effectiveLaneWidth, v, lineWidth)}
        />
        <NumberField
          label="Line width"
          value={lineWidth}
          min={COMMITS_LINE_WIDTH_MIN}
          max={lineMax}
          step={0.5}
          disabled={saving}
          onCommit={(v) => save(effectiveRowHeight, effectiveLaneWidth, dotRadius, v)}
        />
      </div>
      <FieldNote>
        Text size follows the global UI font size (see "UI font size" above).
      </FieldNote>
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
      <div style={{ marginTop: 10 }}>
        <button
          disabled={saving || isDefault}
          onClick={() =>
            save(
              COMMITS_ROW_HEIGHT_DEFAULT,
              COMMITS_LANE_WIDTH_DEFAULT,
              COMMITS_DOT_RADIUS_DEFAULT,
              COMMITS_LINE_WIDTH_DEFAULT,
            )
          }
        >
          Reset to defaults
        </button>
      </div>
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
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  /** Rounding granularity for committed values. Defaults to whole numbers. */
  step?: number;
  disabled?: boolean;
  onCommit: (value: number) => void;
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

  return (
    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "var(--fz-lg)" }}>
      <span className="legit-subtle">{label}</span>
      <input
        ref={inputRef}
        type="number"
        min={min}
        max={max}
        step={step}
        value={draft}
        disabled={disabled}
        style={{ width: 72 }}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
      <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)" }}>
        px ({min}–{max})
      </span>
    </label>
  );
}

function DiffViewerSection() {
  const enabled = useSettingsStore((s) => s.settings?.diff_syntax_highlighting ?? false);
  const setDiffSyntaxHighlighting = useSettingsStore((s) => s.setDiffSyntaxHighlighting);
  const [saving, setSaving] = useState(false);

  const toggle = async () => {
    setSaving(true);
    try {
      await setDiffSyntaxHighlighting(!enabled);
    } finally {
      setSaving(false);
    }
  };

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
          Syntax-highlight code in diffs
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

function AutoRefreshSection() {
  const enabled = useSettingsStore((s) => s.settings?.watcher_enabled ?? true);
  const setWatcherEnabled = useSettingsStore((s) => s.setWatcherEnabled);
  const [saving, setSaving] = useState(false);

  const toggle = async () => {
    setSaving(true);
    try {
      await setWatcherEnabled(!enabled);
    } finally {
      setSaving(false);
    }
  };

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

function ConfirmDiscardSection() {
  const confirm = useSettingsStore((s) => s.settings?.confirm_discard ?? true);
  const setConfirmDiscard = useSettingsStore((s) => s.setConfirmDiscard);
  const [saving, setSaving] = useState(false);

  const toggle = async () => {
    setSaving(true);
    try {
      await setConfirmDiscard(!confirm);
    } finally {
      setSaving(false);
    }
  };

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

function BranchSwitchingSection() {
  const behavior = useSettingsStore(
    (s) => s.settings?.switch_dirty_behavior ?? "try_directly",
  );
  const setSwitchDirtyBehavior = useSettingsStore((s) => s.setSwitchDirtyBehavior);
  const [saving, setSaving] = useState(false);

  const select = async (b: SwitchDirtyBehavior) => {
    if (b === behavior || saving) return;
    setSaving(true);
    try {
      await setSwitchDirtyBehavior(b);
    } finally {
      setSaving(false);
    }
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

function MixedEndingDetectionSection() {
  const warn = useSettingsStore((s) => s.settings?.warn_on_mixed_endings ?? true);
  const [saving, setSaving] = useState(false);

  const toggle = async () => {
    setSaving(true);
    try {
      await setWarnOnMixedEndings(!warn);
      useSettingsStore.setState((s) =>
        s.settings ? { settings: { ...s.settings, warn_on_mixed_endings: !warn } } : {}
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section title="Mixed ending detection">
      <FieldNote>writes to: global settings — default for all repos</FieldNote>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
        <input
          type="checkbox"
          id="global-warn-mixed"
          checked={warn}
          onChange={toggle}
          disabled={saving}
        />
        <label htmlFor="global-warn-mixed" style={{ fontSize: "var(--fz-lg)", cursor: "pointer" }}>
          Detect files with mixed CRLF+LF line endings (shown in Repo Settings)
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmPending, setConfirmPending] = useState(false);

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

  if (loading) return <Section title="Line endings (global)"><span className="legit-subtle">Loading…</span></Section>;
  if (!view) return null;

  const changes = getChangedValues(
    { autocrlf: view.autocrlf_global.value, eol: view.eol_global.value },
    { autocrlf: draftAutocrlf, eol: draftEol }
  );

  const handleSave = () => setConfirmPending(true);

  const handleConfirm = async () => {
    setConfirmPending(false);
    setSaving(true);
    setError(null);
    try {
      const updated = await globalWriteLineEndings(draftAutocrlf, draftEol);
      setView(updated);
      setDraftAutocrlf(updated.autocrlf_global.value ?? null);
      setDraftEol(updated.eol_global.value ?? null);
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setDraftAutocrlf(view.autocrlf_global.value ?? null);
    setDraftEol(view.eol_global.value ?? null);
  };

  return (
    <Section title="Line endings (global)">
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
            <button className="primary" onClick={handleConfirm} disabled={saving}>Save globally</button>
            <button onClick={() => setConfirmPending(false)}>Cancel</button>
          </div>
        </div>
      )}

      {!confirmPending && (
        <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
          <button className="primary" disabled={!dirty || saving} onClick={handleSave}>
            Save
          </button>
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: "var(--fz-sm)", textTransform: "uppercase", letterSpacing: 0.5, color: "var(--subtle-fg)", marginBottom: 8 }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "160px 1fr", gap: 6, padding: "2px 0" }}>
      <div className="legit-subtle">{label}</div>
      <div>{value}</div>
    </div>
  );
}

function FieldNote({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: "var(--fz-sm)", color: "var(--subtle-fg)", marginTop: 4 }}>
      {children}
    </div>
  );
}
