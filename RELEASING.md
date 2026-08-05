# Releasing LeGit

LeGit uses Tauri's built-in bundler. Each platform must be built natively — cross-compilation is not supported.

## Pre-release checklist

1. Decide on the version number (semver, e.g. `0.9.0`)
2. Update `Cargo.toml` → `[workspace.package] version = "0.9.0"`
3. Update `src-tauri/tauri.conf.json` → `"version": "0.9.0"`
4. Update `package.json` → `"version": "0.9.0"`
5. Smoke-test **upgrade over the previous version** on Windows: with the
   previous release installed, run the new NSIS `.exe` — it must replace the
   old install (one entry in Apps, new version, `themes/` intact). See
   "Windows upgrade behaviour" below for the cross-format caveats.
6. Commit: `git commit -am "chore: bump version to 0.9.0"`
7. Tag: `git tag v0.9.0`

The release workflow refuses to build if the tag disagrees with any of the
three version files (`verify-version` job in `release.yml`) — a forgotten bump
fails fast instead of drafting a release with the old version.

## Automated release (recommended)

Pushing a version tag builds every platform and drafts a GitHub Release with
the installers attached, via `.github/workflows/release.yml`
(`tauri-apps/tauri-action`):

```bash
git push origin main
git push origin v0.9.0
```

Then: repo → **Releases** → the drafted **LeGit v0.9.0** → review the notes and
assets → **Publish**. No secrets beyond the default `GITHUB_TOKEN` are needed
(builds are unsigned). Matrix: Windows (`.msi` + NSIS `.exe`), macOS
Apple Silicon **and** Intel (`.dmg`), Linux (`.deb` + `.AppImage`).

## Building manually (fallback)

Run the following command on each OS:

```bash
npm run tauri build
```

Artifacts are written to `src-tauri/target/release/bundle/`.

### Windows artifacts
| File | Location |
|------|----------|
| `LeGit_0.9.0_x64-setup.exe` (NSIS installer) | `bundle/nsis/` |
| `LeGit_0.9.0_x64_en-US.msi` | `bundle/msi/` |

### macOS artifacts
| File | Location |
|------|----------|
| `LeGit_0.9.0_x64.dmg` | `bundle/dmg/` |

### Linux artifacts
| File | Location |
|------|----------|
| `le-git_0.9.0_amd64.deb` | `bundle/deb/` |
| `le-git_0.9.0_amd64.AppImage` | `bundle/appimage/` |

## Creating the GitHub Release

1. Go to the repository → **Releases** → **Draft a new release**
2. Tag: `v0.9.0` (use the tag created above)
3. Title: `LeGit v0.9.0`
4. Write release notes (features, fixes, known issues)
5. Attach all artifacts listed above from each platform build
6. Publish the release

## Windows upgrade behaviour

Verified against Tauri bundler 2.11.4 (live-tested 2026-07-09 for the NSIS
paths; MSI paths verified from the WiX template and MSI property tables):

- **NSIS `.exe` over NSIS** (per-user → per-user): works, including silent
  (`/S`). The installer kills a running `legit-app.exe` **by process name**
  (any instance of the current user, dev builds included) before replacing
  files. Downgrades are also allowed (`allowDowngrades` defaults to true).
- **MSI over MSI** (per-machine): works via WiX major upgrade. This depends
  on a stable `UpgradeCode`, which Tauri derives from the product name
  ("LeGit"); it is **pinned** in `tauri.conf.json`
  (`bundle.windows.wix.upgradeCode`) so renaming the product can never break
  upgrades. Never change that value.
- **NSIS `.exe` while an MSI install exists**: the per-user NSIS installer
  detects the per-machine MSI (DisplayName + Publisher match in HKLM) and
  tries `msiexec /x` on it — without elevation this **fails with "unable to
  uninstall"** and the install aborts. This is what broke installing over a
  previous version in 0.9.0. Workaround for users: uninstall the MSI version
  first (elevated), then run the `.exe`.
- **MSI while an NSIS install exists**: the MSI has no logic to remove an
  NSIS install — the result is two side-by-side entries in Apps.

Both installers are shipped deliberately (decision 2026-07-09): the NSIS
`.exe` is the default download for users, the `.msi` serves per-machine /
managed deployments. Release notes must present the `.exe` first and note
that switching formats requires uninstalling the other one first.

## Notes

- No code signing is configured — users will see an OS security warning on first run (expected for early releases)
- CI produces macOS **Apple Silicon and Intel** builds; **Linux ARM** is still not produced
- **AppImage requires a native Linux environment** — this only affects *manual* WSL2 builds (`linuxdeploy` needs FUSE). The CI Linux runner is native, so it builds both `.deb` and `.AppImage`; for a local WSL2 build, produce `.deb` there and `.AppImage` on a native Linux machine or VM
- The release workflow drafts the release; a maintainer reviews and publishes it
