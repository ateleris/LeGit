# Watcher startup cost: why restoring repos took a minute

2026-09-01. Reported as "it does not seem to start when I have WSL repos" —
the splash sat on *restoring repositories…* for about a minute.

## What actually happened

From the app's own log (`%LOCALAPPDATA%/ch.ateleris.legit/logs`):

```
08:15:15.837  resolved git version=2.55.0.windows.2
08:15:16.109  open: new session path=/home/orell            id=37ddfcf8…
08:15:16.109  open: new session … (all six sessions, same millisecond)
08:15:46.629  WARN failed to start repo watcher repo_id=37ddfcf8…
              err=OS file watch limit reached ["/home/orell/.nuget/packages/…"]
```

The WSL part was **not** the problem: connecting to the distro, spawning the
agent and probing six repos took ~0.27s (the agent was already installed and
the distro warm; a cold agent deploy adds ~14s once per version). The 30
seconds went into **one** watcher, which then failed.

The set of restored repos included `wsl://ubuntu-work/home/orell` — the user's
entire home directory, which is a real git repo (dotfiles). Measured on that
machine:

| | count |
| --- | --- |
| directories under `/home/orell` | 541,256 |
| directories with symlinks followed | >740,000 (still counting after 90s) |
| entries (files + dirs) | 4,010,711 |
| `find` over it, warm cache | 11.5s |

## Root cause

Two independent things, in the same code path:

1. **The watcher gated opening the repo.** `open_session` awaited
   `start_repo_watcher`, and `restore_open_repos` awaits every session before
   returning, so the splash waited for the slowest watcher in the set.
2. **Registering a watch is O(whole tree).** `WatcherCore::start` calls
   `debouncer.watch(&worktree, Recursive)`. On Linux that walks the tree and
   issues one `inotify_add_watch` per directory; `notify`'s default is
   `follow_symlinks: true`, so the walk also descends into every symlink
   target (package stores, caches — repeatedly). It exceeded the per-user cap
   (`/proc/sys/fs/inotify/max_user_watches` = 1,048,576) and returned
   `MaxFilesWatch` after ~30s.

Platform note: on Linux `notify-debouncer-full`'s `RecommendedCache` is
`NoCache`, so the file-id (rename-stitching) cache costs nothing there. On
**Windows** it is `FileIdMap`, which walks and stats every entry with
`follow_links(true)` — a large local repo pays that cost instead, and a
recursive `ReadDirectoryChangesW` handle is otherwise cheap.

## What changed

- `start_repo_watcher` is spawned, not awaited (`commands/repo.rs`). The repo
  is fully usable while the watch attaches — data is fetched on demand, it
  just is not auto-refreshed yet.
- Because a watch only reports events from registration onward, the repo gets
  one full-domain refresh the moment it goes live
  (`watcher::emit_all_domains_changed`, trigger `<watch-started>`, the same
  mechanism a host reconnect uses). Without it, anything that changed between
  opening the repo and the watch coming up would be silently missed.
- The insert into `AppState::watchers` happens under the `repos` read guard
  and is skipped if the repo was closed meanwhile, so a watch cannot be parked
  for a dead session (`close_repo` needs the write guard, so it cannot slip in
  between).
- `WatcherCore::start` passes `Config::default().with_follow_symlinks(false)`.
  git never looks through a symlinked directory either (it stores the link
  itself as a blob), so the target's contents cannot be a change to this repo.
  Pinned by `symlinked_directories_are_not_watched` in `legit-watch`.

## What is left (BACKLOG, "Smaller follow-ups")

- Gitignored directories are still watched; only their events are filtered.
  Pruning them from the watch set is the real fix for pathological trees.
- A watch that fails to start is still only a log line. It needs a persistent
  surface (a "live updates off" badge on the repo tab) — and the state has to
  live in `AppState`, because an event emitted during restore can precede the
  frontend's listener.

## Testing note

The "watcher must not gate the open" property has no unit seam: `open_session`
needs a `tauri::AppHandle` and `AppState`, and src-tauri has no harness for
either (its tests are pure-function only). The behaviour is recorded here
instead; the symlink half is covered by a real-filesystem regression test.
