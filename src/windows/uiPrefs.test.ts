import { describe, expect, it } from "vitest";
import { bootUiPrefs, refreshUiPrefs } from "./uiPrefs";
import { useSettingsStore } from "../store/settings";
import { useThemeStore } from "../store/themes";

describe("bootUiPrefs", () => {
  it("boots settings init then theme reload, never theme init", async () => {
    const calls: string[] = [];
    useSettingsStore.setState({
      init: async () => {
        calls.push("settings.init");
      },
    } as never);
    useThemeStore.setState({
      init: async () => {
        calls.push("themes.init");
      },
      reload: async () => {
        calls.push("themes.reload");
      },
    } as never);
    await bootUiPrefs();
    expect(calls).toEqual(["settings.init", "themes.reload"]);
  });
});

describe("refreshUiPrefs", () => {
  it("applies settings strictly before the theme", async () => {
    const calls: string[] = [];
    let settle!: () => void;
    useSettingsStore.setState({
      reload: () =>
        new Promise<void>((r) => {
          settle = () => {
            calls.push("settings.reload");
            r();
          };
        }),
    } as never);
    useThemeStore.setState({
      reload: async () => {
        calls.push("themes.reload");
      },
    } as never);
    const done = refreshUiPrefs();
    expect(calls).toEqual([]);
    settle();
    await done;
    expect(calls).toEqual(["settings.reload", "themes.reload"]);
  });
});
