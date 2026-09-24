import { create } from "zustand";
import { api } from "../lib/commands";
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
 * clamps in `GlobalSettings::normalized`. */
export const COMMITS_ROW_HEIGHT_DEFAULT = 22;
export const COMMITS_LANE_WIDTH_DEFAULT = 22;
export const COMMITS_DOT_RADIUS_DEFAULT = 8;
export const COMMITS_LINE_WIDTH_DEFAULT = 2;
export const COMMITS_ROW_HEIGHT_MIN = 16;
export const COMMITS_ROW_HEIGHT_MAX = 120;
// Lane width has no fixed minimum — it shares the row height's font-derived
// floor (`minCommitsRowHeight`).
export const COMMITS_LANE_WIDTH_MAX = 120;
export const COMMITS_DOT_RADIUS_MIN = 1;
export const COMMITS_LINE_WIDTH_MIN = 1;

/** Global UI font size (px) — base for the panel text scale and min sizes.
 * Mirror the backend clamp in `GlobalSettings::normalized`. */
export const UI_FONT_SIZE_DEFAULT = 12;
export const UI_FONT_SIZE_MIN = 8;
export const UI_FONT_SIZE_MAX = 24;

/** Write the base font size to the `--ui-font-size` CSS var; the `--fz-*` scale
 * and the font-derived panel min sizes cascade from it. */
export function applyUiFontSize(size: number, root: HTMLElement = document.documentElement) {
  root.style.setProperty("--ui-font-size", `${size}px`);
}

/** Mirror the backend clamps in `GlobalSettings::normalized`. */
export const PANEL_GAP_MAX = 16;
export const PANEL_RADIUS_MAX = 16;
export const PANEL_BORDER_WIDTH_MAX = 8;
export const PANEL_BORDER_WIDTH_DEFAULT = 1;

/** Whether the `.legit-panel-chrome` styles are armed: any non-default value
 * switches from the flush look (shared separator lines) to per-group chrome.
 * A non-default border width alone counts - the thickness only exists on the
 * per-group borders, so setting it must arm them. */
export function panelChromeArmed(gap: number, radius: number, borderWidth: number): boolean {
  return gap > 0 || radius > 0 || borderWidth !== PANEL_BORDER_WIDTH_DEFAULT;
}

/** Write the panel chrome to its CSS vars and arm the `.legit-panel-chrome`
 * styles (per-group borders replacing the between-group separators, outer
 * dock padding). The radius maps onto dockview's `--dv-border-radius`; the
 * BETWEEN-groups gap additionally flows into dockview's `theme.gap`
 * (useDockTheme) - the CSS var covers the dock-edge padding, which dockview's
 * gap does not. With every value at its default the class is absent and the
 * flush look stays untouched. */
