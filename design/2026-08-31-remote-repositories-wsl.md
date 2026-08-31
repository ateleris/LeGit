# Remote repositories (WSL), v1 — architecture & manual test checklist

LeGit can open repositories that live inside a WSL distribution while the app
runs on Windows, VS Code-Remote-style: a small `legit-agent` process runs in
the distro and does everything repo-side. This note records the architecture,
the decisions behind it, and the Windows-only manual test checklist (the
automated story is summarized at the end).

## Architecture (the executor cut)

The agent is deliberately DUMB. It hosts exactly four capabilities next to the
repo: run git (`GitRunner`, the same one the app uses locally), repo-side
filesystem access (`RepoFs`), the filesystem watcher (`legit-watch`, native
inotify — the whole reason `\\wsl.localhost\` was never an option), and
detached process spawns (editor launch). Every parser, composed flow, and
error classification stays in the app's `legit-core`: the wire surface
(`legit-proto`) is ~20 methods and stable, so agent redeploys are rare, and
the entire real-git flow suite covers remote repos automatically
(`legit-agent/tests/remote_git_flows.rs` runs the identical suite through a
spawned agent — the release gate).

Crates: `legit-watch` (extracted watcher core), `legit-proto` (NDJSON frames,
bidirectional: the agent also sends requests — credential relay),
`legit-host` (`Host` trait; `LocalHost`; `RemoteHost` with a swap-on-reconnect
`HostConn` so sessions survive agent death in place), `legit-agent` (musl-
static bin). App side: `src-tauri/src/remote/` (locator, wsl.exe transport +
deploy, connection lifecycle).

Key mechanisms, each with its reason:

- **Locators.** A repo is identified by a locator string; local = the bare
  path (zero persistence migration — old recents parse unchanged), WSL =
  `wsl://<distro>/<abs posix path>`. `repo_hash_locator` keeps local hashes
  byte-identical (pinned by test) and hashes remote locators case-sensitively.
- **One agent per distro**, repos multiplexed by request id over one NDJSON
  stdio channel (`wsl.exe -d <D> --exec /bin/sh -lc 'exec <agent> --stdio'`;
  login shell so git sees the user's own env — `SSH_AUTH_SOCK`, PATH,
  proxies). The app discards banner noise until the agent's READY line.
- **Deploy** pipes the binary over wsl.exe stdin into a version-keyed path
  (`~/.local/share/legit/agent/<version>/`) with an atomic rename — never the
  9P share. Exact version match at handshake; mismatch → redeploy. Bundling
  gotcha (bit us 2026-08-31): in Tauri's `bundle.resources` MAP, a trailing
  `/` on the target only means "directory" for GLOB sources; for a
  single-file source the target is the full target FILE path, so
  `"agent/legit-agent-x86_64": "agent/"` shipped a file literally named
  `agent` (and the two arches clobbered each other) → "bundled agent binary
  missing" at runtime. `tauri.windows.conf.json` must map each binary to its
  full `agent/legit-agent-<arch>` target; verify by listing the NSIS
  installer (`7z l LeGit_*-setup.exe`) for `agent/legit-agent-x86_64`.
- **Backpressure.** The console's pager semantics survive the wire via
  per-stream credit windows: the agent sends at most `window` unacked events,
  then stops draining its bounded channel → git blocks, exactly like a local
  pager (pinned by loopback tests, incl. cancel-under-pressure).
- **op_state stays one round trip**: `RepoFs::probe_many` batches all 13
  candidate git-dir probe files (existence + content) per poll.
- **Credentials/askpass relay.** Agent-side git re-execs the agent as its
  credential helper / SSH askpass (appended LAST via `GIT_CONFIG_*`, so the
  user's WSL helpers keep winning), which forwards over a 0700 Unix socket →
  `cred.request` on the control channel → the app's existing broker (session
  cache / OS keychain / UI prompt). Helper hangup (killed git) cancels the
  prompt. WSL2→Windows localhost TCP was rejected (NAT mode breaks it).
- **Reconnect.** Agent death (stdio EOF; `wsl --shutdown`) marks the host
  down, fails in-flight calls with AgentGone, toasts once per distro, and
  retries 1s/2s/5s/then 15s while the distro still has open tabs. Reconnect
  swaps the connection INTO the existing `RemoteHost` (same sessions, same
  repo ids), re-registers watches, and emits a full-domain invalidation.
  Closing a distro's last tab releases its agent (stdin EOF) so the WSL VM
  can idle out.
- **`legit .` launcher**: a POSIX script installed on every connect
  (`~/.local/share/legit/bin/legit`, symlinked into `~/.local/bin` when it
  exists) that execs the Windows exe (path recorded per-connect in
  `host-exe`, `C:\… → /mnt/c/…`) with `--open wsl://$WSL_DISTRO_NAME<abs>`;
  `tauri-plugin-single-instance` (registered first) forwards it to the
  running app, and a fresh launch stashes it until after restore
  (`take_pending_open`).
- **UX**: "Open in WSL…" in the add-repo menu and Repositories panel (distro
  picker via `wsl -l -q` — UTF-16LE decoded — + registry default; `~/...`
  expands against the agent's home). Recents/tabs show a distro chip. Reveal
  in Explorer uses `\\wsl.localhost\<distro>\...`; open-in-editor spawns the
  template inside the distro (`code .` → VS Code Remote via interop).

## Deliberate v1 limits (BACKLOG has the details)

SSH hosts (protocol is transport-agnostic; needs an SshTransport + locator
scheme); remote clone/init; per-host + remote per-repo git binary overrides
(remote uses PATH `git`); a dedicated AgentGone error variant (surfaces as an
Io message today); binary sidecar frames (handshake reserves `encodings`).

## Manual test checklist (Windows + real WSL)

Fixture: a repo on the ext4 side (`~/...` in the distro) — that is the
feature's point. `/mnt/c` repos (e.g. LeGit-Test) are a secondary sanity case.

1. First connect: Open in WSL… on a stopped distro → picker shows "will
   start"; deploy + cold start stays under ~15s with a busy state; repo opens
   with a distro chip on its tab.
2. Upgrade: bump the app version, reconnect → silent redeploy (new
   `agent/<version>/` dir), old version dirs eventually pruned (best-effort).
3. Watcher: edit/commit in a WSL terminal → panels refresh live.
4. `wsl --shutdown` mid-session → sticky "Connection to <distro> lost" toast;
   tabs stay; within ~15s the distro restarts, "Reconnected" toast, data
   refreshes; watcher works again (re-registered).
5. App exit → `wsl -d <D> --exec pgrep legit-agent` finds nothing (stdin EOF
   kill); closing the last tab of a distro does the same without exiting.
6. `legit .` in a WSL shell: app running (window focuses, repo opens) and not
   running (app starts, repo opens after restore); from a subdirectory (opens
   the toplevel); from a non-repo (NotARepo toast); `~/.local/bin` on PATH
   hint on first install.
7. Credentials: HTTPS fetch from a private remote in the WSL repo → the
   in-app prompt appears tagged `[<distro>]`; remember → second fetch is
   silent (keychain shared with local repos); cancel the fetch mid-prompt →
   prompt closes. SSH fetch uses the user's WSL agent/keys untouched;
   a passphrase-protected key without an agent prompts via askpass.
8. Console panel: `log --oneline` pages with backpressure; cancel mid-page
   kills promptly. Header context reads correctly for a WSL repo.
9. Reveal in Explorer opens the `\\wsl.localhost\` folder with the file
   selected; open-in-editor with `code "$ROOT"` opens VS Code Remote.
10. Submodules: open a submodule row of a WSL repo → opens as a WSL repo.
11. Restore: quit with local + WSL tabs open in a custom order → relaunch
    restores both kinds in order (WSL restore tolerates a slow distro start).
12. Recents: mixed local + WSL entries, WSL rows chipped, both reopen.
13. Alpine (musl-only) smoke: connect + open a repo.
14. Per-repo git override on a WSL repo → clear "not supported yet" error.

## Automated coverage (runs on Linux/WSL dev machines and CI)

`cargo test --workspace`: the full real-git suite twice (local executor and
through a spawned agent), loopback protocol edge cases (version mismatch,
credit-window backpressure, cancel-under-pressure, agent death → AgentGone,
remote watch, unknown method, credential relay round trip via real
`git credential fill`), and pure-function pins (locator round-trips +
repo-hash backward compat, UTF-16 wsl output decode, deploy command shape,
`C:\ → /mnt/c`, `~` expansion forms, UNC path form, `--open` argv parse).
Frontend: locator TS mirror tests + the usual suites.
