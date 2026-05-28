# Releasing LeGit

LeGit uses Tauri's built-in bundler. Each platform must be built natively — cross-compilation is not supported.

## Pre-release checklist

1. Decide on the version number (semver, e.g. `0.4.0`)
2. Update `Cargo.toml` → `[workspace.package] version = "0.4.0"`
3. Update `src-tauri/tauri.conf.json` → `"version": "0.4.0"`
4. Commit: `git commit -am "chore: bump version to 0.4.0"`
5. Tag: `git tag v0.4.0`

## Building on each platform

Run the following command on each OS:

```bash
npm run tauri build
```

Artifacts are written to `src-tauri/target/release/bundle/`.

### Windows artifacts
| File | Location |
|------|----------|
| `LeGit_0.4.0_x64-setup.exe` (NSIS installer) | `bundle/nsis/` |
| `LeGit_0.4.0_x64_en-US.msi` | `bundle/msi/` |

### macOS artifacts
| File | Location |
|------|----------|
| `LeGit_0.4.0_x64.dmg` | `bundle/dmg/` |

### Linux artifacts
| File | Location |
|------|----------|
| `le-git_0.4.0_amd64.deb` | `bundle/deb/` |
| `le-git_0.4.0_amd64.AppImage` | `bundle/appimage/` |

## Creating the GitHub Release

1. Go to the repository → **Releases** → **Draft a new release**
2. Tag: `v0.4.0` (use the tag created above)
3. Title: `LeGit v0.4.0`
4. Write release notes (features, fixes, known issues)
5. Attach all artifacts listed above from each platform build
6. Publish the release

## Notes

- No code signing is configured — users will see an OS security warning on first run (expected for early releases)
- ARM builds (Apple Silicon, Linux ARM) are not produced yet
- **AppImage requires a native Linux environment** — WSL2 cannot build AppImage because `linuxdeploy` requires FUSE. Build `.deb` on WSL2 and `.AppImage` on a native Linux machine or VM
- When ready to automate, add a GitHub Actions workflow using `tauri-apps/tauri-action`
