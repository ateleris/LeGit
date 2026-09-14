# WSL-only use without a Windows git

2026-09-14. Reported as "a Windows user with only WSL repos still has to
install Git for Windows". They do not need it, and now they are not asked for
it.

## What actually required it

Nothing in the remote path. A repo on a WSL host runs THAT host's git
end to end, and has since the Host seam landed
(`design/2026-08-31-remote-repositories-wsl.md`):

- `resolve_git_for` (`commands/repo.rs`) returns the distro's binary for a
  `Wsl` locator; the app machine's `git_path` is threaded through the open /
  init / clone calls but never spawned for one.
- `probe_and_open` runs `rev-parse --show-toplevel` through the agent.
- `new_repo_target` routes a WSL destination's `init` / `clone` to the
  distro's git (never Windows git over the UNC share).
- `set_git_path` skips remote sessions when hot-swapping the runner.
- Global settings are split per host by `SettingsHost`, with a per-distro
  probe (`wsl_host_git_status`) that already enforces the same version floor.
- Credentials do not need Git for Windows either: LeGit brokers its own
  helper (`credentials.rs`), and helper discovery reads the repo host's
  exec-path.

The requirement was ONE screen: `GitSetupGate` blocked the whole app when the
app machine's `git --version` failed (DESIGN.md §7.6), with no way past (the
"continue anyway" escape exists only for a below-minimum version).

## Decision

The gate now states a narrower rule: **block only when nothing can run git.**

`gateDecision(status, remoteHostsAvailable)`:

| app-machine git | remote host available | result |
| --- | --- | --- |
| missing / unspawnable | no | install screen (as before) |
| missing / unspawnable | yes | the app |
| below the floor | either | the "older than recommended" warning (as before) |
| fine | either | the app |

`remoteHostsAvailable` is `wsl_list_distros()` being non-empty. That call
enumerates with `wsl.exe -l`; it does not connect to or start a distro, and it
returns empty on non-Windows builds, so nothing changes on macOS/Linux. It is
probed only when the local git is unusable, so the common path costs nothing.

The old-git warning was deliberately left alone: it is dismissible, it is
about a binary that IS present, and a mixed user still wants to hear it.

## The three things that had to follow

**Local repo actions need their own explanation now.** They used to be
unreachable behind the gate. `formatRepoError(e, locator)` turns the one
failure whose raw message cannot explain itself - no git on the app machine -
into install guidance, and only for a LOCAL target, so a WSL failure still
reads as the distro's. Wired into open / clone / init at every entry point.

**A WSL host's git needed its own floor check.** Opening a WSL repo only ever
proved that `rev-parse` worked; the floor was enforced only when the user set
an explicit host override in Settings. Since the app-machine gate may now
never run, `ensure_wsl_host` probes the distro's git once per connect and
emits `legit://remote-host-git` when it is missing or below the floor. The
frontend toasts it once per distro per app run (a reconnect loop must not
repeat it).

**Restored tabs must survive a machine without git.** The restore probe
dropped a local entry whose `rev-parse` could not even spawn, which is the
exact state a WSL-only (or temporarily git-less) machine is in - and the drop
is not recoverable, the tab is simply gone next launch. A spawn failure is now
`ProbedEntry::Keep`, the same treatment a down WSL distro already got; only a
probe that ran and answered "not a repo" still drops the entry
(`local_probe_entry`).

## Still local, by design

- Local repositories, obviously: open / init / clone on a Windows path.
- Global Settings' "This machine" git surfaces (identity, signing, credential
  helper, custom config). They degrade on their own - `GitStatusReadout`
  renders the missing-binary state - and the per-distro group next to them is
  the one a WSL-only user wants.
- `ssh_keys.rs` still runs `ssh-keygen` on the app machine, so a key generated
  there is not the key a WSL git will use. Unrelated to the git binary and
  already tracked in BACKLOG.md ("Remote repositories: v1 deferrals").
