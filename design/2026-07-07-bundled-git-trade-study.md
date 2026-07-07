# Trade study: bundling a git executable with LeGit

**Date:** 2026-07-07
**Status:** Decided — recommendation at the end.
**Backlog origin:** "Analyse bundling a git executable with LeGit" (release
readiness). Deliverable: a written recommendation (bundle / don't /
bundle-Windows-only) with the config-inheritance strategy spelled out before
any code.

## Current state (what we'd be changing)

LeGit resolves git as: per-repo `git_path_override` → global
`git_path_override` → `git` on `PATH` (`GitRunner::for_repo`, the overrides
from Settings). Startup probes the binary and enforces
`MIN_SUPPORTED_GIT_VERSION = 2.34.0` (`runner.rs:30`) with clear guidance in
Global Settings when git is missing or too old. The runner deliberately
inherits the OS environment (scrubbing only `GIT_*`/locale) because
Git-for-Windows HTTPS resolution breaks without it, and LeGit's credential
prompt is injected per-invocation via `GIT_CONFIG_*` env — it works with *any*
git binary and lands at the END of the helper list, so GCM/profile helpers
keep winning where configured.

This design is why LFS, credential helpers (GCM), SSH agents, proxies, and
corporate config "just work": LeGit runs the user's git, which sees the
user's full installation.

## What bundling would buy

1. **Removes the "git not installed / too old" failure mode.** Mostly a
   Windows concern: macOS ships git via Xcode CLT (an install prompt away),
   and on Linux git is a package-manager one-liner; on Windows the user must
   find and run an installer.
2. **A known, tested version.** We could pin the exact git we test against
   instead of supporting 2.34 → current.
