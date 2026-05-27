# LeGit — v0.3 Milestone Plan

> Companion to DESIGN.md and the v0.2 plan. v0.3 introduces the panel
> relationships model (DESIGN.md §5.4) and validates it end-to-end with
> a small but real pair of panels: a flat Log + Commit Details.

---

## A. Goal

v0.3 proves the **panel relationships model** introduced in DESIGN.md
§5.4. The shell stays dockable; panels gain the ability to summon each
other based on selection, restoring hidden panels at their last-known
location. After v0.3 the shell is the right foundation for every real
Git panel that follows.

This is a deliberate "validate before building" milestone, in the same
spirit as v0.1 (validate the Git-execution chokepoint via Console) and
v0.2 (validate scope-typed settings via per-repo Git binary override).
v0.3 does not yet make LeGit usable for daily Git work — Status,
Branches, and Diff remain ahead. But every panel after v0.3 sits on a
shell that is known to handle summons correctly, and the visual idiom
"click X, see Y" is established before it has to support a dozen
relationships.

The proving consumer is a **flat Log panel and a Commit Details panel**.
This is a real driver/target pair: Log lists commits, clicking one
summons Commit Details with that commit's metadata. The pair is useful
on its own (browsing history) and exercises every part of the
mechanism (registration, declaration, summon, payload, placement
memory, persistence).

A flat Log without the commit graph is deliberately incomplete. The
graph renderer is the headline v1 differentiator and adding it to an
existing Log panel later is additive — the panel already exists, has
data, has selection, and drives Commit Details. The graph is one piece
of work on top of all of that.

---

## B. Carry-Overs from v0.2

Bundled into v0.3 and shipped before the new work begins, so v0.2
surfaces are clean when v0.3 lands.

### B.1 `warn_on_mixed_endings` Toggle (§H.6)

The backend setting already exists and is respected. v0.3 adds the
toggle in the Global Settings panel and an override in the Repo
Settings panel, matching the existing scope pattern.

### B.2 On-Focus Refresh for Line Endings Panels (§H.9)

The Global and Repo Line Endings panels reload their state when the
user focuses the panel. Implementation: `dockview` provides a panel
focus event; the panels wire their TanStack Query refetch to it. This
pattern will recur for Log (panel focus → refetch the recent commits)
so landing it first on the simpler case is good preparation.

### B.3 "Discard Unsaved Changes?" Prompt (§H.4)

Resolved by treating the prompt as a panel-internal concern rather
than a `dockview` close-veto concern: the panel intercepts its own
close affordances (the close button, the close keyboard shortcut) and
asks for confirmation before calling `dockview`'s close API. Closing
via the window itself discards changes — documented as a known
limitation, not chased further.

This pattern will recur when Status (v0.4) gets its commit-message
editor.

---

## C. Scope: What's New in v0.3

### C.1 Panel Relationships Mechanism

The shell-level summon mechanism described in DESIGN.md §5.4:

- A `usePanelRegistry()` hook exposing registration metadata.
- A `useSummon()` hook giving driver panels access to
  `summon(targetId, payload)`.
- Placement memory: a per-panel last-known-location store that
  survives restarts. Stored alongside (or inside) the existing dock
  layout JSON.
- The three-case summon behavior: visible → focus + payload, hidden +
  placed → restore + focus + payload, never opened → default
  placement + focus + payload.

The implementation is a small Zustand store plus a layer around
`dockview`'s panel-management API. No new third-party dependencies.

### C.2 Flat Log Panel

Repo-scoped panel, registered to the repo dock. Driver of Commit
Details (its only declared relationship in v0.3).

- Reads from `GitBackend::log()`, which stops returning
  `unimplemented!`. The implementation uses
  `git log --format='%H%x00%P%x00%an%x00%ae%x00%at%x00%cn%x00%ce%x00%ct%x00%s%x00%b%x00' -z`
  (or similar; final format string decided during implementation).
- Rendered as a virtualized list (windowed; large repos must not load
  100k DOM nodes). Library choice: `@tanstack/react-virtual` —
  TanStack ecosystem alignment with TanStack Query already in use.
