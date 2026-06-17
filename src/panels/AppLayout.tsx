import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore, UI_FONT_SIZE_DEFAULT } from "../store/settings";
import { useRepoChangeListener } from "../lib/useRepoChangeListener";
import type { RegionPlacement } from "../lib/types";
import { GlobalDock } from "./GlobalDock";
import { RepoDock } from "./RepoDock";
import { RepoTabBar } from "./RepoTabBar";

const DEFAULT_SIZE_TOP = 240;
const DEFAULT_SIZE_LEFT = 280;
/** Region size floors (px at the default font; scaled by the font size below).
 *
 * In Left/Right mode the divider splits WIDTH, so both the global strip and the
 * repo area get a 500px floor — neither can be squeezed narrow. In Top/Bottom
 * mode the divider splits HEIGHT; the floor there is small so the global strip
 * stays compact (a large height floor would force it open and push the main
 * repo region off-screen — that was the earlier breakage). Top-mode width is
 * the full window, so the 500px width requirement is satisfied automatically. */
const REGION_MIN_WIDTH_BASE = 500;
const REGION_MIN_HEIGHT_BASE = 60;
const DIVIDER_SIZE = 12;
const TAB_BAR_HEIGHT = 32;

function saveRegionState(
  placement: RegionPlacement,
  sizeTop: number | null,
  sizeLeft: number | null,
  collapsed: boolean
) {
  invoke("save_region_state", { placement, sizeTop, sizeLeft, collapsed }).catch(
    (e) => console.warn("save_region_state failed", e)
  );
}

/**
 * Two-region layout: global dock + repo dock, with draggable divider.
 * Top mode: global above, tab strip + repo below.
 * Left mode: tab strip at top, global left, repo right.
 * See DESIGN-v0.2.md §C.2.
 */