3. **Precedent exists.** GitHub Desktop embeds git (dugite) + bundles
   git-lfs; Tower and Fork ship a bundled git; SourceTree offers an
   embedded-vs-system choice. So it's a viable model — but note those clients
   also carry the follow-on costs below (GitHub Desktop bundles LFS *because*
   its embedded git can't see a system LFS install cleanly).

## What bundling would cost

### (a) Config/integration breakage — the decisive one

A bundled MinGit does **not** replicate a user's Git-for-Windows install:

- **System-scope config is install-relative.** GCM's
  `credential.helper=manager` and the install-time `core.autocrlf` choice
  live in the Git-for-Windows *system* gitconfig (under its install dir). A
  bundled git has its own (empty) system scope → **GCM silently stops being
  used**, and line-ending defaults can differ from what the user chose at
  install time. MinGit explicitly ships **without** GCM.
- **LFS**: `git lfs` must be found on `PATH` and the filter config must be
  present; bundled-git users without a system git often lack both →
  the class of LFS bugs we currently don't have.
- **SSH**: Git-for-Windows bundles OpenSSH; MinGit's is minimal. Agent/
  `ssh.variant`/`core.sshCommand` setups may behave differently.
- Global (`~/.gitconfig`) config *is* inherited (home-relative), so identity,
  aliases, and user-level helpers survive — the breakage is specifically the
  install-relative pieces, which are exactly the auth/LFS/EOL pieces.

Mitigations exist (point `GIT_CONFIG_SYSTEM` at the user's GfW config when
detected; keep `PATH` inheritance so system `git-lfs`/GCM binaries are
found; rely on LeGit's own credential broker as last resort) — but each one
re-introduces a dependency on the system install, which erodes the entire
benefit: the bundled git is only predictable when the system install is
absent.

### (b) Size and packaging

MinGit 2.55 is ~33–37 MB zipped per architecture (64-bit 37 MB, busybox
variant 32.7 MB, arm64 35.8 MB), several times that unpacked — against a
current LeGit bundle in the tens of MB. Multi-arch Windows (x64 + arm64)
doubles it. macOS/Linux bundles would add similar weight for platforms where
git is nearly always present, which is why "bundle everywhere" is strictly
worse than "bundle Windows-only".

### (c) Security patch ownership — cuts both ways, against us

Git ships several security releases a year, and they are exploited in the
wild: CVE-2025-48384 (July 2025, CVSS 8.1, arbitrary code execution on
clone via crafted submodule + symlink) had public PoCs within days and made
CISA's actively-exploited list. If LeGit bundles git, *we* own shipping
those patches — and until the auto-update story exists (backlog: not
started), a bundled git would realistically stay vulnerable **longer** than
a system git that OS package managers and Git-for-Windows' updater keep
fresh. Shipping a known-vulnerable interpreter inside our installer is a
worse posture than requiring a system install we don't own.

### (d) Licensing

Git is GPLv2. Distributing unmodified binaries alongside LeGit (separate
process, no linking — mere aggregation) does not affect LeGit's own license,
but requires shipping the GPLv2 text and an offer/pointer to the exact
corresponding source (a pinned git-for-windows release link suffices).
Manageable, but a standing compliance chore per release.

## Options considered

| Option | Verdict |
|---|---|
| Bundle everywhere | Rejected — pays (a)–(d) on platforms that don't have the problem. |
| Bundle Windows-only, bundled-first | Rejected — breaks GCM/LFS/EOL defaults for the majority who *do* have Git-for-Windows. |
| Bundle Windows-only, system-first, bundled as fallback | Defensible, but still pays (b), (c), (d) for a shrinking minority, and the fallback path is the least-tested path. |
| **Don't bundle; invest in the missing-git experience** | **Recommended.** |
| Download-on-demand MinGit (Windows, only when no system git) | Fallback plan if post-release support data shows real onboarding loss. Avoids (b) in the installer, but (a)/(c) still apply to those users; requires download+verify infrastructure. |

## Recommendation

**Don't bundle.** LeGit's core architectural bet — drive the user's real git
so their config, credentials, LFS, and SSH all work untouched — is
incompatible with owning the binary: every mitigation for the config breakage
re-couples the bundled git to the system install it was meant to replace.
The one real gain (Windows first-run without git) is better served by
sharpening what already exists:

1. Keep the startup git probe as the single gate (already implemented:
   detection, version check, Settings guidance, per-repo/global overrides).
2. Polish the no-git first-run into a real onboarding state: a clear
   "Install Git for Windows" panel with a link (and `winget install
   Git.Git` hint) plus a Re-check button — cheap, no new failure modes.
3. State the support policy explicitly: LeGit requires git ≥ 2.34 on PATH or
   via the git-path setting; git security updates are the OS/installer's
   responsibility — deliberately so.

**Revisit trigger:** if post-release feedback shows meaningful user loss at
the "no git installed" step, implement the download-on-demand fallback
(Windows-only, system-first) with this config-inheritance strategy, spelled
out now as required by the backlog item:

- Resolution order becomes: repo override → global override → system `git`
  (PATH) → downloaded MinGit. The downloaded git is used **only** when no
  system git ≥ 2.34 exists, and Settings must show which git is in use.
- Keep full env inheritance (existing runner behavior) so a later-installed
  system LFS/GCM is found via PATH immediately.
- If a Git-for-Windows install appears later, prefer it automatically (the
  PATH hit wins again); the downloaded copy is a bridge, not a home.
- LeGit's credential broker (already a helper of last resort via
  `GIT_CONFIG_*`) covers HTTPS auth for MinGit's missing GCM; SSH stays
  best-effort until the `SSH_ASKPASS` backlog item lands.
- Pin the MinGit version + SHA-256 in the app, download from the official
  git-for-windows release, verify the hash, and bump the pin as part of every
  LeGit release checklist (this is where the CVE-ownership cost is paid).
- Ship the GPLv2 notice + source pointer for the pinned version.

## Sources

- MinGit sizes, releases: [git-for-windows releases](https://github.com/git-for-windows/git/releases), [MinGit page](https://gitforwindows.org/mingit.html) (MinGit ships without GCM)
- CVE-2025-48384: [NVD](https://nvd.nist.gov/vuln/detail/cve-2025-48384), [Datadog analysis](https://securitylabs.datadoghq.com/articles/git-arbitrary-file-write/), [CISA active-exploitation warning](https://www.bleepingcomputer.com/news/security/cisa-warns-of-actively-exploited-git-code-execution-flaw/), [GitHub blog security announcement](https://github.blog/open-source/git/git-security-vulnerabilities-announced-6/)
- Client precedent: GitHub Desktop (dugite, bundles git + LFS), SourceTree (embedded vs system choice), Tower/Fork (bundled) — e.g. [client comparisons](https://www.git-tower.com/blog/best-git-client)
