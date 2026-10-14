import { useRef, useState } from "react";
import { DragHandleIcon, LinkIcon, UnlinkIcon } from "../../icons";
import { Button, IconButton } from "../shared/buttons";
import { useDelayedBusy } from "../shared/useDelayedBusy";
import { useRowDragReorder } from "../shared/useRowDragReorder";
import type { RepoTabStyle } from "../../lib/types";
import {
  useSettingsStore,
  maxRepoTabRadius,
  minRepoTabHeight,
  REPO_TAB_BORDER_WIDTH_DEFAULT,
  REPO_TAB_BORDER_WIDTH_MAX,
  REPO_TAB_GAP_DEFAULT,
  REPO_TAB_GAP_MAX,
  REPO_TAB_HEIGHT_DEFAULT,
  REPO_TAB_HEIGHT_MAX,
  REPO_TAB_INSET_DEFAULT,
  REPO_TAB_INSET_MAX,
  REPO_TAB_RADIUS_DEFAULT,
  REPO_TAB_STRIP_BORDER_WIDTH_DEFAULT,
  REPO_TAB_STRIP_BORDER_WIDTH_MAX,
  UI_FONT_SIZE_DEFAULT,
  type RepoTabChrome,
} from "../../store/settings";
import {
  orderedWorkingChangesSections,
  WORKING_CHANGES_SECTION_LABELS,
} from "../WorkingChanges/sectionOrder";
import { AdvancedSettings, FieldNote, Section, ToggleSection, WritesTo } from "./primitives";
import { NumberField, SETTINGS_GRID_COLS } from "./NumberField";

export function DiffViewerSection() {
  const enabled = useSettingsStore((s) => s.settings?.diff_syntax_highlighting ?? false);
  const setDiffSyntaxHighlighting = useSettingsStore((s) => s.setDiffSyntaxHighlighting);
  const { busy: saving, run } = useDelayedBusy();

  return (
    <ToggleSection
      title="Diff viewer"
      writesNote="applies to all repos"
      id="global-diff-syntax"
      label="Syntax-highlight code in diffs and file views"
      checked={enabled}
      disabled={saving}
      onToggle={() => void run(() => setDiffSyntaxHighlighting(!enabled))}
    >
      <FieldNote>
        Colours come from the theme's Syntax tokens. Each hunk is highlighted on
        its own, so constructs opened outside the visible context may colour
        imperfectly. Very large diffs are skipped.
      </FieldNote>
    </ToggleSection>
  );
}

const REPO_TAB_STYLES: { style: RepoTabStyle; label: string }[] = [
  { style: "flush", label: "Flush" },
  { style: "pill", label: "Pills" },
  { style: "browser", label: "Browser" },
];

/** localStorage key for the tab spacing / outer spacing link (default on). */
const TAB_SPACING_LINK_KEY = "legit.repo-tab-spacing-link";