- Each row shows: short SHA, subject line, author, relative timestamp.
- Single-select: clicking a row summons Commit Details with the row's
  `CommitId`. Selection state is panel-local; survives panel focus
  changes but is not persisted across restarts (an arbitrary "first
  commit" on reopen is fine and matches what Log will eventually do).
- Pagination: v0.3 ships **load-more**, not infinite scroll. The
  initial query returns the most recent N commits (N = 500); a "Load
  more" affordance at the bottom appends the next N. Infinite scroll
  has its own design questions (when to evict from memory, what
  happens to selection if the selected commit scrolls out of the
  loaded window) that v0.3 doesn't need to answer.
- Refetches on panel focus and on Console-command-completed (same
  invalidation rules as v0.2 line-endings panels).
- No filtering, no search, no branch picker. v0.3 shows the log of
  `HEAD`. All of these are real v1 needs and explicit non-scope below.

### C.3 Commit Details Panel

Repo-scoped panel, registered to the repo dock. Target of Log; not a
driver of anything in v0.3.

- Holds `selectedCommitId: CommitId | null` in panel-local state.
- On summon, sets the field. On every change, fetches commit details
  via a new `GitBackend::commit_details(commit_id)` method.
- Renders: full SHA, parents (linked SHAs for future navigation — but
  not clickable in v0.3, they're just text), author + committer with
  full timestamps and timezones, full message (subject + body), and
  the signature status if the commit is signed (`gpg.format`, signer
  identity, verification result).
- Empty state when `selectedCommitId` is null: "Select a commit in
  Log to see its details here."

`GitBackend::commit_details()` is implemented via
`git cat-file -p <sha>` for the raw commit object plus
`git verify-commit <sha>` for signature verification (the latter only
if the commit appears to have a signature, to avoid an unnecessary
subprocess per click). Parsing lives in `cli_impl/parsers/commit.rs`
(see §F.2).

The **changed-files** list for the selected commit is **not** in v0.3.
It would be a third panel (and a second driver/target pair: Commit
Details → Diff), and v0.3 is already validating the mechanism with
one pair. Adding the changed-files panel is the obvious early v0.4
work.

### C.4 Two Real Parsers

`parsers/log.rs` and `parsers/commit.rs` are created. Both are pure
functions over captured `git` output with unit-test corpora, following
the §4.3 layering. This is the first real test of the parser pattern
since v0.1 deferred it and v0.2 only did config-file parsing.

Test corpora include:

- Unicode in author names, committer names, and commit messages.
- Multi-parent commits (merges).
- Signed commits (both GPG and SSH).
- Unsigned commits.
- Commits with empty bodies.
- Commits with very long messages.
- Edge: commits with byte sequences that resemble field delimiters.
  The format string uses `%x00` and `-z` for field termination; the
  parser must handle the case where a message body contains a NUL
  legitimately (rare but possible — `-z` semantics handle it via
  record boundaries, but the parser code path needs the test).

### C.5 The `RepoSession.backend` Fix

The latent bug from the v0.2 implementation note. Although v0.3's
panels could in principle go through `runner` directly (Log and Commit
Details are read-only and v0.4's Status is what would force the fix
naturally), v0.3 fixes it now as hygiene — it's small, in mind, and
removing it now means v0.3 panels can call trait methods as the
intended idiom without inheriting a known-broken pattern.

The fix: `GitCliBackend` stops holding `Arc<GitRunner>` and instead
holds the same `Arc<RwLock<Arc<GitRunner>>>` handle the session holds.
Each backend method reads the current runner out of the lock at call
time, holding the lock only for the `Arc::clone`. No trait signature
changes; no command surface changes.

A decision-log row goes on this; see §J.

---

## D. Explicit Non-Scope

### D.1 Commit Graph Rendering

The headline v1 differentiator. v0.3 ships a flat list; the graph is
later work that adds a renderer above an already-working Log panel.
Bundling them collapses two milestones into one and risks the
graph-rendering work blocking the summon-mechanism validation.

### D.2 Status Panel

Moved out of v0.3. The original "full Status in v0.3" plan put a large
panel on an unproven shell. v0.3 proves the shell; Status becomes
v0.4 and slots into the now-validated foundation.

### D.3 Diff Panel and Changed-Files List

A natural early-v0.4 addition (Commit Details → Diff would be the
second summon relationship). Not in v0.3.

### D.4 Branch Picker / Filtering / Search in Log

All real Log needs; all v1. v0.3's Log is `HEAD`'s history, full
stop.

### D.5 Filesystem Watcher

v0.3 relies on Console-command-invalidation + on-focus refresh +
manual refresh. A real fs-watcher is v0.4+ work that benefits Status,
Branches, and Diff; build it once for three consumers.

### D.6 Cross-Panel Synchronization Beyond Summon

The summon mechanism is one-shot: driver fires, target updates. v0.3
does not introduce shared selection stores, cross-panel highlighting,
or any other "panels react to each other beyond explicit summon."
Those are deferred until a real need names them.

### D.7 Multi-Summon / "Summon Group"

A driver could summon two targets in one event (Log click → Commit
Details *and* Changed Files). The mechanism handles this by the
driver calling `summon()` twice. v0.3 does not introduce a primitive
for grouped summons — premature.

---

## E. Frontend Changes

### E.1 The Panel Registry Gains Relationship Metadata

The existing scope-typed panel registry (from v0.2) gains two fields:

```ts
interface PanelRegistration {
  id: string;
  scope: "global" | "repo";
  // existing v0.2 fields...

  // New in v0.3:
  defaultPlacement?: DefaultPlacement;
  summons?: string[];  // panel IDs this panel may summon
}
```

`summons` is informational/auditable. `defaultPlacement` is used only
the first time a panel is opened on a given install.

### E.2 The Summon Store

A small Zustand store with one operation:

```ts
interface SummonStore {
  summon: (targetId: string, payload: unknown) => void;
}
```

The store internally:

1. Looks up `targetId` in the registry.
2. Checks visibility via the dock layout.
3. Picks the case (visible / hidden+placed / never-opened) and acts.
4. Routes the payload to the target.

Payload routing is via a per-target Zustand store the target panel
owns. The summon store calls a known method on the target store
(`receivePayload(payload)`) by convention. No reflection, no
event-bus magic — just direct calls.

### E.3 Placement Memory

A per-panel `PanelPlacement` record:

```ts
interface PanelPlacement {
  region: "left" | "main" | "right" | "bottom";  // or similar
  groupId?: string;       // tab group within region
  position?: number;      // order within group
  size?: number;          // relative size
  lastSeenAt: number;     // epoch ms, for debugging
}
```

Stored in the same JSON as the dock layout, in a `placements` block
keyed by panel ID. When a panel is closed via `dockview`, the shell
captures its current location into this block.

This is the part most likely to want iteration. dockview's exact
location-describing primitives may make `region` / `groupId` /
`position` more or less natural; the schema above is illustrative and
will be refined in implementation.

### E.4 Repo Dock Default Layout Refresh

The repo dock currently has one panel (Console) from v0.2. With Log
and Commit Details landing in v0.3, the default repo layout (the one
new installs see; the one shown if the saved layout is corrupt or
missing) is updated to:

- Main area: Log.
- Right column: Commit Details.
- Bottom: Console (collapsed/minimized but accessible).

Existing v0.2 installs preserve their saved layout. The new panels
appear in their `defaultPlacement` positions because they weren't in
the saved layout.

---

## F. Backend Changes

### F.1 `GitBackend` Trait Methods Filled In

- `log(opts: LogOptions) -> Vec<Commit>` — implemented via
  `parsers/log.rs`.
- `commit_details(id: &CommitId) -> CommitDetails` — implemented via
  `git cat-file -p` + optional `git verify-commit`, parsed by
  `parsers/commit.rs`.

`LogOptions` in v0.3 is intentionally minimal:

```rust
pub struct LogOptions {
    pub max_count: usize,   // page size
    pub skip: usize,        // for load-more
    // Future: refs, paths, since, until, author, grep, ...
}
```

The trait method exists with the future fields anticipated by name
but not yet implemented. Adding them is additive.

### F.2 `parsers/log.rs` and `parsers/commit.rs`

Pure functions, full test corpora as described in §C.4. The format
string used by `log()` is defined as a constant next to the parser
(per §4.5: "format strings are defined as constants next to the
command and the parser, so the contract between them is visible").

### F.3 `RepoSession.backend` Fix

Per §C.5. Pure refactor of `GitCliBackend` to hold the shared runner
handle. No trait signature changes; no command surface changes.

### F.4 New Domain Type: `CommitDetails`

`Commit` (from §4.4) carries identity + author + committer + message
+ timestamp + signature. `CommitDetails` extends this with anything
the Commit Details panel needs that isn't already in `Commit`:

```rust
pub struct CommitDetails {
    pub commit: Commit,
    pub verification: Option<SignatureVerification>,  // from verify-commit
    pub raw_object: String,                            // for power-user view
}
```

Whether `raw_object` ships in v0.3's UI is a small UX call. Including
it in the domain type now is free; surfacing it is one toggle.

---

## G. Long-Running Operations

Nothing new in v0.3. `log` and `cat-file` are fast even on large
repos for the page sizes in scope. Streaming patterns (§7.3) wait for
push/fetch in a later milestone.

---

## H. Persistence

Additions to the persistence story:

- **Placement memory** for panels (§E.3), in the dock layout JSON
  under a new `placements` block.
- **Log page size** as a Global Settings entry (default 500; user can
  raise or lower). Repo-scoped override possible but not implemented
  in v0.3.

Nothing else changes. Settings file formats are forward-compatible
(per v0.2 §D.4); adding `placements` to the layout JSON is
backward-compatible because missing means "no memory yet."

---

## I. Success Criteria

v0.3 is done when:

1. The author can browse `HEAD`'s history in a real repo through the
   Log panel, click commits, see Commit Details respond, and have the
   shell behave correctly across hide/show/restore cycles.
2. The summon mechanism behaves correctly in all three cases (visible,
   hidden + placed, never opened) for the Log → Commit Details
   relationship.
3. Placement memory survives LeGit restarts. Closing Commit Details
   in a specific dock location, restarting LeGit, clicking a commit
   → Commit Details opens in that location.
4. The Log parser handles the test corpus in §C.4 including Unicode,
   merges, signed/unsigned, empty bodies, long messages.
5. The Commit Details parser correctly extracts metadata and
   signature verification for both GPG and SSH signed commits.
6. The `RepoSession.backend` fix works end-to-end: changing the
   per-repo Git binary while Log is open causes subsequent `log()`
   calls to use the new binary without a session restart.
7. The v0.2 line-endings carry-overs ship as part of v0.3.

---

## J. Decision Log Additions (to append to DESIGN.md §11)

The general panel-relationships rows (paradigm, summon-vs-move,
placement memory, relationship surface, payload routing) were applied
to DESIGN.md §11 alongside the §1 and §5.4 changes. The v0.3-specific
additions are:

| Decision                                  | Choice                                                                | Why                                                                                              |
| ----------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| v0.3 milestone framing                    | Validate panel-relationships shell; defer Status to v0.4              | Building Status on an unproven shell risks retrofitting; matches v0.1/v0.2 validation discipline |
| Proving consumer for summon mechanism     | Flat Log + Commit Details                                             | Genuine driver/target pair; useful on its own; graph adds additively later                       |
| Commit graph rendering                    | Deferred to a later milestone                                         | Headline differentiator; landing it on top of an already-working Log is additive                  |
| Log pagination strategy in v0.3           | Load-more, not infinite scroll                                        | Infinite scroll has unresolved design questions (eviction, scrolled-out selection) v0.3 doesn't need |
| First real per-command parsers            | `parsers/log.rs` and `parsers/commit.rs`                              | Two parsers exercise the §4.3 pattern more robustly than one would                               |
| `RepoSession.backend` fix in v0.3         | Yes, even though not forced by v0.3 panels                            | Hygiene; cheaper to fix while in mind than to inherit into v0.4                                  |
| Changed-files list for selected commit    | Deferred to v0.4 (would be a second summon pair)                      | v0.3 validates the mechanism with one pair; second pair is the early v0.4 work                   |

---

## K. Open Questions

- **Library for placement memory schema.** Implement against
  dockview's location primitives directly or build a small
  abstraction? Probably direct in v0.3; abstract if a second
  user-facing concept (e.g., per-repo layouts) needs the same shape.
- **Default position of Console after the layout refresh.** Bottom
  drawer feels right but Console-as-Cmd-K-overlay was floated earlier.
  v0.3 ships bottom; revisit if dogfooding shows the bottom drawer
  steals too much vertical space from Log.
- **Whether to ship `CommitDetails.raw_object` as a visible "Show raw
  object" toggle in v0.3** or just include the field in the domain
  type for later use. Lean toward "include but don't surface" —
  validates the parser, doesn't require designing a power-user view.
- **What happens when summon arrives for a target whose panel
  implementation hasn't been initialized yet** (it's in placement
  memory but the React component hasn't mounted because the panel was
  closed at restart). The shell needs to ensure the target's state
  store exists before delivering the payload. Implementation detail
  but worth pinning down early.

---

## L. Roadmap Sketch (for v0.3)

1. **Carry-overs.** §B.1, §B.2, §B.3.
2. **`RepoSession.backend` fix.** Pure refactor before any new
   backend code lands.
3. **Summon mechanism scaffold.** Empty Zustand store, registry
   extensions, dockview integration layer. Tested with two throwaway
   panels (a "fake driver" that fires summon, a "fake target" that
   receives) before real panels are wired up.
4. **Placement memory.** Storage + restore logic. Tested with the
   same throwaway panels.
5. **`parsers/log.rs`** with full test corpus.
6. **`GitBackend::log()` implementation** wiring runner + parser.
7. **Log panel: read-only, no summon yet.** Validates the data path
   end-to-end as a standalone panel.
8. **`parsers/commit.rs`** with full test corpus.
9. **`GitBackend::commit_details()` implementation.**
10. **Commit Details panel.** Standalone, can receive payloads.
11. **Wire summon: Log → Commit Details.** The proving moment.
12. **Default repo dock layout refresh.** Log + Commit Details +
    Console.
13. **Dogfood for §I.1.**
