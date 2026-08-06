import { create } from "zustand";
import {
  getGlobalSettings,
  saveBranchListView,
  saveRegionState,
  saveChangedFilesViewMode,
  saveRefsSortMode,
  saveCommitsGraphMetrics,
  saveUiFontSize,
  setWatcherEnabled,
  setConfirmDiscard,
  setCheckoutNewBranch,
  setSubmoduleAttachBranch,
  setAutoFetchEnabled,
  setAutoFetchIntervalMinutes,
  setExternalEditorCommand,
  setCommitAvatars,
  setAutoPushTags,
  setDiffSyntaxHighlighting,
  setCommitDateAbsolute,
  setCommitDateFormat,
  setCommitDateShowTime,
  setSuppressedAutoOpenPanels,
  setWorkingChangesSectionOrder,
  saveSwitchDirtyBehavior,
  savePullStrategy,
  saveStashIncludeUntracked,
  savePushRecurseSubmodules,
} from "../lib/commands";
import { reapplyPanelConstraints } from "./dockview";
import type {
  PushRecurseMode,
  GlobalSettings,
  PullStrategy,
  RegionPlacement,
  SwitchDirtyBehavior,
} from "../lib/types";
import type { CommitDateFormat } from "../lib/time";
import type { RefsSortMode } from "../lib/refSort";

/** Defaults + bounds for the Commits-panel graph metrics. Mirror the backend
 * clamps in `save_commits_graph_metrics`. */
export const COMMITS_ROW_HEIGHT_DEFAULT = 40;
export const COMMITS_LANE_WIDTH_DEFAULT = 40;
export const COMMITS_DOT_RADIUS_DEFAULT = 5;
export const COMMITS_LINE_WIDTH_DEFAULT = 1.5;
export const COMMITS_ROW_HEIGHT_MIN = 16;
export const COMMITS_ROW_HEIGHT_MAX = 120;
// Lane width has no fixed minimum — it shares the row height's font-derived
// floor (`minCommitsRowHeight`).
export const COMMITS_LANE_WIDTH_MAX = 120;
export const COMMITS_DOT_RADIUS_MIN = 1;
export const COMMITS_LINE_WIDTH_MIN = 1;

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

/** Minimum Commits-panel row height for a given UI font size. A ref chip is
 * `fontSize * 1.3` (line-height) + 2px padding + 2px border tall (see
 * `BASE_CHIP` in RefsCell); rows must be 2px taller so chips on adjacent rows
 * never touch. Mirrors the backend `min_commits_row_height`. */
export const minCommitsRowHeight = (fontSize: number) =>
  Math.max(COMMITS_ROW_HEIGHT_MIN, Math.ceil(fontSize * 1.3) + 6);

const clamp = (v: number, min: number, max: number) =>
  Math.min(max, Math.max(min, v));

/**
 * Whether destructive actions ask for confirmation first (`confirm_discard`,
 * default on). Applies to ALL destructive actions — discarding changes,
 * deleting branches, dropping stashes, removing remotes/themes — so every
 * confirm-before-destroy UI must consult this one hook.
 */
export const useConfirmDestructive = () =>
  useSettingsStore((s) => s.settings?.confirm_discard ?? true);

