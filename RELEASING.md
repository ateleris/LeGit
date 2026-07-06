# Releasing LeGit

LeGit uses Tauri's built-in bundler. Each platform must be built natively — cross-compilation is not supported.

## Pre-release checklist

1. Decide on the version number (semver, e.g. `0.9.0`)
2. Update `Cargo.toml` → `[workspace.package] version = "0.9.0"`
3. Update `src-tauri/tauri.conf.json` → `"version": "0.9.0"`
4. Commit: `git commit -am "chore: bump version to 0.9.0"`
5. Tag: `git tag v0.9.0`

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

## Notes

- No code signing is configured — users will see an OS security warning on first run (expected for early releases)
- CI produces macOS **Apple Silicon and Intel** builds; **Linux ARM** is still not produced
- **AppImage requires a native Linux environment** — this only affects *manual* WSL2 builds (`linuxdeploy` needs FUSE). The CI Linux runner is native, so it builds both `.deb` and `.AppImage`; for a local WSL2 build, produce `.deb` there and `.AppImage` on a native Linux machine or VM
- The release workflow drafts the release; a maintainer reviews and publishes it
