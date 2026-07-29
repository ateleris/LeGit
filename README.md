# LeGit

[![CI](https://github.com/ateleris/LeGit/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/ateleris/LeGit/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/ateleris/LeGit)](https://github.com/ateleris/LeGit/releases/latest)

A fast desktop **Git GUI** — a [Tauri 2](https://v2.tauri.app) app with a Rust
backend and a React + TypeScript frontend. LeGit drives the real `git` CLI
rather than reimplementing git, so it works with your existing git config,
hooks, credential helpers, and Git-LFS setup.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/hero_dark.png">
  <img src="docs/screenshots/hero_light.png" alt="LeGit main window: branches, commit graph, changed files, and diff viewer">
</picture>

## Features

- Commit graph, working changes with hunk- and line-level staging, interactive
  rebase, stashes, branches, remotes, tags, submodules, reflog.
- Diff viewer (inline + split, editable) with optional syntax highlighting;
  Blame; File History; per-revision File View; a repo-wide Files tree.
- Remote sync (fetch / pull / push) with an in-app credential prompt and git
  identity profiles.
- Fully themeable palette → token system (light + dark); the whole UI scales
  from a single font-size setting.

## Design decisions

- **LeGit runs your installed git, never its own.** Every operation shells
  out to the `git` binary on your system (2.34+); nothing is reimplemented or
  bundled. Your config, hooks, aliases, credential helpers, SSH agents,
  proxies, and Git-LFS behave exactly as they do on the command line. The
  binary can be overridden globally or per repo.
- **Settings follow git's own scope model.** App settings exist at global and
  per-repo scope, mirroring `git config`: a repo-level setting overrides the
  global one, and anything unset in the repo inherits the global default.
- **LeGit stores no secrets.** Authentication stays in your existing setup:
  SSH keys and git credential helpers (e.g. Git Credential Manager). LeGit's
  in-app credential prompt is appended per invocation at the *end* of the
  helper chain, so helpers you configured always win. Identity profiles
  switch name, email, and SSH key per repo.
- **git never blocks invisibly.** All git invocations run non-interactively
  (no hidden editor or terminal prompt can stall an operation); anything that
  genuinely needs input, like a credential or a merge decision, is surfaced
  in the UI.
- **Errors are git's errors.** When something fails you see git's actual
  message, classified into actionable feedback where possible, never a
  generic wrapper. Recovery steps that fail (e.g. restoring an auto-stash)
  are reported too, so you always know where your data is.
- **Destructive actions confirm first.** Deleting a branch, dropping a stash,
  and similar actions require an inline confirmation (this can be turned off
  in settings).

## Install

### Download (recommended)

Grab the build for your OS from the [Releases](../../releases) page:

| OS | Files |
|----|-------|
| Windows | `.msi`, or `-setup.exe` (NSIS) |
| macOS | `.dmg` |
| Linux | `.AppImage`, or `.deb` |

> Builds are not code-signed yet, so your OS may warn on first launch:
> Windows SmartScreen → **More info → Run anyway**; macOS → right-click →
> **Open**.

### Build from source

Prerequisites:

- [Rust](https://rustup.rs) 1.77+
- [Node.js](https://nodejs.org) 20.19+ (22+ recommended)
- `git` on your `PATH`
- The [Tauri v2 system prerequisites](https://v2.tauri.app/start/prerequisites/)
  for your OS (WebView runtime, build tools, etc.)

```bash
npm install
npm run tauri:dev      # run in development (uses a separate dev app identity)
npm run tauri:build    # produce an installer/bundle under src-tauri/target/release/bundle/
```

## Releasing

Version, bundle, and GitHub-release steps live in [RELEASING.md](RELEASING.md).
Tagged releases (`v*`) are built and published automatically by
[`.github/workflows/release.yml`](.github/workflows/release.yml).
