// Pins: a global-setting write sends ONLY the changed field(s) through
// patch_global_settings and caches the merged result the backend returns.
// Sending a whole cached struct would write stale command-owned fields back
// (same failure class as the repo-side lane-lock wipe).
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GlobalSettings } from "../lib/types";

const merged = { confirm_discard: false, ui_font_size: 14, commit_avatars: true };
const patchGlobalSettings = vi.fn(
  (_patch: Partial<GlobalSettings>): Promise<GlobalSettings> =>
    Promise.resolve(merged as GlobalSettings),
);
vi.mock("../lib/commands", () => ({
  api: {
    patchGlobalSettings: (p: Partial<GlobalSettings>) => patchGlobalSettings(p),
    getGlobalSettings: vi.fn(),
    setWatcherEnabled: vi.fn(() => Promise.resolve(null)),
  },
}));

import { useSettingsStore } from "./settings";

describe("settings store patch path", () => {
  beforeEach(() => {
    patchGlobalSettings.mockClear();
    useSettingsStore.setState({
      settings: { confirm_discard: true, ui_font_size: 12 } as GlobalSettings,
    });
  });

  it("a typed setter sends only its own field", async () => {
    await useSettingsStore.getState().setConfirmDiscard(false);

    expect(patchGlobalSettings).toHaveBeenCalledTimes(1);
    expect(patchGlobalSettings.mock.calls[0]).toEqual([{ confirm_discard: false }]);
  });

  it("caches the merged settings the backend returns, not a local spread", async () => {
    await useSettingsStore.getState().setConfirmDiscard(false);

    expect(useSettingsStore.getState().settings).toEqual(merged);
  });

  it("the auto-fetch interval is sent as an integer with a floor of 1", async () => {
    await useSettingsStore.getState().setAutoFetchIntervalMinutes(0.4);

    expect(patchGlobalSettings.mock.calls[0]).toEqual([{ auto_fetch_interval_minutes: 1 }]);
  });
});
