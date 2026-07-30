# LeGit Backlog

Deferred features and extension ideas - things intentionally postponed, not
forgotten. When a feature is put off ("let it be for now", "later", "future"),
add it here with: what it is, why it's deferred, and a rough approach so it can
be picked up cleanly. Completed items are removed (git history keeps the
record); an item that is partially done keeps only its open remainder.

Last full review: 2026-07-11 (audited every item against the code, dropped
shipped items, re-prioritised). Companion state-of-the-app review:
`design/2026-07-11-state-of-the-app.md`.

---

## Release blockers (v0.9.x -> first public release)

In rough order:

1. **LICENSE file.** The repo has no LICENSE yet - pick one and add it before
   the release is public (the Releases page implies redistribution).
2. **README screenshots.** Add one or two once the UI is deemed presentable,
   and check the README/release-page branding matches the new logo
   (swapped in 2026-07-09).

Decided and recorded, no action: **git is not bundled** (trade study
`design/2026-07-07-bundled-git-trade-study.md`; install-relative config,
size, and CVE ownership; revisit trigger + download-on-demand fallback
design are in the study). Code signing stays deferred with the
SmartScreen/Gatekeeper warnings documented.

---

## Known bugs

- **Commit graph breaks on bigger repos when loading new entries** (reported
  2026-07-30, with screenshot). After the log pages in more commits, the
  graph column degrades: node dots render but the connecting edges between
  rows are missing, so the graph reads as disconnected dots. The lane
  algorithm (`src/panels/Commits/graph/lanes.ts`) claims incremental
  stability under pagination (`previousAssignments`: already-assigned
  commits keep their lanes, slot state is reconstructed before continuing),
  so the suspects are that reconstruction seam and the edge/span computation
  (`graph/spans.ts`) across the page boundary. Repro needs a repo larger
  than the first page; investigate with `graph/lanes.test.ts` /
  `spans.test.ts` style cases that simulate a load-more (two-pass assignment
  with `previousAssignments`) rather than a single full-window pass.

## Git features (missing vs a normal client)

Each follows the same vertical slice: `GitBackend` method -> `cli_impl` via
`GitRunner` (+ parser if it returns data) -> Tauri command (registered in
`lib.rs`) -> wrapper in `lib/commands.ts` + type in `lib/types.ts` -> UI.

- **Worktrees** (add/list/remove) and **bisect**. The two whole-feature gaps
  left vs a full-featured client. Deferred to post v1.0.0 (decided
  2026-07-20).
