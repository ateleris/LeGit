# Large staged file warning

Status: approved design, not yet implemented.

## Intent

A file accidentally not gitignored (a build artifact, an asset dump) should
be NOTICED before it enters history. Non-blocking: a warning banner in the
commit composer when any staged file exceeds a size threshold; the user can
still commit.

## Approaches considered

1. Commit composer banner (chosen): the last gate every commit passes;
   reuses the existing banner pattern (identity-missing, hook-rejected).
2. Row badge at stage time: earlier but easy to overlook; flagging unstaged
   files would mostly hit legitimate junk. Rejected.
3. Both. Rejected: the badge adds little once the banner exists.

## Decisions

- **Measure the staged INDEX blob, not the worktree file**: `git diff
  --cached --raw -z --no-abbrev --no-renames` (entries staged relative to
  HEAD; a bare `ls-files --stage` would list the whole index and warn
  forever on every committed big file) + `git cat-file
  --batch-check=%(objectsize)` over stdin. This measures exactly what
  enters history and automatically exempts LFS-tracked files (their staged
  blob is a small pointer). Both are batched: two git invocations total,
  regardless of staged-set size.
- **Threshold setting**: global `large_file_warn_mb` (default **10**, `0`
  disables; clamped in `normalized()`), with the usual per-repo
  `Option<u32>` override (`None` = inherit). MB = 10^6 bytes. Settings UI:
  a number field in the existing global + repo settings sections (manifest
  keywords: "large", "file", "size", "warning", "commit").
- **Backend**: new `GitBackend` method `staged_blob_sizes() ->
  Vec<(path, u64)>` (name final at build time); threshold comparison and
  formatting stay frontend-side, so the setting changes without re-querying
  git. Covered by a `flow_tests/` sequence test (incl. `expect_stdin`) and a
  `git_flows.rs` real-git case (big staged file reports its size; an
  LFS-pointer-sized entry stays small; conflict stages skipped).
- **Frontend**: query `[repoId, "status", "staged-sizes"]`, enabled while
  the composer renders with staged entries and threshold > 0, invalidated
  with the status domain (watcher keeps it live). Banner above the message
  box, warning icon + "N staged file(s) larger than 10 MB:" + per-file
  `path (23.4 MB)` lines, tokens/`--fz-*` only. Commit stays enabled.
- CHANGELOG bullet under Added.

## Non-goals

- Blocking the commit, "ignore once" persistence, stage-time badges,
  worktree-size scanning of untracked files.

## Left to the builder

- Exact parser/format-constant placement next to the other `ls-files`
  parsers; MB formatting helper (one decimal) as a pure tested function.
