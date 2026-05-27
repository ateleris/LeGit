import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "../store/settings";
import type { RegionPlacement } from "../lib/types";
import { GlobalDock } from "./GlobalDock";
import { RepoDock } from "./RepoDock";
import { RepoTabBar } from "./RepoTabBar";

const DEFAULT_SIZE_TOP = 240;
const DEFAULT_SIZE_LEFT = 280;
const MIN_SIZE = 60;

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

  const [placement, setPlacementState] = useState<RegionPlacement>("top");
  const [collapsed, setCollapsed] = useState(false);
  const [sizeTop, setSizeTop] = useState(DEFAULT_SIZE_TOP);
  const [sizeLeft, setSizeLeft] = useState(DEFAULT_SIZE_LEFT);

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
  useEffect(() => { sizeTopRef.current = sizeTop; }, [sizeTop]);
  useEffect(() => { sizeLeftRef.current = sizeLeft; }, [sizeLeft]);
  useEffect(() => { placementRef.current = placement; }, [placement]);
  useEffect(() => { collapsedRef.current = collapsed; }, [collapsed]);

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

  const onDividerMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (collapsedRef.current) return;
      dragging.current = true;
      const isTop = placementRef.current === "top";
      dragStart.current = isTop ? e.clientY : e.clientX;
      dragStartSize.current = isTop ? sizeTopRef.current : sizeLeftRef.current;

      const onMove = (ev: MouseEvent) => {
        if (!dragging.current) return;
        const coord = placementRef.current === "top" ? ev.clientY : ev.clientX;
        const next = Math.max(MIN_SIZE, dragStartSize.current + coord - dragStart.current);
        if (placementRef.current === "top") {
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
      <div className="legit-app-root">
        <RepoTabBar />
        <div className="legit-split-row" style={{ flex: 1, minHeight: 0 }}>
          {!collapsed && (
            <div
              className="legit-global-region"
              style={{ width: sizeLeft, minWidth: MIN_SIZE, flexShrink: 0 }}
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
          <div className="legit-repo-region" style={{ flex: 1, minWidth: 0 }}>
            <RepoDock />
          </div>
        </div>
      </div>
    );
  }

  // Top mode (default).
  return (
    <div className="legit-app-root">
      {!collapsed && (
        <div
          className="legit-global-region"
          style={{ height: sizeTop, minHeight: MIN_SIZE }}
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