interface SettingsStore {
  settings: GlobalSettings | null;
  init: () => Promise<void>;
  setRegionPlacement: (placement: RegionPlacement) => Promise<void>;
  setCommitsGraphMetrics: (
    rowHeight: number,
    laneWidth: number,
    dotRadius: number,
    lineWidth: number
  ) => Promise<void>;
  setChangedFilesViewMode: (mode: "tree" | "flat") => Promise<void>;
  setBranchListView: (mode: "tree" | "flat") => Promise<void>;
  setRefsSortMode: (mode: RefsSortMode) => Promise<void>;
  setUiFontSize: (size: number) => Promise<void>;
  setWatcherEnabled: (enabled: boolean) => Promise<void>;
  setConfirmDiscard: (confirm: boolean) => Promise<void>;
  setCheckoutNewBranch: (enabled: boolean) => Promise<void>;
  setSubmoduleAttachBranch: (enabled: boolean) => Promise<void>;
  setAutoFetchEnabled: (enabled: boolean) => Promise<void>;
  setAutoFetchIntervalMinutes: (minutes: number) => Promise<void>;
  setExternalEditorCommand: (command: string | null) => Promise<void>;
  setCommitAvatars: (enabled: boolean) => Promise<void>;
  setAutoPushTags: (enabled: boolean) => Promise<void>;
  setDiffSyntaxHighlighting: (enabled: boolean) => Promise<void>;
  setCommitDateAbsolute: (enabled: boolean) => Promise<void>;
  setCommitDateFormat: (format: CommitDateFormat) => Promise<void>;
  setCommitDateShowTime: (enabled: boolean) => Promise<void>;
  setSuppressedAutoOpenPanels: (panels: string[]) => Promise<void>;
  setWorkingChangesSectionOrder: (order: string[]) => Promise<void>;
  setSwitchDirtyBehavior: (behavior: SwitchDirtyBehavior) => Promise<void>;
  setPullStrategy: (strategy: PullStrategy) => Promise<void>;
  setStashIncludeUntracked: (include: boolean) => Promise<void>;
  setPushRecurseSubmodules: (mode: PushRecurseMode | null) => Promise<void>;
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
    await saveRegionState(
      placement,
      s?.global_region_size_top ?? null,
      s?.global_region_size_left ?? null,
      s?.global_dock_collapsed ?? false,
    );
    if (s) {
      set({ settings: { ...s, global_region_placement: placement } });
    }
  },

  async setCommitsGraphMetrics(rowHeight, laneWidth, dotRadius, lineWidth) {
    // The row must clear a ref chip (which scales with the UI font size).
    const font = get().settings?.ui_font_size ?? UI_FONT_SIZE_DEFAULT;
    const rh = clamp(rowHeight, minCommitsRowHeight(font), COMMITS_ROW_HEIGHT_MAX);
    // Lane width shares the row height's font-derived floor (not the current
    // row height — the two are adjustable independently above it).
    const lw = clamp(laneWidth, minCommitsRowHeight(font), COMMITS_LANE_WIDTH_MAX);
    // Dot radius is bounded by the (clamped) cell dimensions — keep it in range
    // even when the height/width shrink below the current radius.
    const dr = clamp(dotRadius, COMMITS_DOT_RADIUS_MIN, maxCommitsDotRadius(rh, lw));
    // Line width, like the dot, is bounded by the (clamped) cell dimensions.
    const lwd = clamp(lineWidth, COMMITS_LINE_WIDTH_MIN, maxCommitsLineWidth(rh, lw));
    await saveCommitsGraphMetrics(rh, lw, dr, lwd);
    const s = get().settings;
    if (s) {
      set({
        settings: {
          ...s,
          commits_row_height: rh,
          commits_lane_width: lw,
          commits_dot_radius: dr,
          commits_line_width: lwd,
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

  async setBranchListView(mode) {
    await saveBranchListView(mode);
    const s = get().settings;
    if (s) {
      set({ settings: { ...s, branch_list_view: mode } });
    }
  },

  async setRefsSortMode(mode) {
    await saveRefsSortMode(mode);
    const s = get().settings;
    if (s) {
      set({ settings: { ...s, refs_sort_mode: mode } });
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

  async setCheckoutNewBranch(enabled) {
    await setCheckoutNewBranch(enabled);
    const s = get().settings;
    if (s) set({ settings: { ...s, checkout_new_branch: enabled } });
  },

  async setSubmoduleAttachBranch(enabled) {
    await setSubmoduleAttachBranch(enabled);
    const s = get().settings;
    if (s) set({ settings: { ...s, submodule_attach_branch: enabled } });
  },

  async setAutoFetchEnabled(enabled) {
    await setAutoFetchEnabled(enabled);
    const s = get().settings;
    if (s) set({ settings: { ...s, auto_fetch_enabled: enabled } });
  },

  async setAutoFetchIntervalMinutes(minutes) {
    const clamped = Math.max(1, Math.round(minutes)); // backend re-clamps
    await setAutoFetchIntervalMinutes(clamped);
    const s = get().settings;
    if (s) set({ settings: { ...s, auto_fetch_interval_minutes: clamped } });
  },

  async setExternalEditorCommand(command) {
    const normalized = command && command.trim() !== "" ? command : null;
    await setExternalEditorCommand(normalized);
    const s = get().settings;
    if (s) set({ settings: { ...s, external_editor_command: normalized } });
  },

  async setCommitAvatars(enabled) {
    await setCommitAvatars(enabled);
    const s = get().settings;
    if (s) set({ settings: { ...s, commit_avatars: enabled } });
  },

  async setAutoPushTags(enabled) {
    await setAutoPushTags(enabled);
    const s = get().settings;
    if (s) set({ settings: { ...s, auto_push_tags: enabled } });
  },

  async setDiffSyntaxHighlighting(enabled) {
    await setDiffSyntaxHighlighting(enabled);
    const s = get().settings;
    if (s) set({ settings: { ...s, diff_syntax_highlighting: enabled } });
  },

  async setCommitDateAbsolute(enabled) {
    await setCommitDateAbsolute(enabled);
    const s = get().settings;
    if (s) set({ settings: { ...s, commit_date_absolute: enabled } });
  },

  async setCommitDateFormat(format) {
    await setCommitDateFormat(format);
    const s = get().settings;
    if (s) set({ settings: { ...s, commit_date_format: format } });
  },

  async setCommitDateShowTime(enabled) {
    await setCommitDateShowTime(enabled);
    const s = get().settings;
    if (s) set({ settings: { ...s, commit_date_show_time: enabled } });
  },

  async setSuppressedAutoOpenPanels(panels) {
    await setSuppressedAutoOpenPanels(panels);
    const s = get().settings;
    if (s) set({ settings: { ...s, suppressed_auto_open_panels: panels } });
  },

  async setWorkingChangesSectionOrder(order) {
    await setWorkingChangesSectionOrder(order);
    const s = get().settings;
    if (s) set({ settings: { ...s, working_changes_section_order: order } });
  },

  async setSwitchDirtyBehavior(behavior) {
    await saveSwitchDirtyBehavior(behavior);
    const s = get().settings;
    if (s) set({ settings: { ...s, switch_dirty_behavior: behavior } });
  },

  async setPullStrategy(strategy) {
    await savePullStrategy(strategy);
    const s = get().settings;
    if (s) set({ settings: { ...s, pull_strategy: strategy } });
  },

  async setStashIncludeUntracked(include) {
    await saveStashIncludeUntracked(include);
    const s = get().settings;
    if (s) set({ settings: { ...s, stash_include_untracked: include } });
  },

  async setPushRecurseSubmodules(mode) {
    await savePushRecurseSubmodules(mode);
    const s = get().settings;
    if (s) set({ settings: { ...s, push_recurse_submodules: mode } });
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