export function applyPanelChrome(
  gap: number,
  radius: number,
  borderWidth: number,
  root: HTMLElement = document.documentElement,
) {
  root.style.setProperty("--legit-panel-gap", `${gap}px`);
  root.style.setProperty("--legit-panel-radius", `${radius}px`);
  root.style.setProperty("--legit-panel-border-width", `${borderWidth}px`);
  root.classList.toggle("legit-panel-chrome", panelChromeArmed(gap, radius, borderWidth));
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
  /** Persist a partial settings patch and cache the merged result the backend
   * returns. Every typed setter below routes through this; panels needing a
   * field without a setter may call it directly. Command-owned fields (git
   * path, theme, watcher, session bookkeeping, profiles, accounts) are
   * refused by the backend — use their dedicated commands. */
  patchSettings: (patch: Partial<GlobalSettings>) => Promise<GlobalSettings>;
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
  setTagsSortMode: (mode: RefsSortMode) => Promise<void>;
  setUiFontSize: (size: number) => Promise<void>;
  setPanelChrome: (gap: number, radius: number, borderWidth: number) => Promise<void>;
  setWatcherEnabled: (enabled: boolean) => Promise<void>;
  setConfirmDiscard: (confirm: boolean) => Promise<void>;
  setDetectCaseRenames: (enabled: boolean) => Promise<void>;
  setCheckoutNewBranch: (enabled: boolean) => Promise<void>;
  setCheckoutRemoteFastForward: (enabled: boolean) => Promise<void>;
  setSubmoduleAttachBranch: (enabled: boolean) => Promise<void>;
  setAutoFetchEnabled: (enabled: boolean) => Promise<void>;
  setAutoFetchIntervalMinutes: (minutes: number) => Promise<void>;
  setCheckUpdatesOnStartup: (enabled: boolean) => Promise<void>;
  setExternalEditorCommand: (command: string | null) => Promise<void>;
  setCommitAvatars: (enabled: boolean) => Promise<void>;
  setCommitInitials: (enabled: boolean) => Promise<void>;
  setAutoPushTags: (enabled: boolean) => Promise<void>;
  setDiffSyntaxHighlighting: (enabled: boolean) => Promise<void>;
  setCommitDateAbsolute: (enabled: boolean) => Promise<void>;
  setCommitDateFormat: (format: CommitDateFormat) => Promise<void>;
  setCommitDateShowTime: (enabled: boolean) => Promise<void>;
  setLineEndingChipsInChanges: (enabled: boolean) => Promise<void>;
  setWarnOnLineEndingCommit: (warn: boolean) => Promise<void>;
  setSuppressedAutoOpenPanels: (panels: string[]) => Promise<void>;
  setWorkingChangesSectionOrder: (order: string[]) => Promise<void>;
  setSwitchDirtyBehavior: (behavior: SwitchDirtyBehavior) => Promise<void>;
  setPullStrategy: (strategy: PullStrategy) => Promise<void>;
  setStashIncludeUntracked: (include: boolean) => Promise<void>;
  setLaneColoredBranchChips: (enabled: boolean) => Promise<void>;
  setStashBaseLaneColor: (enabled: boolean) => Promise<void>;
  setPushRecurseSubmodules: (mode: PushRecurseMode | null) => Promise<void>;
}