- **Platform integrations, SSH-first: GitHub, GitLab, Azure DevOps.**
  (Scoped 2026-07-13 with Simon: he authenticates via SSH and uses exactly
  these three platforms.) Lives in the reserved `crates/legit-providers`
  stub. Phased:
  1. *SSH key management* - **shipped 2026-07-13**
     (`commands/ssh_keys.rs` + `Settings/SshKeyTools.tsx`): generate
     (Ed25519 / RSA-4096 for ADO, passphrase-less, into `~/.ssh`), public-key
     copy, platform deep links, `ssh -T` test with output-based
     classification (GitHub exits 1 on success - encoded in unit tests).
     Per profile via `auth_ssh_key`; global = ssh's default keys as a
     filesystem-only field in the global form (zero git-config writes).
     Open follow-ups: passphrase support blocks on the `SSH_ASKPASS` item
     below; the connection test could later surface WHICH account
     authenticated (parse the "Hi <user>!" line).
  2. *Connected accounts* - **PAT flow shipped 2026-07-13**
     (`crates/legit-providers` + `commands/accounts.rs` +
     `Settings/ConnectedAccountsSection.tsx`): paste-a-token connect for all
     three platforms (validated via the platform API), token stored in the
     OS keychain under the broker's `https://<host>` key (settings hold
     metadata only), one-click public-key upload for GitHub/GitLab in the
     SSH key tools, scope-prefilled token-creation deep links. Open
     remainder: **OAuth device flows** (GitHub client-id-only, GitLab
     device grant, Entra device code for ADO) - blocked on registering app
     client IDs (Simon's account/org), the code seam is
     `legit_providers::validate_token`. Self-hosted GitLab hosts are also
     out (gitlab.com fixed for now).
  3. *HTTPS auth via the broker* - **shipped 2026-07-13** with phase 2 plus
     hardening: connect/disconnect evict the broker's session cache for the
     host (`forget_session`: the cache is consulted BEFORE the keychain, so
     a stale entry would shadow the new token until restart), and
     `list_connected_accounts` reports live keychain presence, so a token
     git erased (revoked) shows as "reconnect needed" instead of silently
     looking connected. Remaining edge: legacy `org.visualstudio.com` ADO
     remotes miss the `dev.azure.com` keychain entry (only if it hurts).
  4. *(Separate product decision)* repo listing for the clone dialog,
     PR/issue surfaces.
- **SSH passphrase prompting** (`SSH_ASKPASS` shim mode): the credential
  helper covers HTTP(S) only; encrypted SSH keys without an agent still
  fail non-interactively. Also relevant to generated keys from the
  integrations item above (passphrase-protected keys need this or an
  agent).
- **Keychain management UI**: list/forget credentials LeGit remembered
  (today: delete the "LeGit Git Credentials" entries in the OS keychain).
- **Line-ending normalization: skip-unstaged refinement.** The Normalize
  block shipped 2026-07-29 (spec:
  `docs/superpowers/specs/2026-07-29-renormalize-line-endings-design.md`):
  `.gitattributes` covers-all writer + `git add --renormalize` with a
  throwaway-index preview in `LineEndingsRepoSection`. Open remainder:
  `--renormalize` implies `-u`, so it also stages pending unstaged edits of
  tracked files - v1 warns with a count in the confirm step; a refinement
  could restrict the pathspec to files without unstaged edits.
- **Git LFS-aware content views.** LeGit is already LFS-*compatible* for the
  core workflow (real git CLI inherits the user's `git-lfs` filters), but
  content views that read committed blobs (`git show <rev>:<path>` / diff at
  a revision) do NOT smudge, so File View / Blame / Diff at a revision show
  the ~3-line LFS pointer instead of the real content (working-tree views
  are fine). Fix options: (a) minimal - detect a pointer blob (starts with
  `version https://git-lfs.github.com/spec/`) and render a placeholder like
  the existing binary-file handling; (b) later - smudge on demand (gated for
  size/network). Also consider a warning when `.gitattributes` has
  `filter=lfs` but `git-lfs` isn't installed.

## Smaller follow-ups

- **Files panel:** untrack a folder (`rm_cached` needs `-r` for a
  directory); persist view mode / show-ignored (ephemeral component state
  today; mirror `changed_files_view_mode`); escape `*`, `?`, `[` in
  `gitignore_line` (a filename
  containing them would become a glob).
- **Git Log panel:** filter/search the log, copy a command, jump a toast to
  its specific log entry (today it just opens the panel).
- **Refs panel: click jumps the Commits panel to the ref** (requested
  2026-07-30). Clicking a branch, stash or tag in the Refs panel should
  scroll the Commits panel to that ref's commit and select it. The
  mechanism exists: panels already point the graph at a commit via
  `notifyIfOpen("log", sha)` (File History, Blame, Search do this), so the
  Refs row click resolves the ref to its tip/stash commit and sends that.
  To decide: whether the loaded window must be extended when the target
  commit is beyond the currently paged rows (same problem as jumping a
  toast to a log entry).
- **Commits panel: search/filter the commit list** (requested 2026-07-30).
  Find commits by subject/author/sha (possibly by touched path). The graph
  walk is paged, so a client-side filter over loaded rows is incomplete;
  likely a query mode that runs `git log --grep/--author/-- <path>` and shows
  a flat filtered result list (with jump-to-commit back in the graph), rather
  than filtering the graph itself.
- **Saved window layout with reset** (requested 2026-07-30). One saveable
  layout: a "save current layout" action snapshots the panel arrangement,
  and a reset button restores it whenever the user has rearranged things.
  Both docks already persist their live layout to localStorage
  (`legit.repo-dock-layout` / `legit.global-dock-layout`, envelope
  `{ dockview, placements, fallbacks }`); the saved layout = a second copy
  of those envelopes, applied via the same restore path (must go through
  the existing normalizations, e.g. RefsPanel's `headerSize` patching).
  UI: save/reset actions in the View menu.
- **"Open in editor" on more file rows.** Shipped 2026-07-11 for Files /
  Working Changes / Changed Files (`repo_open_file_in_editor`, `$FILE`,
  shared `OpenInEditorMenuItem`); File History, Compare, and Search share
  `CopyPathMenuSection` and could get the same entry.
- **Interactive rebase polish:** drag-to-reorder rows, reword as a plan step
  (needs per-commit message injection), warning when the plan rewrites
  pushed commits. (Reword beyond HEAD as a standalone feature was dropped
  2026-07-05 by decision - not planned.)
- **E2E extensions.** Discard-with-confirm, branch create/switch, and stash
  create/pop specs added 2026-07-11 (awaiting their first CI runs). Still
  open: clone-via-"+"-menu flow, and push/pull against a local bare-remote
  fixture (`buildRemoteFixture`). Keep it a small smoke suite; Linux-only
  remains fine.
- **Frontend consolidation (from the 2026-07-11 hardening review, section
  D).** Deliberately parked: shared Popover/useDismissable for the 6
  hand-rolled dropdowns, shared composite file-row menu section, STALE
  query-time constants, summon-registry cross-check test, fixed-px padding
  sweep, theme.css value-equality test, GlobalSettingsPanel split (1309
  lines), GitBackend naming normalization (batch with the next backend
  feature). The `crates/legit-providers` keep-or-delete question is
  resolved: **keep** - it hosts the SSH-first platform-integrations item
  under "Git features".
- **Submodules:** nested-tree overview (deliberately flat for now);
  hide-the-Refs-pane-when-no-gitlinks (paneview layouts persist panes);
  `--shallow-submodules` on clone when depth + submodules are both set
  (skipped: fails on servers without reachable-sha1 fetch support).

## Only if it hurts in practice

- **Diff viewer: cross-hunk syntax highlighting.** Per-hunk Lezer parsing
  shipped 2026-07-05; constructs opened before the hunk's context window
  still mis-parse. Full fidelity means fetching both full blobs, parsing
  each once, and mapping by line number - only worth it if the per-hunk
  approximation proves insufficient.
