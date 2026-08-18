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
   the release is public (the Releases page implies redistribution). Also
   replace the workspace `license = "TBD"` in Cargo.toml.
2. **Interactive rebase polish** (promoted from "Smaller follow-ups"
   2026-08-06): drag-to-reorder rows, reword as a plan step (needs
   per-commit message injection), warning when the plan rewrites pushed
   commits. (Reword beyond HEAD as a standalone feature was dropped
   2026-07-05 by decision - not planned.)
3. **Manual interactive-rebase test pass** (promoted from "Smaller
   follow-ups" 2026-08-06; naturally follows the polish work above): run the
   feature manually against real histories in `../LeGit-Test` -
   pick/squash/fixup/drop/reorder plans, a plan that conflicts (resolve +
   continue, and abort), and skip - verifying plan execution, conflict UX,
   and the resulting log match expectations.
(LFS blocker resolved 2026-08-17, both halves shipped the same day:
detection + warning banner + Files panel icons (spec:
`docs/superpowers/specs/2026-08-17-lfs-detection-warning-design.md`) and
the pointer placeholder in File View / Diff / Blame (spec:
`docs/superpowers/specs/2026-08-17-lfs-pointer-placeholder-design.md`).
Smudge-on-demand on the placeholder and an explicit "fetch LFS content"
action were **dropped by decision 2026-08-17**: the current version is
always on disk, previously-seen versions sit in `.git/lfs/objects`, and
displaying fetched bytes of a typical LFS binary would still end at the
binary placeholder - the value only materializes with rendered previews,
so the LFS fetch case is folded into the "rich preview for displayable
binary files" item below. Stub recovery stays `git lfs pull` in the
Console, surfaced by the warning banner.)

(Screenshots blocker resolved: `docs/screenshots/hero_{light,dark}.png` are
wired into the README via a theme-aware picture element - verified in the
2026-08-06 review. Only the branding-matches-logo spot check was not
machine-verifiable; eyeball it once before release. Vibecoding disclaimer
added to the README 2026-08-06.)

Decided and recorded, no action: **git is not bundled** (trade study
`design/2026-07-07-bundled-git-trade-study.md`; install-relative config,
size, and CVE ownership; revisit trigger + download-on-demand fallback
design are in the study). Code signing stays deferred with the
SmartScreen/Gatekeeper warnings documented.

---

## Known bugs

(none currently - the diff-viewer cursor-in-chrome-rows bug was fixed
2026-07-31 via `selectionGuard` in `Diff/editableState.ts`, regression tests
in `editableState.test.ts`. The Merge panel was checked as the entry asked:
its fold rows are REAL CodeMirror folds over genuine content - only the
visual band comes from `hunkExpanders`' `headerBand` - so caret behavior
there is native fold UX, not this bug.)

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
- **Auto-push tags with their commit** - **shipped 2026-08-04** (idea +
  refinement + implementation same day). The invariant "a tag whose commit
  is public is public", maintained going forward only, at two trigger
  points: a push also pushes the tags whose target became public through it
  (scoped by diffing `target_on_remote` around the push - never a repo-wide
  sweep of older local tags), and a tag created on an already-public commit
  is pushed immediately. Core: `src/lib/autoPushTags.ts`
  (`resolveAutoPushTags` unit-tested; `pushWithTagFollowUp` wraps all three
  branch-push sites; `autoPushTagAfterCreate` on both create sites). The
  push-flips-`target_on_remote` assumption is pinned in
  `tests/git_flows.rs`. Setting: global (`auto_push_tags`, default off - CI
  release pipelines) + per-repo inherit/on/off override. Deliberately NOT
  `--follow-tags` (annotated-only; row-menu tags are lightweight). Failure
  isolation: tag-push problems toast separately, the branch push still
  succeeds; a same-named remote tag with a different target is skipped with
  a warning, never clobbered. Not built (add only if wanted): an explicit
  one-time "publish all publishable tags" action for pre-existing local
  tags.

- **Git LFS track/pattern-management UI** - v1 SHIPPED 2026-08-18 (spec:
  `docs/superpowers/specs/2026-08-17-lfs-track-management-design.md`):
  list/track/untrack root-`.gitattributes` LFS patterns in the Repo
  Settings "Git LFS" section (`repo_lfs_patterns/track/untrack` in
  `commands/lfs.rs`; nested attribute files listed read-only; untrack
  refuses lines carrying extra attributes; caption warns that
  already-committed files need `git lfs migrate`, out of scope).
  Still deferred, add only on demand: a Files-panel context-menu entry,
  file locking (`git lfs locks`), and an explicit "fetch LFS content"
  action - these matter mainly to asset-heavy teams, which LeGit does
  not currently target.

- **Diff viewer: rich preview for displayable binary files (images, audio).**
  Today any binary file gets the generic binary placeholder. Common git
  clients preview at least images; extend the diff viewer to render a
  preview when the file type supports it: images (PNG/JPEG/GIF/WebP/SVG)
  as old/new side-by-side (and possibly swipe/onion-skin later), audio
  (MP3/WAV/OGG) as a playable element per side. Rough approach: detect the
  type by extension + content sniff (reuse the unified binary-sniff
  window); a backend command returns the blob bytes (`git show <rev>:<path>`
  for committed sides, filesystem read for the working tree) base64- or
  data-URL-encoded with a size cap; the frontend renders `<img>`/`<audio>`
  panes instead of the placeholder, honoring theme tokens for the chrome.
  Keep action parity rules in mind (stage/discard still apply at file
  level only). Ties into the LFS release blocker: once pointer blobs are
  detected, a smudged-on-demand LFS image could use the same preview path.

## Smaller follow-ups

- **Files panel:** untrack a folder (`rm_cached` needs `-r` for a
  directory); persist view mode / show-ignored (ephemeral component state
  today; mirror `changed_files_view_mode`); escape `*`, `?`, `[` in
  `gitignore_line` (a filename
  containing them would become a glob).
- **Git Log panel:** filter/search the log, copy a command, jump a toast to
  its specific log entry (today it just opens the panel).
- **Commits panel: incremental log appending** (decided 2026-07-30). Today
  every window growth (infinite scroll, and the jump-seek that loads until a
  clicked ref's commit appears) refetches the WHOLE window from offset 0 and
  re-parses it - O(n^2) total work, currently mitigated for the seek by
  exponential window doubling (`growJumpWindow`). The clean fix: fetch only
  the next page (`repoLog` already takes an offset) and append - the lane
  algorithm was designed for exactly this (`previousAssignments` keeps
  existing rows stable under appended pages; the edge-loss bug in that
  path was fixed 2026-07-30 - the incremental pass now re-walks the whole
  window with prior lanes pinned, so an incremental result always equals a
  full recompute, pinned by the "load-more … edge set" tests in
  `lanes.test.ts`). Likely React Query infinite-query style. Caveat to design around: offset pages are only
  consistent while refs don't move, so a watcher invalidation mid-walk must
  restart the walk (or re-fetch the full window once). Include a guardrail
  on the auto-seek: past a large bound (~50k commits), stop and ask via
  toast instead of silently walking a huge history. Keep-everything-loaded
  stays the model (industry norm; graph lanes need all rows above, and
  virtualization already makes rendering O(visible)) - windowed unloading
  was considered 2026-07-30 and rejected.
- **Commits panel search: touched-path query kind.** The search bar shipped
  2026-07-30: one box, no mode dropdown - Enter cycles the selection
  through full-history hits inside the intact graph (Shift+Enter
  backwards); hits = message OR author matches (two walks merged), and a
  query that rev-parses (SHA, branch, tag, HEAD~2) becomes the first hit.
  Plus GitExtensions-style type-to-jump quick search over loaded rows.
  Open remainder: a touched-path kind (`git log -- <path>`). NOTE: the
  Search panel was removed 2026-07-30 as redundant - with it went the UI
  for content search (pickaxe `-S` / `-G`) and path search. The backend
  (`search_commits` Content/ContentRegex kinds, `search_paths`) is kept
  and tested; re-adding is a small UI task if content search is missed
  ("when did this string change?" archaeology has no UI today).
- **"Open in editor" on more file rows.** Shipped 2026-07-11 for Files /
  Working Changes / Changed Files (`repo_open_file_in_editor`, `$FILE`,
  shared `OpenInEditorMenuItem`); File History, Compare, and Search share
  `CopyPathMenuSection` and could get the same entry.
- **E2E extensions.** Discard-with-confirm, branch create/switch, and stash
  create/pop specs added 2026-07-11 (awaiting their first CI runs). Still
  open: clone-via-"+"-menu flow, and push/pull against a local bare-remote
  fixture (`buildRemoteFixture`). Keep it a small smoke suite; Linux-only
  remains fine.
- **Frontend consolidation (from the 2026-07-11 hardening review, section
  D).** Deliberately parked: shared Popover/useDismissable for the 6
  hand-rolled dropdowns, shared composite file-row menu section, STALE
  query-time constants, fixed-px padding
  sweep, theme.css value-equality test, GlobalSettingsPanel split (1309
  lines), GitBackend naming normalization (batch with the next backend
  feature). The summon-registry cross-check test shipped 2026-08-06
  (`src/panels/summonRegistry.test.ts`, with the global-settings summon
  fix). The `crates/legit-providers` keep-or-delete question is
  resolved: **keep** - it hosts the SSH-first platform-integrations item
  under "Git features".
- **2026-08-06 state-of-the-app review follow-ups.** Executed 2026-08-06
  (full findings in `design/2026-08-06-state-of-the-app-review.md`):
  backend robustness (loud submodule auto-stash list-read failures, unified
  binary-sniff window, logged session persists), the adopt-the-helper pass
  (`useDelayedBusy` for ~30 settings busy states, `useRepoSwitchClear` in
  six panels, confirmDialog/notify for the window.confirm/alert sites,
  segStyle dedup, save_region_state wrapper), CI `tsc --noEmit`, dead
  surface deleted (decided: `repo_signing_config` / `repo_write_signing` /
  `repo_submodule_init` removed; `repo_search_paths` stays), unused deps
  removed, FileTree focused-row token (`graph.row.focused.bg`), shared
  tag-remote choice (`store/tagRemote.ts` + `resolveTagRemote`), config
  nits. Decided: the Release Notes panel staying View-menu-only is
  intentional. Open remainder - *structural splits, when next touched* (per
  convention): `CommitsPanel.tsx` (1720-line component; queries hook + row
  context menu + RemoteSyncToolbar are natural splits),
  `WorkingChangesPanel.tsx` (1130-line function; CommitComposer + shared
  FileRowMenu), `cli_impl/mod.rs` (4951 lines; submodule + line-ending
  blocks).
- **Internationalization: decide want/need (2026-08-04).** Open product
  question, not a commitment: is a non-English UI worth it for LeGit's
  audience? Today every user-facing string is hardcoded English. Inputs for
  the decision: who the users are (git terminology stays English in most
  clients anyway - "commit", "rebase", "stash" are rarely translated);
  git's own stderr/messages surface untranslated in toasts and the Git
  Command Log regardless, so a translated chrome around English git output
  may feel half-done; effort is a full string extraction pass (hundreds of
  inline strings across panels) plus a library choice (react-i18next /
  lingui) and a process for keeping catalogs current. The 2026-08-04
  panel-title centralization (`PANEL_TITLES` in `registry.tsx`) shows the
  shape a string catalog would take and would be its first consumer. If the
  answer is "not needed", record that decision here and drop the item.
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
