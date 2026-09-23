import { describe, expect, test } from "vitest";
import { EXPECTED_PLATFORMS, buildUpdaterJson } from "./updater-json.mjs";

const API = "https://api.github.com/repos/ateleris/LeGit";

// The v1.3.3 release's asset list as the build matrix uploads it.
const ASSETS = [
  { id: 1, name: "latest.json" },
  { id: 2, name: "LeGit_1.3.3_aarch64.app.tar.gz" },
  { id: 3, name: "LeGit_1.3.3_aarch64.app.tar.gz.sig" },
  { id: 4, name: "LeGit_1.3.3_aarch64.dmg" },
  { id: 5, name: "LeGit_1.3.3_x64.app.tar.gz" },
  { id: 6, name: "LeGit_1.3.3_x64.app.tar.gz.sig" },
  { id: 7, name: "LeGit_1.3.3_x64.dmg" },
  { id: 8, name: "LeGit-1.3.3-1.x86_64.rpm" },
  { id: 9, name: "LeGit-1.3.3-1.x86_64.rpm.sig" },
  { id: 10, name: "LeGit_1.3.3_amd64.AppImage" },
  { id: 11, name: "LeGit_1.3.3_amd64.AppImage.sig" },
  { id: 12, name: "LeGit_1.3.3_amd64.deb" },
  { id: 13, name: "LeGit_1.3.3_amd64.deb.sig" },
  { id: 14, name: "LeGit_1.3.3_x64-setup.exe" },
  { id: 15, name: "LeGit_1.3.3_x64-setup.exe.sig" },
  { id: 16, name: "LeGit_1.3.3_x64_en-US.msi" },
  { id: 17, name: "LeGit_1.3.3_x64_en-US.msi.sig" },
];

const SIGNATURES = Object.fromEntries(
  ASSETS.filter((a) => a.name.endsWith(".sig")).map((a) => {
    const installer = a.name.slice(0, -".sig".length);
    return [installer, `sig-of-${installer}\n`];
  }),
);

const build = (assets = ASSETS, signatures = SIGNATURES) =>
  buildUpdaterJson({ version: "1.3.3", notes: "n", pubDate: "2026-09-23T00:00:00Z", apiBase: API, assets, signatures });

const assetIdOf = (json, key) => Number(json.platforms[key].url.split("/").pop());

describe("buildUpdaterJson", () => {
  test("serves every expected platform key from the matching installer", () => {
    const json = build();
    expect(Object.keys(json.platforms)).toEqual([...EXPECTED_PLATFORMS].sort());
    expect(json).toMatchObject({ version: "1.3.3", notes: "n", pub_date: "2026-09-23T00:00:00Z" });
    expect(assetIdOf(json, "darwin-aarch64")).toBe(2);
    expect(assetIdOf(json, "darwin-aarch64-app")).toBe(2);
    expect(assetIdOf(json, "darwin-x86_64")).toBe(5);
    expect(assetIdOf(json, "linux-x86_64-rpm")).toBe(8);
    expect(assetIdOf(json, "linux-x86_64-deb")).toBe(12);
    expect(assetIdOf(json, "windows-x86_64-nsis")).toBe(14);
  });

  test("bare os-arch keys fall back to MSI on Windows and AppImage on Linux", () => {
    const json = build();
    expect(assetIdOf(json, "windows-x86_64")).toBe(16);
    expect(assetIdOf(json, "linux-x86_64")).toBe(10);
  });

  test("urls are API asset urls and signatures are the trimmed .sig contents", () => {
    const entry = build().platforms["windows-x86_64-msi"];
    expect(entry).toEqual({
      url: `${API}/releases/assets/16`,
      signature: "sig-of-LeGit_1.3.3_x64_en-US.msi",
    });
  });

  test("an installer without its .sig fails instead of shipping an unverifiable entry", () => {
    const { ["LeGit_1.3.3_amd64.deb"]: _, ...signatures } = SIGNATURES;
    expect(() => build(ASSETS, signatures)).toThrow("LeGit_1.3.3_amd64.deb has no LeGit_1.3.3_amd64.deb.sig");
  });

  test("a release missing a platform's installers fails and names the stranded keys", () => {
    const withoutWindows = ASSETS.filter((a) => !/\.msi|setup\.exe/.test(a.name));
    expect(() => build(withoutWindows)).toThrow(
      "release lacks installers for: windows-x86_64, windows-x86_64-msi, windows-x86_64-nsis",
    );
  });

  test("two installers claiming the same key fail", () => {
    const duplicate = [...ASSETS, { id: 99, name: "LeGit_1.3.3_x64_de-DE.msi" }];
    const signatures = { ...SIGNATURES, "LeGit_1.3.3_x64_de-DE.msi": "s" };
    expect(() => build(duplicate, signatures)).toThrow("windows-x86_64 is served by both");
  });
});