export function AppLayout() {
  const settings = useSettingsStore((s) => s.settings);

  // Live refresh from the backend filesystem watcher (primary refresh path).
  useRepoChangeListener();

  const [placement, setPlacementState] = useState<RegionPlacement>("top");
  const [collapsed, setCollapsed] = useState(false);
  const [sizeTop, setSizeTop] = useState(DEFAULT_SIZE_TOP);
  const [sizeLeft, setSizeLeft] = useState(DEFAULT_SIZE_LEFT);

  // Region size floors, scaled by the global font size. Width floor (left mode)
  // and height floor (top mode) are separate — see the constants above.
  const fontScale = (settings?.ui_font_size ?? UI_FONT_SIZE_DEFAULT) / UI_FONT_SIZE_DEFAULT;
  const MIN_WIDTH = Math.round(REGION_MIN_WIDTH_BASE * fontScale);
  const MIN_HEIGHT = Math.round(REGION_MIN_HEIGHT_BASE * fontScale);

  // Load sizes + collapsed from settings once (drag state — don't re-apply later).
  const settingsLoaded = useRef(false);
  useEffect(() => {
    if (settingsLoaded.current || !settings) return;
    settingsLoaded.current = true;
    setCollapsed(settings.global_dock_collapsed);
    if (settings.global_region_size_top != null) setSizeTop(settings.global_region_size_top);
    if (settings.global_region_size_left != null) setSizeLeft(settings.global_region_size_left);
  }, [settings]);

  // Placement is a preference — react to store changes (e.g. from Global Settings).
  const persistedPlacement = useSettingsStore((s) => s.settings?.global_region_placement);
  useEffect(() => {
    if (persistedPlacement) setPlacementState(persistedPlacement);
  }, [persistedPlacement]);

  // Refs so callbacks always see current values without stale closures.
  const sizeTopRef = useRef(sizeTop);
  const sizeLeftRef = useRef(sizeLeft);
  const placementRef = useRef(placement);
  const collapsedRef = useRef(collapsed);
  const minWidthRef = useRef(MIN_WIDTH);
  const minHeightRef = useRef(MIN_HEIGHT);
  useEffect(() => { sizeTopRef.current = sizeTop; }, [sizeTop]);
  useEffect(() => { sizeLeftRef.current = sizeLeft; }, [sizeLeft]);
  useEffect(() => { placementRef.current = placement; }, [placement]);
  useEffect(() => { collapsedRef.current = collapsed; }, [collapsed]);
  useEffect(() => { minWidthRef.current = MIN_WIDTH; }, [MIN_WIDTH]);
  useEffect(() => { minHeightRef.current = MIN_HEIGHT; }, [MIN_HEIGHT]);

  const heightBeforeCollapse = useRef(DEFAULT_SIZE_TOP);

  // Debounce drag-end persistence.
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debouncedPersist = useCallback(
    (st: number | null, sl: number | null) => {
      if (persistTimer.current) clearTimeout(persistTimer.current);
      persistTimer.current = setTimeout(() => {
        saveRegionState(placementRef.current, st, sl, collapsedRef.current);
      }, 400);
    },
    []
  );

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      if (!prev) {
        // Collapsing — remember current size so we can restore it.
        heightBeforeCollapse.current =
          placementRef.current === "top" ? sizeTopRef.current : sizeLeftRef.current;
      } else {
        // Expanding — restore remembered size.
        if (placementRef.current === "top") setSizeTop(heightBeforeCollapse.current);
        else setSizeLeft(heightBeforeCollapse.current);
      }
      saveRegionState(
        placementRef.current,
        sizeTopRef.current,
        sizeLeftRef.current,
        next
      );
      return next;
    });
  }, []);

  // Drag handler shared by both modes.
  const dragging = useRef(false);
  const dragStart = useRef(0);
  const dragStartSize = useRef(0);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const onDividerMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (collapsedRef.current) return;
      dragging.current = true;
      const isTop = placementRef.current === "top";
      dragStart.current = isTop ? e.clientY : e.clientX;
      dragStartSize.current = isTop ? sizeTopRef.current : sizeLeftRef.current;

      const onMove = (ev: MouseEvent) => {
        if (!dragging.current) return;
        const isTopMode = placementRef.current === "top";
        const coord = isTopMode ? ev.clientY : ev.clientX;
        const container = containerRef.current;
        const totalSize = container
          ? (isTopMode ? container.clientHeight : container.clientWidth)
          : 0;
        const overhead = isTopMode ? DIVIDER_SIZE + TAB_BAR_HEIGHT : DIVIDER_SIZE;
        const minSize = isTopMode ? minHeightRef.current : minWidthRef.current;
        const maxSize = totalSize > 0 ? totalSize - overhead - minSize : Infinity;
        const next = Math.min(maxSize, Math.max(minSize, dragStartSize.current + coord - dragStart.current));
        if (isTopMode) {
          setSizeTop(next);
          debouncedPersist(next, sizeLeftRef.current);
        } else {
          setSizeLeft(next);
          debouncedPersist(sizeTopRef.current, next);
        }
      };

      const onUp = () => {
        dragging.current = false;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      e.preventDefault();
    },
    [debouncedPersist]
  );

  const dividerControls = (
    <button
      className="legit-region-divider__toggle"
      onClick={toggleCollapsed}
      title={collapsed ? "Expand global panels" : "Collapse global panels"}
    >
      {placement === "top"
        ? collapsed ? "▼" : "▲"
        : collapsed ? "▶" : "◀"}
    </button>
  );

  if (placement === "left") {
    return (
      <div className="legit-app-root" ref={containerRef}>
        <div className="legit-split-row" style={{ flex: 1, minHeight: 0 }}>
          {!collapsed && (
            <div
              className="legit-global-region"
              style={{ width: sizeLeft, minWidth: MIN_WIDTH, flexShrink: 0 }}
            >
              <GlobalDock />
            </div>
          )}
          <div
            className={`legit-region-divider legit-region-divider--vertical${collapsed ? " is-collapsed" : ""}`}
            onMouseDown={onDividerMouseDown}
          >
            {dividerControls}
          </div>
          <div style={{ flex: 1, minWidth: collapsed ? 0 : MIN_WIDTH, display: "flex", flexDirection: "column" }}>
            <RepoTabBar />
            <div className="legit-repo-region" style={{ flex: 1, minHeight: 0 }}>
              <RepoDock />
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Top mode (default).
  return (
    <div className="legit-app-root" ref={containerRef}>
      {!collapsed && (
        <div
          className="legit-global-region"
          style={{ height: sizeTop, minHeight: MIN_HEIGHT }}
        >
          <GlobalDock />
        </div>
      )}
      <div
        className={`legit-region-divider${collapsed ? " is-collapsed" : ""}`}
        onMouseDown={onDividerMouseDown}
      >
        {dividerControls}
      </div>
      <RepoTabBar />
      <div className="legit-repo-region" style={{ flex: 1, minHeight: 0 }}>
        <RepoDock />
      </div>
    </div>
  );
}
