import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import {
  getGlobalSettings,
  saveChangedFilesViewMode,
  saveCommitsGraphMetrics,
  saveUiFontSize,
  setWatcherEnabled,
  setConfirmDiscard,
} from "../lib/commands";
import { reapplyPanelConstraints } from "./dockview";
import type { GlobalSettings, RegionPlacement } from "../lib/types";

/** Defaults + bounds for the Commits-panel graph metrics. Mirror the backend
 * clamps in `save_commits_graph_metrics`. */
export const COMMITS_ROW_HEIGHT_DEFAULT = 40;
export const COMMITS_LANE_WIDTH_DEFAULT = 40;
export const COMMITS_DOT_RADIUS_DEFAULT = 5;
export const COMMITS_LINE_WIDTH_DEFAULT = 1.5;
export const COMMITS_ROW_HEIGHT_MIN = 16;
export const COMMITS_ROW_HEIGHT_MAX = 120;
export const COMMITS_LANE_WIDTH_MIN = 12;
export const COMMITS_LANE_WIDTH_MAX = 120;
export const COMMITS_DOT_RADIUS_MIN = 1;
export const COMMITS_LINE_WIDTH_MIN = 1;
export const COMMITS_TEXT_SIZE_DEFAULT = 12;
export const COMMITS_TEXT_SIZE_MIN = 8;

/** Global UI font size (px) — base for the panel text scale and min sizes.
 * Mirror the backend clamp in `save_ui_font_size`. */
export const UI_FONT_SIZE_DEFAULT = 12;
export const UI_FONT_SIZE_MIN = 8;
export const UI_FONT_SIZE_MAX = 24;

/** Write the base font size to the `--ui-font-size` CSS var; the `--fz-*` scale
 * and the font-derived panel min sizes cascade from it. */
export function applyUiFontSize(size: number, root: HTMLElement = document.documentElement) {
  root.style.setProperty("--ui-font-size", `${size}px`);
}

/** Largest dot radius that fits a cell of the given height/width without
 * overflowing vertically or overlapping the neighbouring lane. Mirrors the
 * backend `max_commits_dot_radius`. */
export const maxCommitsDotRadius = (rowHeight: number, laneWidth: number) =>
  Math.floor(Math.min(rowHeight, laneWidth) / 2);

/** Largest connector line width: half the smaller cell dimension, so the
 * stroke never overflows the cell or a neighbouring lane. Not floored — line
 * width is set in 0.5px steps. Mirrors the backend clamp. */
export const maxCommitsLineWidth = (rowHeight: number, laneWidth: number) =>
  Math.min(rowHeight, laneWidth) / 2;

/** Largest sensible text size for a given row height — text taller than this
 * wouldn't sit comfortably within the line. Mirrors the backend clamp. */
export const maxCommitsTextSize = (rowHeight: number) =>
  Math.round(rowHeight * 0.7);

const clamp = (v: number, min: number, max: number) =>
  Math.min(max, Math.max(min, v));

interface SettingsStore {
  settings: GlobalSettings | null;
  init: () => Promise<void>;
  setRegionPlacement: (placement: RegionPlacement) => Promise<void>;
  setCommitsGraphMetrics: (
    rowHeight: number,
    laneWidth: number,
    dotRadius: number,
    lineWidth: number,
    textSize: number
  ) => Promise<void>;
  setChangedFilesViewMode: (mode: "tree" | "flat") => Promise<void>;
  setUiFontSize: (size: number) => Promise<void>;
  setWatcherEnabled: (enabled: boolean) => Promise<void>;
  setConfirmDiscard: (confirm: boolean) => Promise<void>;
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  settings: null,

  async init() {
    if (get().settings) return;
    const settings = await getGlobalSettings();
    applyUiFontSize(settings.ui_font_size ?? UI_FONT_SIZE_DEFAULT);
    set({ settings });
  },

  async setRegionPlacement(placement: RegionPlacement) {
    const s = get().settings;
    await invoke("save_region_state", {
      placement,
      sizeTop: s?.global_region_size_top ?? null,
      sizeLeft: s?.global_region_size_left ?? null,
      collapsed: s?.global_dock_collapsed ?? false,
    });
    if (s) {
      set({ settings: { ...s, global_region_placement: placement } });
    }
  },

  async setCommitsGraphMetrics(rowHeight, laneWidth, dotRadius, lineWidth, textSize) {
    const rh = clamp(rowHeight, COMMITS_ROW_HEIGHT_MIN, COMMITS_ROW_HEIGHT_MAX);
    const lw = clamp(laneWidth, COMMITS_LANE_WIDTH_MIN, COMMITS_LANE_WIDTH_MAX);
    // Dot radius is bounded by the (clamped) cell dimensions — keep it in range
    // even when the height/width shrink below the current radius.
    const dr = clamp(dotRadius, COMMITS_DOT_RADIUS_MIN, maxCommitsDotRadius(rh, lw));
    // Line width, like the dot, is bounded by the (clamped) cell dimensions.
    const lwd = clamp(lineWidth, COMMITS_LINE_WIDTH_MIN, maxCommitsLineWidth(rh, lw));
    // Text size is bounded relative to the (clamped) row height.
    const ts = clamp(textSize, COMMITS_TEXT_SIZE_MIN, maxCommitsTextSize(rh));
    await saveCommitsGraphMetrics(rh, lw, dr, lwd, ts);
    const s = get().settings;
    if (s) {
      set({
        settings: {
          ...s,
          commits_row_height: rh,
          commits_lane_width: lw,
          commits_dot_radius: dr,
          commits_line_width: lwd,
          commits_text_size: ts,
        },
      });
    }
  },

  async setChangedFilesViewMode(mode) {
    await saveChangedFilesViewMode(mode);
    const s = get().settings;
    if (s) {
      set({ settings: { ...s, changed_files_view_mode: mode } });
    }
  },

  async setWatcherEnabled(enabled) {
    await setWatcherEnabled(enabled);
    const s = get().settings;
    if (s) {
      set({ settings: { ...s, watcher_enabled: enabled } });
    }
  },

  async setConfirmDiscard(confirm) {
    await setConfirmDiscard(confirm);
    const s = get().settings;
    if (s) {
      set({ settings: { ...s, confirm_discard: confirm } });
    }
  },

  async setUiFontSize(size) {
    const clamped = clamp(size, UI_FONT_SIZE_MIN, UI_FONT_SIZE_MAX);
    // Apply immediately for a live preview, then persist (backend re-clamps).
    applyUiFontSize(clamped);
    reapplyPanelConstraints();
    const stored = await saveUiFontSize(clamped);
    applyUiFontSize(stored);
    reapplyPanelConstraints();
    const s = get().settings;
    if (s) {
      set({ settings: { ...s, ui_font_size: stored } });
    }
  },
}));
