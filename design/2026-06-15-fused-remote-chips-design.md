# Fused local + remote branch chips

**Date:** 2026-06-15
**Status:** Approved design, pending implementation plan

## Goal

In the Commits panel's Refs column, when a local branch and its configured
upstream remote branch sit on the **same commit** (e.g. `dev` and
`origin/dev`), render them as a **single fused chip** to show they belong
together. Remote branches get a visually distinct treatment (color + icon).
All chip colors become theme-configurable.

Inspired by GitKraken's branch/remote grouping.

## Decisions (from brainstorming)

- **Combine rule:** use *actual git tracking config* (a branch's configured
  upstream), not name-matching. Two refs fuse only when (a) the local branch's
  configured upstream is that remote ref, **and** (b) both refs decorate the
  same commit.
- **Chip layout:** option **C** — the local (blue) branch pill with a trailing
  remote indicator (a cloud glyph today). The indicator is isolated in a
  `RemoteIndicator` component so it can later be swapped for a per-remote
  service logo without touching chip logic.
- **Remote color:** remotes use a distinct hue (violet by default), separate
  from genuine "other" refs (notes/stash).
- **Tracking data source:** implement the existing `branches()` backend stub
  properly (it is the natural home and a future Branches panel needs it).
- **Chip color theming:** full control — explicit `bg` / `border` / `fg`
  tokens per chip type (matching the existing `diff.added.bg/fg` precedent).
- **Locking:** the fused chip locks the **local** branch (unchanged behavior).
  Remote-only chips are **not lockable** in v1.
- **Ahead/behind indicators:** out of scope for v1.

## 1. Backend

### 1.1 `RefDecoration::Remote` variant
`crates/legit-core/src/types.rs`: add a `Remote(String)` variant to
`RefDecoration` (full ref, e.g. `refs/remotes/origin/dev`).

`crates/legit-core/src/cli_impl/parsers/log.rs`: `classify_ref` routes
`refs/remotes/…` to `RefDecoration::Remote` instead of `Other`. Genuine other
refs (notes, stash) remain `Other`.

`src/lib/types.ts`: mirror with `{ type: "remote"; value: string }` in the
`RefDecoration` union (matches the `#[serde(tag="type", content="value",
rename_all="camelCase")]` representation).

### 1.2 Implement `branches()`
`crates/legit-core/src/cli_impl/mod.rs`: replace the `NotYet` stub with an
implementation backed by a single `git for-each-ref` over `refs/heads` and
`refs/remotes`, parsed into the existing `Branch { name, is_current,
is_remote, upstream, head }`. `upstream` comes from the `%(upstream)` field
(empty → `None`).

A new parser module (e.g. `cli_impl/parsers/branches.rs`) handles the
`for-each-ref` output, with unit tests.

### 1.3 `repo_branches` command
- `src-tauri/src/commands/repo.rs` (or a new `branches.rs`): add a
  `#[tauri::command] repo_branches(repo_id) -> Result<Vec<Branch>, AppError>`.
- Register it in `src-tauri/src/lib.rs` (invoke handler + specta export).
- `src/lib/commands.ts`: add a `repoBranches(repoId): Promise<Branch[]>`
  wrapper. Add the `Branch` type to `src/lib/types.ts` if not already generated.

## 2. Data flow (frontend)

`src/panels/Commits/CommitsPanel.tsx`:
- Fetch `repoBranches()` once per repo via react-query (same pattern as the
  log query; keyed by `[repo.id, "branches"]`).
- Build an **upstream map**: `Map<localFullRef, upstreamFullRef>` from
  branches where `is_remote === false && upstream != null`
  (e.g. `refs/heads/dev` → `refs/remotes/origin/dev`).
- Pass the map down to `RefsCell` alongside the existing `knownRefs`.

## 3. UI rendering

### 3.1 Chip descriptor builder
`src/panels/Commits/cells/refChips.ts`: introduce `buildChips(decorations,
upstreamMap)` that turns the flat decoration list into ordered, typed chip
descriptors. This supersedes the remote-detection currently done by
string-matching in `orderDecorations`.

Descriptor kinds: `head`, `headOf`, `fusedBranch` (local + its upstream
remote), `branch` (local, no matching remote on this commit), `remote`
(standalone), `tag`, `other`.

Fusion logic, per commit:
1. For each local `branch` decoration, look up `upstreamMap.get(localRef)`.
2. If that upstream ref is also present at this commit as a `remote`
   decoration → emit a `fusedBranch { local, remote }` and consume that
   remote so it is not also rendered standalone.
