import { useSettingsStore } from "../store/settings";
import { useThemeStore } from "../store/themes";

/** Secondary-window boot: settings first (theme choice + font live there),
 *  then the theme via reload() - init()'s setActive would persist the theme
 *  and re-broadcast the settings-changed event on every popup open. */
export async function bootUiPrefs(): Promise<void> {
  await useSettingsStore.getState().init();
  await useThemeStore.getState().reload();
}

/** Settings-changed broadcast handler: strictly sequential - the theme
 *  reload reads active_theme from the settings store, so settings must land
 *  first or a theme switch re-applies the stale theme. */
export async function refreshUiPrefs(): Promise<void> {
  await useSettingsStore.getState().reload();
  await useThemeStore.getState().reload();
}
