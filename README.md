# LeGit

[![CI](https://github.com/ateleris/LeGit/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/ateleris/LeGit/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/ateleris/LeGit)](https://github.com/ateleris/LeGit/releases/latest)

## What
A fast desktop **Git GUI** — a [Tauri 2](https://v2.tauri.app) app with a Rust
backend and a React + TypeScript frontend.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/hero_dark.png">
  <img src="docs/screenshots/hero_light.png" alt="LeGit main window: branches, commit graph, changed files, and diff viewer">
</picture>

> [!IMPORTANT]
> **Vibecode disclaimer:** LeGit is built almost entirely through
> AI-assisted development, with me directing, reviewing, and testing the
> result. It has a substantial automated test suite (including one that runs
> every git flow against the real binary) and sees daily use. And since every
> operation is an ordinary invocation of your normal `git` executable (LeGit
> never touches a repository's internals by hand), it cannot do anything
> stranger to your repositories than regular git commands allow.

## Why
After every Git tool I tested was either
- ancient or abandoned
- adding unneeded AI stuff
- using diff colors my colorblind ass cannot differentiate
- or requiring a paid subscription for basic functionality

I decided the world needs another Git tool.  
So I hired the four fastest programmers I knew (Claude and his three subagents Claudette, Claudio, and Klaus) to realize and push back on my ~~not so~~ great ideas.  
<sub>I had to fire the subagents though because they kept on ignoring my wishes (CLAUDE.md).</sub>

What I came up with is a Git GUI that
- has a panel system that lets you arrange it the way you like
- has a theme system that lets you customize almost every color
- wraps your installed git executable to guarantee the same behaviour and config
- has a nice looking commit graph that lets you lock branches to lanes
- warns you (if you want) before you delete something or try to commit to a detached HEAD
- informs you when a file's line endings have changed and reverts them for you (if you wish)
- and is free

## Where
[![Latest release](https://img.shields.io/github/v/release/ateleris/LeGit)](https://github.com/ateleris/LeGit/releases/latest)

## How
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

## Who
<a href="https://github.com/ateleris">
  <img src="https://github.com/ateleris.png?size=100" width="100" alt="Ateleris' avatar"/>
</a>
<a href="https://github.com/beckicious">
  <img src="https://github.com/beckicious.png?size=100" width="100" alt="Simon Beck's avatar"/>
</a>