export const useSettingsStore = create<SettingsStore>((set, get) => {
  const patch = async (fields: Partial<GlobalSettings>) => {
    const merged = await api.patchGlobalSettings(fields);
    set({ settings: merged });
    return merged;
  };

  return {
    settings: null,

    async init() {
      if (get().settings) return;
      const settings = await api.getGlobalSettings();
      applyUiFontSize(settings.ui_font_size ?? UI_FONT_SIZE_DEFAULT);
      applyPanelChrome(
        settings.panel_gap ?? 0,
        settings.panel_corner_radius ?? 0,
        settings.panel_border_width ?? PANEL_BORDER_WIDTH_DEFAULT,
      );
      set({ settings });
    },

    patchSettings: patch,

    async setRegionPlacement(placement) {
      await patch({ global_region_placement: placement });
    },

    async setCommitsGraphMetrics(rowHeight, laneWidth, dotRadius, lineWidth) {
      await patch({
        commits_row_height: rowHeight,
        commits_lane_width: laneWidth,
        commits_dot_radius: dotRadius,
        commits_line_width: lineWidth,
      });
    },

    async setChangedFilesViewMode(mode) {
      await patch({ changed_files_view_mode: mode });
    },
    async setBranchListView(mode) {
      await patch({ branch_list_view: mode });
    },
    async setRefsSortMode(mode) {
      await patch({ refs_sort_mode: mode });
    },
    async setTagsSortMode(mode) {
      await patch({ tags_sort_mode: mode });
    },

    // The watcher toggle starts/stops live watchers, so it keeps its own
    // command; the patch command refuses `watcher_enabled`.
    async setWatcherEnabled(enabled) {
      await api.setWatcherEnabled(enabled);
      const s = get().settings;
      if (s) set({ settings: { ...s, watcher_enabled: enabled } });
    },

    async setConfirmDiscard(confirm) {
      await patch({ confirm_discard: confirm });
    },
    async setDetectCaseRenames(enabled) {
      await patch({ detect_case_renames: enabled });
    },
    async setCheckoutNewBranch(enabled) {
      await patch({ checkout_new_branch: enabled });
    },
    async setCheckoutRemoteFastForward(enabled) {
      await patch({ checkout_remote_fast_forward: enabled });
    },
    async setSubmoduleAttachBranch(enabled) {
      await patch({ submodule_attach_branch: enabled });
    },
    async setAutoFetchEnabled(enabled) {
      await patch({ auto_fetch_enabled: enabled });
    },
    async setCheckUpdatesOnStartup(enabled) {
      await patch({ check_updates_on_startup: enabled });
    },
    async setAutoFetchIntervalMinutes(minutes) {
      // Integer + floor of 1 before sending: the field is a u32 and the
      // backend rejects fractions instead of rounding them.
      await patch({ auto_fetch_interval_minutes: Math.max(1, Math.round(minutes)) });
    },
    async setExternalEditorCommand(command) {
      await patch({ external_editor_command: command });
    },
    async setCommitAvatars(enabled) {
      await patch({ commit_avatars: enabled });
    },
    async setCommitInitials(enabled) {
      await patch({ commit_initials: enabled });
    },
    async setAutoPushTags(enabled) {
      await patch({ auto_push_tags: enabled });
    },
    async setDiffSyntaxHighlighting(enabled) {
      await patch({ diff_syntax_highlighting: enabled });
    },
    async setCommitDateAbsolute(enabled) {
      await patch({ commit_date_absolute: enabled });
    },
    async setCommitDateFormat(format) {
      await patch({ commit_date_format: format });
    },
    async setCommitDateShowTime(enabled) {
      await patch({ commit_date_show_time: enabled });
    },
    async setLineEndingChipsInChanges(enabled) {
      await patch({ line_ending_chips_in_changes: enabled });
    },
    async setWarnOnLineEndingCommit(warn) {
      await patch({ warn_on_line_ending_commit: warn });
    },
    async setSuppressedAutoOpenPanels(panels) {
      await patch({ suppressed_auto_open_panels: panels });
    },
    async setWorkingChangesSectionOrder(order) {
      await patch({ working_changes_section_order: order });
    },
    async setSwitchDirtyBehavior(behavior) {
      await patch({ switch_dirty_behavior: behavior });
    },
    async setPullStrategy(strategy) {
      await patch({ pull_strategy: strategy });
    },
    async setStashIncludeUntracked(include) {
      await patch({ stash_include_untracked: include });
    },
    async setLaneColoredBranchChips(enabled) {
      await patch({ lane_colored_branch_chips: enabled });
    },
    async setStashBaseLaneColor(enabled) {
      await patch({ stash_base_lane_color: enabled });
    },
    async setPushRecurseSubmodules(mode) {
      await patch({ push_recurse_submodules: mode });
    },

    async setUiFontSize(size) {
      const clamped = clamp(size, UI_FONT_SIZE_MIN, UI_FONT_SIZE_MAX);
      // Apply immediately for a live preview, then persist (backend re-clamps).
      applyUiFontSize(clamped);
      reapplyPanelConstraints();
      const merged = await patch({ ui_font_size: clamped });
      applyUiFontSize(merged.ui_font_size ?? UI_FONT_SIZE_DEFAULT);
      reapplyPanelConstraints();
    },

    async setPanelChrome(gap, radius, borderWidth) {
      // Apply immediately for a live preview, then persist (backend re-clamps).
      // The gap reaches the docks reactively via the settings state (theme prop).
      const clamped = [
        clamp(gap, 0, PANEL_GAP_MAX),
        clamp(radius, 0, PANEL_RADIUS_MAX),
        clamp(borderWidth, 0, PANEL_BORDER_WIDTH_MAX),
      ] as const;
      applyPanelChrome(...clamped);
      const merged = await patch({
        panel_gap: clamped[0],
        panel_corner_radius: clamped[1],
        panel_border_width: clamped[2],
      });
      applyPanelChrome(
        merged.panel_gap ?? 0,
        merged.panel_corner_radius ?? 0,
        merged.panel_border_width ?? PANEL_BORDER_WIDTH_DEFAULT,
      );
    },
  };
});
