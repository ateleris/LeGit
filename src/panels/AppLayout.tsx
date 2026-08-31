import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSettingsStore, UI_FONT_SIZE_DEFAULT } from "../store/settings";
import { useRepoStore } from "../store/repos";
import { useSummonStore } from "../store/summon";
import { useGlobalRegionStore } from "../store/globalRegion";
import { exitMaximizedPanel, isUnclaimedEscape, toggleMaximizeActivePanel } from "../store/dockview";
import { useGitLogStore } from "../store/gitLog";
import { useConsoleStore } from "../store/console";
import { useRemoteProgressStore } from "../store/remoteProgress";
import { saveRegionState } from "../lib/commands";
import { onConsoleOutput, onGitInvocation, onRemoteProgress } from "../lib/events";
import { useRepoChangeListener } from "../lib/useRepoChangeListener";
import { useRemoteHostEvents } from "../lib/useRemoteHostEvents";
import { useAutoFetch } from "../lib/useAutoFetch";
import { useStartupUpdateCheck } from "../lib/useStartupUpdateCheck";
import type { RegionPlacement } from "../lib/types";
import { GlobalDock } from "./GlobalDock";
import { OpStateStrip } from "./OpStateStrip";
import { NoRepoHint } from "./NoRepoHint";
import { LfsWarningBanner } from "./LfsWarningBanner";
import { RepoDock } from "./RepoDock";
import { RepoTabBar } from "./RepoTabBar";
import { CredentialPromptHost } from "./CredentialPrompt";
import { AskpassPromptHost } from "./AskpassPrompt";
import { ConfirmDialogHost } from "./ConfirmDialogHost";

const DEFAULT_SIZE_TOP = 240;
const DEFAULT_SIZE_LEFT = 280;
/** Region size floors (px at the default font; scaled by the font size below).
 *
 * In Left/Right mode the divider splits WIDTH, so both the global strip and the
 * repo area get a 500px floor — neither can be squeezed narrow. In Top/Bottom
 * mode the divider splits HEIGHT; the floor there is small so the global strip
 * stays compact (a large height floor would force it open and push the main
 * repo region off-screen — that was the earlier breakage). Top-mode width is
 * the full window, so the 700px width requirement is satisfied automatically. */
const REGION_MIN_WIDTH_BASE = 700;
const REGION_MIN_HEIGHT_BASE = 60;
const DIVIDER_SIZE = 12;
const TAB_BAR_HEIGHT = 32;
/** Pointer travel (px, drag axis) below which a divider press counts as a
 * click that toggles the global region rather than a resize drag. */
const CLICK_DRAG_THRESHOLD = 4;