export function RepoTabsSection() {
  const style = useSettingsStore((s) => s.settings?.repo_tab_style ?? "flush");
  const gap = useSettingsStore((s) => s.settings?.repo_tab_gap ?? REPO_TAB_GAP_DEFAULT);
  const inset = useSettingsStore((s) => s.settings?.repo_tab_inset ?? REPO_TAB_INSET_DEFAULT);
  const height = useSettingsStore((s) => s.settings?.repo_tab_height ?? REPO_TAB_HEIGHT_DEFAULT);
  const radius = useSettingsStore(
    (s) => s.settings?.repo_tab_corner_radius ?? REPO_TAB_RADIUS_DEFAULT,
  );
  const border = useSettingsStore(
    (s) => s.settings?.repo_tab_border_width ?? REPO_TAB_BORDER_WIDTH_DEFAULT,
  );
  const stripBorder = useSettingsStore(
    (s) => s.settings?.repo_tab_strip_border_width ?? REPO_TAB_STRIP_BORDER_WIDTH_DEFAULT,
  );
  const fontSize = useSettingsStore((s) => s.settings?.ui_font_size ?? UI_FONT_SIZE_DEFAULT);
  const setRepoTabStyle = useSettingsStore((s) => s.setRepoTabStyle);
  const { busy: saving, run } = useDelayedBusy();

  const save = (next: Partial<RepoTabChrome>) =>
    run(() =>
      setRepoTabStyle({
        style,
        gap,
        inset,
        height,
        radius,
        borderWidth: border,
        stripBorderWidth: stripBorder,
        ...next,
      }),
    );

  // Knobs a style ignores are hidden, not disabled (a disabled field
  // showing an inactive number reads like a bug): flush takes none of the
  // per-tab knobs, and the browser style is deliberately borderless (a
  // stroke would end tangent at the strip line and never flow into the
  // strip border).
  const showTabKnobs = style !== "flush";
  const showBorderKnob = style === "pill";
  const stripBorderRow = showBorderKnob ? 6 : showTabKnobs ? 5 : 2;

  // All knobs live behind the Advanced toggle - the style picker is the
  // whole default UI. Opened automatically when any value was customised,
  // so tuned settings never look lost.
  const hasCustomValues =
    height !== REPO_TAB_HEIGHT_DEFAULT ||
    gap !== REPO_TAB_GAP_DEFAULT ||
    inset !== REPO_TAB_INSET_DEFAULT ||
    radius !== REPO_TAB_RADIUS_DEFAULT ||
    border !== REPO_TAB_BORDER_WIDTH_DEFAULT ||
    stripBorder !== REPO_TAB_STRIP_BORDER_WIDTH_DEFAULT;

  // Photoshop-style link between tab spacing and outer spacing: while linked
  // (the default) the inset mirrors the gap and can't be edited; unlink to
  // set them separately. Frontend-only preference, like the panel chrome's
  // spacing/radius link in the General section.
  const [spacingLinked, setSpacingLinked] = useState(
    () => localStorage.getItem(TAB_SPACING_LINK_KEY) !== "0",
  );
  const toggleSpacingLink = () => {
    const next = !spacingLinked;
    setSpacingLinked(next);
    try { localStorage.setItem(TAB_SPACING_LINK_KEY, next ? "1" : "0"); } catch { /* quota */ }
    // Re-linking applies the constraint immediately.
    if (next && inset !== gap) void save({ inset: gap });
  };
  const shownInset = spacingLinked ? gap : inset;

  return (
    <Section title="Repository tabs">
      <WritesTo note="style of the repo tab strip above the panels" />
      <div
        style={{
          display: "grid",
          gridTemplateColumns: SETTINGS_GRID_COLS,
          gap: "0.5em 0.833em",
          alignItems: "center",
          marginTop: "0.667em",
          width: "fit-content",
          fontSize: "var(--fz-lg)",
        }}
      >
        <span className="legit-subtle" style={{ gridColumn: 1, gridRow: 1, whiteSpace: "nowrap" }}>Tab style</span>
        <div style={{ gridColumn: "3 / -1", gridRow: 1, display: "flex", gap: "0.667em" }}>
          {REPO_TAB_STYLES.map((entry) => (
            <Button
              key={entry.style}
              variant={style === entry.style ? "primary" : "default"}
              disabled={saving}
              onClick={() => style !== entry.style && void save({ style: entry.style })}
            >
              {entry.label}
            </Button>
          ))}
        </div>
      </div>
      <AdvancedSettings defaultOpen={hasCustomValues}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: SETTINGS_GRID_COLS,
            gap: "0.5em 0.833em",
            alignItems: "center",
            marginTop: "0.667em",
            width: "fit-content",
            fontSize: "var(--fz-lg)",
          }}
        >
          {/* First knob, every style (flush tabs fill the strip, so it is
              the bar height there). The height floor is font-derived (the
              text must fit) and the radius max is height-derived (top
              rounding + bottom flare), so broken shapes can't be configured
              (mirrored backend clamps). */}
          <NumberField
            grid
            row={1}
            label="Tab height"
            value={height}
            min={minRepoTabHeight(fontSize)}
            max={REPO_TAB_HEIGHT_MAX}
            disabled={saving}
            onCommit={(v) => void save({ height: v })}
          />
          {showTabKnobs && (
            <>
              <NumberField
                grid
                row={2}
                label="Tab spacing"
                value={gap}
                min={0}
                max={REPO_TAB_GAP_MAX}
                disabled={saving}
                onCommit={(v) => void save(spacingLinked ? { gap: v, inset: v } : { gap: v })}
              />
              {/* Chain-link spanning the two spacings it governs (rows 2-3),
                  in the gutter column - same pattern as the General
                  section's panel spacing/radius link. */}
              <IconButton
                aria-pressed={spacingLinked}
                title={
                  spacingLinked
                    ? "Linked: outer spacing follows tab spacing; click to set it separately"
                    : "Unlinked: outer spacing is set separately; click to link it to tab spacing"
                }
                onClick={toggleSpacingLink}
                disabled={saving}
                style={{
                  gridColumn: 2,
                  gridRow: "2 / span 2",
                  justifySelf: "center",
                  alignSelf: "center",
                  width: "1.9em",
                  height: "1.7em",
                  padding: 0,
                  fontSize: "inherit",
                  background: spacingLinked ? "var(--accent)" : "transparent",
                  color: spacingLinked ? "var(--accent-fg)" : "var(--subtle-fg)",
                  border: `1px solid ${spacingLinked ? "var(--accent)" : "transparent"}`,
                }}
              >
                {spacingLinked ? <LinkIcon /> : <UnlinkIcon />}
              </IconButton>
              <NumberField
                grid
                row={3}
                label="Outer spacing"
                value={shownInset}
                min={0}
                max={REPO_TAB_INSET_MAX}
                disabled={saving || spacingLinked}
                onCommit={(v) => void save({ inset: v })}
              />
              <NumberField
                grid
                row={4}
                label="Tab corner radius"
                value={radius}
                min={0}
                max={maxRepoTabRadius(height)}
                disabled={saving}
                onCommit={(v) => void save({ radius: v })}
              />
            </>
          )}
          {showBorderKnob && (
            <NumberField
              grid
              row={5}
              label="Tab border thickness"
              value={border}
              min={0}
              max={REPO_TAB_BORDER_WIDTH_MAX}
              disabled={saving}
              onCommit={(v) => void save({ borderWidth: v })}
            />
          )}
          {/* Strip-level: the separator under the bar exists in every style.
              Its colour is the tab.strip.border theme token (Theme Editor). */}
          <NumberField
            grid
            row={stripBorderRow}
            label="Strip border thickness"
            value={stripBorder}
            min={0}
            max={REPO_TAB_STRIP_BORDER_WIDTH_MAX}
            disabled={saving}
            onCommit={(v) => void save({ stripBorderWidth: v })}
          />
        </div>
        <FieldNote>
          {showTabKnobs && (
            <>
              Tab spacing is the gap between tabs; outer spacing is the tabs'
              inset from the strip edges.{" "}
            </>
          )}
          The strip border is the separator below the bar; its colour comes
          from the theme (token "tab.strip.border").
        </FieldNote>
      </AdvancedSettings>
    </Section>
  );
}

export function WorkingChangesLayoutSection() {
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

  return (
    <Section title="Working Changes layout">
      <WritesTo note="applies to all repos" />
      <FieldNote>
        Top-to-bottom order of the three Working Changes sections. Drag rows
        to put Staged first, or move the commit box to the top.
      </FieldNote>
      <div
        ref={listRef}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "0.333em",
          marginTop: "0.667em",
          // Row offsets resolve against this container (drag math).
          position: "relative",
        }}
      >
        {order.map((id) => (
          <div
            key={id}
            ref={registerItem(id)}
            onPointerDown={(e) => beginDrag(e, id)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.667em",
              // Same metrics as the global `button` base (settings-body
              // buttons like Top/Bottom - Left/Right): --fz-lg text,
              // line-height 1.4, 4px vertical padding, radius 4 - so the
              // rows sit at exactly the neighbouring controls' height.
              fontSize: "var(--fz-lg)",
              lineHeight: 1.4,
              border: "1px solid var(--panel-border)",
              borderRadius: 4,
              padding: "0.333em 0.667em",
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
            <span className="legit-subtle" style={{ display: "flex" }}>
              <DragHandleIcon />
            </span>
            <span>{WORKING_CHANGES_SECTION_LABELS[id]}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}
