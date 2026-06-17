import { useSettingsStore, UI_FONT_SIZE_DEFAULT } from "../../../store/settings";

/**
 * Row height + icon size for `FileTree`, scaled by the global UI font size
 * (22px / 14px at the default 12px base). Shared by the Changed Files and
 * Working Changes panels so they stay consistent.
 */
export function useFileRowMetrics(): { rowHeight: number; iconSize: number } {
  const uiFontSize = useSettingsStore((s) => s.settings?.ui_font_size ?? UI_FONT_SIZE_DEFAULT);
  const fontScale = uiFontSize / UI_FONT_SIZE_DEFAULT;
  return {
    rowHeight: Math.round(22 * fontScale),
    iconSize: Math.round(14 * fontScale),
  };
}