/** Fire-and-forget persistence of the region layout (failures only warn). */
function persistRegionState(
  placement: RegionPlacement,
  sizeTop: number | null,
  sizeLeft: number | null,
  collapsed: boolean
) {
  saveRegionState(placement, sizeTop, sizeLeft, collapsed).catch(
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
  useRemoteHostEvents();

  // Periodic background auto-fetch of the active repo (opt-in setting).
  useAutoFetch();

  // One quiet update check shortly after launch (setting, default on).
  useStartupUpdateCheck();

  // Feed the Git Log panel with every git invocation the backend reports.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    onGitInvocation((inv) => useGitLogStore.getState().add(inv)).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // Feed the per-repo console sessions. Subscribed here (not in the Console
  // panel) so a command running in a background repo keeps receiving output
  // even while another repo is active or the panel is closed. Completion
  // invalidates the OWNING repo's cache (§5.3), which need not be the
  // active one.
  const queryClient = useQueryClient();
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    onConsoleOutput((payload) => {
      const result = useConsoleStore.getState().handleBatch(payload);
      if (result?.finished) {
        queryClient.invalidateQueries({ queryKey: [result.repoId] });
      }
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [queryClient]);

  // Feed the remote-progress store (sync toolbar / clone form meters).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    onRemoteProgress((p) =>
      useRemoteProgressStore.getState().report(p.op_id, p.progress),
    ).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // When the user switches to a different repository, surface the Commits
  // panel. Other panels react on their own: query-driven panels (Commits,
  // Working Changes) refetch via their repo-keyed query keys, and selection
  // panels (Changed Files, Commit Details, Diff) clear their stale state.
  const activeRepoId = useRepoStore((s) => s.activeRepoId);
  const prevActiveRepo = useRef<string | null>(null);
  useEffect(() => {
    if (
      prevActiveRepo.current !== null &&
      activeRepoId &&
      activeRepoId !== prevActiveRepo.current
    ) {
      useSummonStore.getState().summon("log");
    }
    prevActiveRepo.current = activeRepoId;
  }, [activeRepoId]);

  // Ctrl+Shift+M toggles focus mode: maximize the active panel's group over
  // its whole dock region, press again (or navigate anywhere else) to restore.
  // Escape also exits it, but only when nothing else claimed the keypress
  // (see isUnclaimedEscape) and something is actually maximized.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "m" && e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        toggleMaximizeActivePanel();
      } else if (isUnclaimedEscape(e) && exitMaximizedPanel()) {
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const [placement, setPlacementState] = useState<RegionPlacement>("left");
  // Collapse state lives in a store (not component state) so actions outside
  // this component can expand the region - the View menu's summonGlobalPanel
  // must be able to uncollapse before opening a global panel.
  const collapsed = useGlobalRegionStore((s) => s.collapsed);
  const setCollapsed = useGlobalRegionStore((s) => s.setCollapsed);
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
    // Sync the transition ref too, so restoring the persisted collapse state
    // is not treated as a user toggle (no size stash, no re-persist).
    prevCollapsedRef.current = settings.global_dock_collapsed;
    setCollapsed(settings.global_dock_collapsed);
    if (settings.global_region_size_top != null) setSizeTop(settings.global_region_size_top);
    if (settings.global_region_size_left != null) setSizeLeft(settings.global_region_size_left);
  }, [settings, setCollapsed]);

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
        persistRegionState(placementRef.current, st, sl, collapsedRef.current);
      }, 400);
    },
    []
  );

  const toggleCollapsed = useCallback(() => {
    setCollapsed(!collapsedRef.current);
  }, [setCollapsed]);

  // React to collapse changes from ANY source (divider toggle, View-menu
  // summon): stash the region size when collapsing, restore it when
  // expanding, and persist the new state.
  const prevCollapsedRef = useRef(collapsed);
  useEffect(() => {
    const prev = prevCollapsedRef.current;
    if (prev === collapsed) return;
    prevCollapsedRef.current = collapsed;
    if (collapsed) {
      // Collapsing — remember current size so we can restore it.
      heightBeforeCollapse.current =
        placementRef.current === "top" ? sizeTopRef.current : sizeLeftRef.current;
    } else {
      // Expanding — restore remembered size.
      if (placementRef.current === "top") setSizeTop(heightBeforeCollapse.current);
      else setSizeLeft(heightBeforeCollapse.current);
    }
    persistRegionState(
      placementRef.current,
      sizeTopRef.current,
      sizeLeftRef.current,
      collapsed
    );
  }, [collapsed]);

  // Drag handler shared by both modes.
  const dragging = useRef(false);
  const dragStart = useRef(0);
  const dragStartSize = useRef(0);
  // Whether the pointer travelled past the click threshold since mousedown -
  // distinguishes a resize drag from a click-to-toggle on the divider bar.
  const dragMoved = useRef(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const onDividerMouseDown = useCallback(
    (e: React.MouseEvent) => {
      dragMoved.current = false;
      if (collapsedRef.current) return;
      dragging.current = true;
      const isTop = placementRef.current === "top";
      dragStart.current = isTop ? e.clientY : e.clientX;
      dragStartSize.current = isTop ? sizeTopRef.current : sizeLeftRef.current;

      const onMove = (ev: MouseEvent) => {
        if (!dragging.current) return;
        const isTopMode = placementRef.current === "top";
        const coord = isTopMode ? ev.clientY : ev.clientX;
        if (Math.abs(coord - dragStart.current) > CLICK_DRAG_THRESHOLD) {
          dragMoved.current = true;
        }
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

  // The whole divider bar toggles the global region: a press-and-release
  // without crossing the drag threshold is a click. Clicks on the embedded
  // buttons (toggle, placement mode) are theirs and are ignored here.
  const onDividerClick = useCallback(
    (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest("button")) return;
      if (dragMoved.current) return;
      toggleCollapsed();
    },
    [toggleCollapsed]
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
            onClick={onDividerClick}
            title={collapsed ? "Expand global panels" : "Drag to resize, click to collapse"}
          >
            {dividerControls}
          </div>
          <div style={{ flex: 1, minWidth: collapsed ? 0 : MIN_WIDTH, display: "flex", flexDirection: "column" }}>
            <RepoTabBar />
            <OpStateStrip />
            <LfsWarningBanner />
            <div className="legit-repo-region" style={{ flex: 1, minHeight: 0, position: "relative" }}>
              <RepoDock />
              <NoRepoHint />
            </div>
          </div>
        </div>
        <CredentialPromptHost />
        <AskpassPromptHost />
        <ConfirmDialogHost />
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
        onClick={onDividerClick}
        title={collapsed ? "Expand global panels" : "Drag to resize, click to collapse"}
      >
        {dividerControls}
      </div>
      <RepoTabBar />
      <OpStateStrip />
      <LfsWarningBanner />
      <div className="legit-repo-region" style={{ flex: 1, minHeight: 0, position: "relative" }}>
        <RepoDock />
        <NoRepoHint />
      </div>
      <CredentialPromptHost />
      <AskpassPromptHost />
      <ConfirmDialogHost />
    </div>
  );
}