3. Remaining `remote` decorations → standalone `remote` chips.

Ordering buckets (unchanged intent): HEAD pair → fused/local branches →
remotes → tags → other. Within a bucket, preserve git's order (stable sort).

### 3.2 Chips and styles
`src/panels/Commits/cells/RefsCell.tsx`:
- New `remote` chip variant (violet) for standalone remote chips
  (`☁ origin/feature-x`, stripping `refs/remotes/`).
- `fusedBranch` chip: the local branch pill (blue, with the checked-out
  emphasis rules unchanged) plus a trailing `RemoteIndicator`.
- New `RemoteIndicator` component: renders the cloud glyph in the remote
  color today; takes the remote name/ref so a future logo lookup is a
  localized change.
- `chipStyle` reads CSS variables (`var(--ref-branch-bg)`, etc.) instead of
  hardcoded `rgba(...)`.

### 3.3 Tooltips & locking
- Tooltips: fused → `dev → origin/dev`; remote-only → full ref.
- Locking: the fused chip's context menu locks the **local** branch ref
  (unchanged). Standalone remote chips have no lock menu in v1.

## 4. Theme tokens

Make all ref-chip colors themeable with explicit `bg` / `border` / `fg`
tokens per chip type, under a new **Refs** token group.

New tokens (`src/theme/tokens.ts` `TOKEN_CONTRACT`, group `"Refs"`):

```
ref.branch.bg / ref.branch.border / ref.branch.fg
ref.branch.current.bg / ref.branch.current.border / ref.branch.current.fg
ref.remote.bg / ref.remote.border / ref.remote.fg
ref.tag.bg / ref.tag.border / ref.tag.fg
ref.head.bg / ref.head.border / ref.head.fg
```

The existing `branch.current.fg` token stays for backward compatibility (it
is referenced elsewhere); `ref.branch.current.fg` is the chip-specific one.
(Resolve overlap during implementation — prefer the new `ref.*` tokens in the
chip and leave the old token untouched if other consumers exist.)

Corresponding work:
- `src/theme/tokens.ts`: add `PALETTE_CONTRACT` entries for the new colors and
  `TOKEN_CONTRACT` descriptors with documentation strings.
- `src/theme/defaults.ts`: add palette entries (translucent hex for bg/border,
  solid for fg) and token→palette mappings, preserving the current visual
  appearance as the default (blue local, green current, gold tag, red HEAD,
  violet remote).
- `themes/Dark.legit-theme.json` and `themes/Light.legit-theme.json`: add the
  same palette entries and token mappings, with values appropriate to each
  theme (light-mode variants for Light).
- The Theme Editor picks these up automatically via the contract.

Default palette values (Dark; carries over current look):

| chip | bg | border | fg |
|------|------|--------|-----|
| branch (local) | `#50a0ff26` | `#50a0ff73` | `#78b4ff` |
| branch.current | `#64c86433` | `#64c864b3` | `#82dc82` |
| remote | `#aa82ff26` | `#aa82ff73` | `#b996ff` |
| tag | `#dcaa3c26` | `#dcaa3c73` | `#dcaa3c` |
| head | `#f0646430` | `#f0646480` | `#f08282` |

(Light-theme equivalents chosen during implementation.)

## 5. Edge cases

- **Diverged** (local ahead/behind upstream → different commits): no fusion.
  Local renders as a normal blue chip at its commit; the remote as a violet
  chip at its commit.
- **Multiple remote refs on one commit:** only the configured upstream fuses;
  any unrelated remote ref (e.g. a different remote's same-named branch that
  is not the upstream) renders as its own violet chip.
- **No upstream configured:** local → plain blue chip; remote (if present) →
  violet chip.
- **Detached HEAD / tags / notes:** unchanged.

## 6. Testing

- **Rust:** unit tests for `classify_ref` (the new `Remote` case) and for the
  `for-each-ref` branches parser (current branch, remote, upstream present /
  absent, no branches).
- **TypeScript:** unit tests for `buildChips` covering: fused (local+upstream
  same commit), diverged (no fusion), multi-remote (only upstream fuses),
  no-upstream, remote-only, and ordering.
- **Manual:** verify against a repo with a tracked branch in sync, a diverged
  tracked branch, and a remote-only branch.

## Out of scope (v1)

- Ahead/behind counts or arrows on chips.
- Locking remote-only branches to lanes.
- Per-remote service logos (the `RemoteIndicator` is structured to allow this
  later).
