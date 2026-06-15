# LeGit — v0.4 Milestone Plan

> Companion to DESIGN.md and the v0.2 / v0.3 plans. v0.4 introduces the
> commit graph by extending the v0.3 Log panel into a fully columnar
> "Commits" panel with graph rendering, ref decorations, lane locking,
> and user-controllable columns.

---

## A. Goal

v0.4 ships the **commit graph** — the headline differentiator called out
since DESIGN.md §8. It does so by extending the v0.3 Log panel rather
than building a new panel: the existing virtualized list grows a Graph
column and a Refs column, the panel's user-facing name changes to
**Commits**, and the data source extends from `HEAD`'s history to all
local branches so the graph has something interesting to show.

This is the next validation milestone in the v0.1–v0.3 pattern. v0.4
validates two coupled concerns:

1. The **graph rendering pipeline** — lane-assignment algorithm,
   compatibility with the v0.3 virtualization layer, stability under
   pagination, performance budget on real repos.
2. The **first real per-repo UI-preference**: lane locking, persisted
   in `repos/<hash>/settings.json`. The v0.2 per-repo Git binary
   override was a backend-resolution concern; locks are the first
   piece of UI state that lives at repo scope.

These are bundled into one milestone because shipping a graph without
lane locking would not match the author's mental model of "what the
graph should look like" — locked-leftmost `main` is, by intent, part
of the graph's identity rather than a feature added on top of it.
Splitting them would mean v0.4 ships a graph the author considers
incomplete and v0.5 ships the polish that makes it complete; the
inversion of normal milestone discipline is accepted deliberately and
recorded in the decision log (§K).

v0.4 still does **not** make LeGit a usable Git GUI for daily work.
Status remains in v0.5. Diff remains in v0.5. Branches as a separate
panel remains v1+. The bar v0.4 has to clear is "the Commits panel,
together with Commit Details and Console, holds up under sustained
dogfooding as a history-browsing tool" — not "LeGit replaces my Git
GUI."

The reason graph belongs in its own milestone rather than bundled
with Status/Diff: the graph is a **core panel that does not depend
on other panels**. Its dependencies (Log panel from v0.3, commit
parents in the v0.1 domain model, panel-relationships shell from
v0.3) are all in place. Status and Diff each add their own
architectural concerns (filesystem watcher, hunk-level staging,
signing UX surface) that are independent of the graph. Sequencing
the graph first means the project's headline visual differentiator
exists before the rest of v1 is built, and each subsequent panel
lands on a Commits panel that's already validated.

---

## B. Carry-Overs from v0.3

Bundled into v0.4 and shipped before the new work begins, so v0.3
loose ends are closed when v0.4 lands.

### B.1 Console Default Position (resolves v0.3 §K)

v0.3 left open: where does Console sit by default in the repo dock
once Commits grows columns and Commit Details is also present?

Resolved: **Console docks at the bottom, collapsed by default**, with
Commits in the main area and Commit Details in the right column. The
collapsed-by-default state means new installs don't see the Console
unless they explicitly open it, which matches its usage profile
(escape hatch, not primary surface). The existing v0.3 layout is
preserved for existing installs; only the *default* changes.

The default repo dock layout for v0.4 is therefore:

- Main area: Commits.
- Right column: Commit Details.
- Bottom (collapsed): Console.

### B.2 No Other Carry-Overs

v0.3 §K's other open question (library for placement memory schema)
remains open and is explicitly not bundled into v0.4 — it's still
not forced by anything v0.4 builds.

---

## C. Scope: What's New in v0.4

### C.1 The Commits Panel (renamed from Log)

The v0.3 Log panel is renamed in the UI to **Commits**. The registry
id stays `log` — placement memory keyed on `log` continues to work,
the backend method is still `GitBackend::log()`, and `parsers/log.rs`
still parses log output. Renaming the id would force a migration with
no user-visible benefit; renaming only the user-facing title is free.

Internally the panel's responsibilities expand:

- Renders multiple columns instead of v0.3's simple row layout (§E).
- Reads multi-ref log output instead of just `HEAD` (§C.2).
- Parses ref decorations alongside commit data (§H.1).
- Computes graph lanes for the visible window (§F).
- Carries column-preference and lock state (§I).

Everything else from v0.3 — virtualization via
`@tanstack/react-virtual`, load-more pagination at N=500, single-select
driving the Commit Details summon, refetch on panel focus and on
Console-command completion — remains as it was.

### C.2 Multi-Ref Support (`AllLocalBranches`)

`LogOptions` gains a `refs` field with a sum type identifying which
refs the log should walk:

```rust
pub enum RefSelector {
    Head,                    // v0.3 behavior
    AllLocalBranches,        // v0.4 default
    // Future: AllRefs, Custom(Vec<String>), CurrentBranchAndTracking, ...
}

pub struct LogOptions {
    pub max_count: usize,
    pub skip: usize,
    pub refs: RefSelector,
}
```

v0.4 sets `refs: AllLocalBranches` for the Commits panel; the
underlying `git log` invocation gains `--branches` (and `--decorate`
for ref decoration; see §H.1).

There is **no ref picker UI in v0.4.** The selection is hardcoded.
Adding a picker is additive — the `RefSelector` type already has
shape for it, the backend already handles it — and is scoped to a
later milestone.

### C.3 The Refs Column

The Refs column displays which refs (if any) point to each commit. v0.4
shows **local branches and tags only**. Remote-tracking branches
(`origin/main`, etc.) are deliberately deferred to a later milestone
along with the rest of remote-aware UX (fetch status, ahead/behind
indicators, etc.).

Refs are rendered as small labeled chips inside the column's cell, with
visual distinction between branches and tags. The chip for the currently
checked-out branch carries a `HEAD →` prefix (or visually equivalent
indicator) matching `git`'s own decoration convention.

Most commits have no refs pointing to them, so the Refs column is empty
for the vast majority of rows. This is expected and matches every other
Git GUI. The column has a sensible default width — wide enough to show
"main" comfortably plus one tag — and is user-resizable from there.

### C.4 The Graph Column

The Graph column renders lane visualizations for the commits in the
visible window. Lanes are vertical tracks, one per active branch in the
window; each commit sits in exactly one lane; lines connect commits to
their parents.

Width is **dynamic**: the column sizes itself to fit the maximum lane
count in the currently-visible window. Scrolling into a region with
more concurrent branches widens the column; scrolling into a quieter
region narrows it. This is the one column whose width is not
user-controllable (§C.5).

Internally the Graph column is a self-contained rendering block: lanes
render top-to-bottom *within* the column's bounding rect. The column can
be placed at any position in the column order (§C.5); placing it in the
middle of the table is unconventional but mechanically supported because
lanes never leak outside the column's own width.

The lane-assignment algorithm is option 2 (lookahead lane reuse with
incremental stability under pagination) — specified in §F.

### C.5 Column Controls

The Commits panel ships full column controls in v0.4:

- **Reorder.** Drag a column header onto another header; the dragged
  column is inserted to the left or right of the target depending on
  cursor position relative to the target's midpoint.
- **Hide and show.** Right-click any column header for a context menu
  with "Hide this column" and a "Show columns…" submenu listing
  hideable columns. Subject is **not** hideable (the panel without
  Subject would be content-free).
- **Resize.** Drag the right edge of a column header. The Graph column
  is **not** user-resizable — its width is dynamic to lane count.

These controls are global-scope state — column order, visibility, and
widths are user preferences about how the Commits panel looks, not
per-repo data. They live in `global-settings.json` (§I.1).

#### Default column order

On first launch (and any time the saved preference is missing or
corrupt), the column order is:

```
[Refs] [Graph] [Subject] [Date] [Author]
```

with SHA **hidden by default**. The user can show SHA via the
column-visibility menu.

The Refs-first ordering puts ref labels closest to the user's reading
position (left edge), with the graph immediately to their right as
visual context. This is a deliberate departure from the
graph-on-the-far-left convention of most Git GUIs; the rationale is
that scanning history is more often "where is `main`?" than "what does
the lane structure look like here?", and putting labels first serves
the more common scan. Users who prefer the conventional ordering swap
the two columns in one drag.

#### Graph and Refs separation

Graph and Refs are visually paired — branch lines in the Graph column
visually terminate at the ref decoration chips in the Refs column. The
default order keeps them adjacent. If the user reorders them apart, the
visual link is broken but the panel still functions; this is a
self-inflicted configuration, not a design constraint.

A one-time hint may surface the first time a user separates Graph and
Refs (recommending they keep them adjacent), but the user is free to
ignore it.

### C.6 Lane Locking

Lane locking pins a specific branch ref to a specific lane index. Once
locked, commits on that branch always appear in the locked lane,
regardless of where the lookahead algorithm would otherwise place them.

#### Why locking matters

The default lookahead algorithm assigns lanes greedily. The result is
visually reasonable on average histories but unpredictable: `main`
might be in lane 0 today, lane 2 tomorrow after a series of merges
shifts the heuristic's output. Users with an established mental model
of "trunk is on the left, integration branch next to it" want that
model honored visually.

Lane locking gives them that, deliberately, per-repo, opt-in.

#### Storage

A lock is a `(ref_name, lane_index)` pair. Locks are stored per repo in
`repos/<hash>/settings.json` (§I.2) — see the per-repo storage scheme
in v0.2 §B.5.

Locking the **ref name**, not a commit SHA: as `main` advances, the
lock follows the ref. A SHA-locked "lock" would expire on every commit
to main, which is the opposite of what users want.

#### Opt-in, no auto-locking

v0.4 ships with **no automatic lock heuristics**. New repos open with
no locks; the user opts in by right-clicking a ref chip in the Refs
column and selecting "Lock to leftmost lane" or "Lock to 2nd lane from
left" / etc.

This is deliberate. The "auto-lock `main`/`master` on first repo open"
behavior is the obvious convenience, but every heuristic has surprising
edge cases (what about `trunk`? `default`? a repo where `main` doesn't
exist?), and the right answer is more easily found after dogfooding
reveals which manual workflows feel tedious. v0.5 is the natural place
to add auto-locking once the manual interaction has been used enough
to know what to automate.

The doc records this as a forecasted refinement (§K): if dogfooding
shows the manual lock workflow is tedious across many repos, auto-lock
with a setting to disable becomes the obvious v0.5 work.

#### UI for locking

Right-click any ref chip in the Refs column. The context menu shows:

- "Lock to leftmost lane" (only if no lock currently occupies that
  lane).
- "Lock to 2nd lane from left", "3rd lane from left", … up to the
  current max active lane count (or 6, whichever is smaller — beyond
  that the user can type an index).
- "Unlock" (only if this ref is currently locked).
- "Show locks for this repo" (opens a small dialog listing active
  locks; not its own panel).

Lane numbering is **0-indexed in code, position-described in UI**. The
user never sees "Lock to lane 3" — they see "Lock to 4th lane from
left." Internally everything is 0-indexed.

#### Lock conflicts

Two refs cannot be locked to the same lane index. The UI prevents this
by disabling already-claimed lane indices in the context menu.

The backend storage is permissive: it accepts whatever it's written,
and if it ever loads inconsistent state (two locks for the same lane —
e.g., from a hand-edited settings file), the layout algorithm uses the
first lock and ignores the rest. This follows the v0.2 §D.4 pattern
("preserve unknowns silently") for forward-compatibility, with a
`tracing` warning logged.

#### Orphaned locks

When a locked ref is deleted, its lock entry is **preserved silently**
in storage. If the ref is recreated later, the lock takes effect
again. This matches the §6.5 theme-token forward-compatibility pattern
and means renames followed by un-renames don't lose user configuration.

A "Show locks for this repo" dialog flags orphaned locks (greyed-out,
"ref `feature/x` does not exist") with a "Remove" affordance for users
who want to clean them up.

#### Interaction with the lane algorithm

Specified in detail in §F.4. The short version: locked lanes are
pre-reserved before lookahead lane assignment runs; non-locked branches
get assigned to the remaining lanes by the normal heuristic. A
non-locked branch that *terminates* at a commit on a locked ref enters
the locked lane at the merge point but does not claim the locked lane
above the merge point.

---

## D. Explicit Non-Scope

### D.1 Status Panel

Moved to v0.5. v0.3 §D.2 already moved Status out of v0.3 expecting it
in v0.4; v0.4's scoping is "graph first, Status next." The reasoning
holds: Status introduces filesystem watching, signing UX, and write
operations against the working tree — independent concerns that
deserve their own validation rather than being bundled with the graph.

### D.2 Diff Panel and Changed-Files List

Also v0.5. Together with Status, these complete the "useful daily Git
GUI" picture, but v0.4 stays scoped to the graph.

### D.3 Branch Picker UI

`LogOptions.refs` gains shape in v0.4, but the UI for selecting which
refs the log walks is deferred. v0.4 is hardcoded to
`AllLocalBranches`. A picker is additive once it exists.

### D.4 Branches Panel

Read-only display of branches as its own panel is a v1 deliverable
(DESIGN.md §8). v0.4 does not need it — branch names appear inline in
the Refs column, and lane locks are managed through right-click on
those inline ref chips. The need for a separate Branches panel will
sharpen once users want branch *actions* (checkout, create, delete),
which Status-era v0.5+ work will surface.

### D.5 Remote-Tracking Branches

Out of scope for v0.4 (§C.3). Remote-tracking branches in the Refs
column open the door to ahead/behind indicators, fetch status,
remote-aware coloring — a full remote UX concern that deserves its own
milestone (likely after fetch/push toolbar work).

### D.6 Auto-Lock Heuristics

Out of scope (§C.6). Auto-locking `main`/`master` on first repo open
is an obvious v0.5 candidate if dogfooding shows manual locking is
tedious.

### D.7 Full Crossing Minimization (Option 3)

The graph algorithm is option 2 (lookahead lane reuse). Full crossing
minimization — re-solving lane assignments over the whole loaded
window to minimize line crossings — is research-grade work,
incompatible with the load-more stability constraint, and would
balloon v0.4 into a months-long milestone. Visual quality beyond what
option 2 delivers is a long-term iterative concern, tuned against
real repos post-v0.4.

### D.8 Per-Repo Column Preferences

Column order, visibility, and widths are **global** in v0.4. A user
who wants Refs-first in one repo and Graph-first in another doesn't
get it. This is a deliberate scope-discipline call: per-repo column
preferences would mean every repo holds a column-preference blob,
which is per-repo UI state — a category v0.4 is already validating
with lane locks. Adding two instances of "first per-repo UI state"
in the same milestone is more than the milestone needs to validate.

### D.9 Filesystem Watcher

Still deferred (v0.3 §D.5). Commits panel relies on the same coarse
invalidation as v0.3: Console-command-completed and panel-focus
events. A filesystem watcher benefits Status more than Commits and
will land alongside Status in v0.5.

### D.10 Lookahead Beyond the Loaded Window

The lane algorithm's lookahead is bounded by the currently-loaded
commits (§F.3). It does not pre-fetch commits beyond the window to
inform its lookahead. This means lane assignments at the edge of the
window are computed without knowing what comes next, and load-more
may reveal lanes that — with hindsight — could have been assigned
differently. The stability constraint forbids reshuffling, so the
algorithm accepts suboptimal edge cases in exchange for visual
stability. Post-v0.4 quality work might add bounded peek-ahead, but
v0.4 ships without it.

---

## E. Frontend Changes

### E.1 The Commits Panel Structure

The panel is a virtualized table with N rows (the loaded commits) and
M columns (configurable; default M=5 visible + SHA hidden).

```
+-------+-------+----------------------+-------+--------+
| Refs  | Graph | Subject              | Date  | Author |
+-------+-------+----------------------+-------+--------+
| main  | ●     | Fix login redirect   | 2h    | alice  |
|       | │     |                      |       |        |
| HEAD →| ●     | Add OAuth support    | 5h    | bob    |
| dev   | │\    |                      |       |        |
|       | ● │   | WIP: refactor router | 1d    | alice  |
|       | │/    |                      |       |        |
|       | ●     | Merge dev into main  | 1d    | bob    |
+-------+-------+----------------------+-------+--------+
```

Each row is the same fixed height (matching the v0.3 virtualization
constraint). The Graph column's content scales horizontally with lane
count; all other column widths are independent of row content.

The table header carries the column controls: drag for reorder,
right-click for hide/show menu, drag-handles on column borders for
resize.

### E.2 The Refs Column

Renders ref decorations as small labeled chips. Visual conventions:

- **Branches** are pill-shaped chips with a branch-icon prefix.
- **Tags** are flag-shaped chips with a tag-icon prefix.
- **HEAD** is a small "HEAD →" prefix on whichever ref it points to,
  or a standalone "HEAD" chip when in detached-HEAD state.
- **The currently-checked-out branch** is visually emphasized (bolder
  outline, slightly larger). This is the v0.4 hint for "you are
  here" — distinct from the lane-locking signal.

Chips are right-click targets for the lane-locking menu (§C.6). Chips
are not yet draggable, clickable for checkout, or otherwise interactive
beyond right-click — branch actions are v1+ work.

When multiple refs decorate the same commit (common at branch tips),
chips wrap inside the cell. The default column width fits roughly two
typical-length ref names per row; widening shows more without wrapping.

### E.3 The Graph Column

The Graph column's render is a function of:

- The full ordered list of loaded commits (their ids and parents).
- The current set of locks for the active repo.
- The visible row range (for virtualized rendering).

Per render, the column:

1. Computes lane assignments for all loaded commits (cached; only
   recomputes when the loaded set or the lock set changes).
2. Determines the maximum lane count in the *visible* range and sizes
   the column accordingly.
3. Renders only the visible rows' lane segments, plus the connecting
   curves to off-screen parents/children at the top and bottom edges.

The renderer is SVG-based per visible row (one `<svg>` per row,
absolutely positioned in the Graph cell). This composes cleanly with
the row-based virtualization: rows that scroll out are unmounted,
taking their SVGs with them.

Lane colors are theme tokens (§6 of DESIGN.md):
`graph.lane.0`, `graph.lane.1`, …, `graph.lane.fallback`. v0.4 defines
the first six lane colors as distinct theme tokens; lanes beyond the
sixth all use `graph.lane.fallback`. Six is enough for almost all
real-world visible windows; the fallback handles the long tail.
Colorblind-friendly defaults are picked deliberately and ship in both
built-in themes.

### E.4 Column Reordering, Hiding, Resizing

A small column-management layer wraps the table:

```ts
interface ColumnState {
  order: ColumnId[];                    // visible columns, ordered
  hidden: ColumnId[];                   // hidden columns, ordered (for the show menu)
  widths: Record<ColumnId, number>;     // pixel widths; Graph excluded
}
```

`ColumnId` is `"refs" | "graph" | "subject" | "date" | "author" | "sha"`.

Library choice: hand-rolled drag/resize, no third-party data-table
library. The table is simple enough (5–6 columns, fixed row heights,
no nested grouping) that pulling in TanStack Table or similar would be
overkill. The drag-and-drop uses HTML5 native APIs; the resize uses
pointer events on a thin overlay at column edges.

State persists in the global settings file (§I.1).

### E.5 Default Repo Dock Layout

Resolves v0.3 §K (§B.1 above). New installs see:

```
+-----------------------------------------------------------+
| Repo tab strip                                            |
+-----------------------------------------------------------+
|                              |                            |
|  Commits                     |  Commit Details            |
|  (main area)                 |  (right column)            |
|                              |                            |
+-----------------------------------------------------------+
|  Console (collapsed)                                      |
+-----------------------------------------------------------+
```

Existing v0.3 installs keep their saved layout. Commits replaces Log
in their saved layout in place (same registry id, just new column
behavior on top).

---

## F. The Graph Algorithm

This section specifies the lane-assignment algorithm at enough detail
to implement against. Pseudocode and concrete examples follow.

### F.1 Algorithm Family: Option 2

The algorithm is **lookahead lane reuse with incremental stability**:

- New branches get assigned to the lowest-indexed free lane, with a
  small lookahead to prefer lanes that won't be needed by upcoming
  branches.
- When a branch ends (no more children visible), its lane is freed
  for reuse by the next new branch.
- On load-more, already-assigned lanes are **fixed input** — they
  never reshuffle. New commits get assigned around them.

This is "GitKraken-like" without being "GitKraken-exact." Crossing
minimization is best-effort; visual perfection is a tuning concern
post-v0.4.

### F.2 Inputs and Outputs

**Inputs:**

- `commits: Vec<Commit>` — ordered newest-first, each with `id` and
  `parents`.
- `locks: Map<RefName, LaneIndex>` — current per-repo locks.
- `refs_pointing_at: Map<CommitId, Vec<RefName>>` — which refs point
  to each commit (so a commit on a locked ref can be detected).
- `previous_lanes: Option<Map<CommitId, LaneIndex>>` — present on
  load-more; absent on first load. When present, all commit-to-lane
  assignments inside it are honored verbatim and the algorithm
  computes only the new commits.

**Output:**

- `lanes: Map<CommitId, LaneIndex>` — which lane each commit sits in.
- `edges: Vec<LaneEdge>` — one entry per parent-child connection,
  describing the source lane, target lane, source row, target row.

The renderer consumes `lanes` and `edges` to draw.

### F.3 Top-to-Bottom Walk

```text
for each commit C, in order from newest to oldest:
    # Step 1: find lanes "waiting for" C
    # A lane is waiting for C if its current target is C.
    waiting = [lane for lane in active_lanes if lane.target == C]

    # Step 2: assign C to a lane
    if any lane in waiting is a locked lane whose ref includes C:
        C.lane = that locked lane
    elif waiting is non-empty:
        # Pick the lowest-indexed waiting lane (the "spine" of the merge)
        C.lane = min(waiting)
    else:
        # C is a new branch tip
        C.lane = pick_new_lane(C, locks, lookahead_window)

    # Step 3: terminate the other waiting lanes
    for lane in waiting, lane != C.lane:
        lane is freed at row(C), with a merge edge from lane to C.lane

    # Step 4: set up lanes for C's parents
    if C is on a locked ref and C.lane is the locked lane:
        # First parent stays in this locked lane.
        # Additional parents (merge) each take a new lane via pick_new_lane.
        C.lane.target = C.parents[0]
        for parent in C.parents[1:]:
            new_lane = pick_new_lane(parent, locks, lookahead_window)
            new_lane.target = parent
    else:
        # First parent: usually same lane, unless first parent is on a locked
        # ref *other than* this lane — in which case the lane terminates and
        # the parent picks up its locked lane.
        if C.parents[0] is on a locked ref and that locked ref's lane != C.lane:
            C.lane terminated; edge from C.lane to that locked lane at row(C.parents[0])
        else:
            C.lane.target = C.parents[0]
        for parent in C.parents[1:]:
            new_lane = pick_new_lane(parent, locks, lookahead_window)
            new_lane.target = parent
```

`pick_new_lane(commit, locks, lookahead_window)`:

```text
if commit is on a locked ref:
    return that locked lane (whether or not currently free; if occupied,
        the occupier terminates here — this should not normally happen
        because locked lanes are reserved, but the rule is explicit)
else:
    candidates = lanes that are currently free AND not locked
    for each candidate, in ascending index order:
        peek ahead `lookahead_window` commits:
            if a commit on a locked ref appears and would want this lane,
                skip this candidate
        else:
            return candidate
    return next_unused_lane_index
```

The "peek ahead" is bounded by `lookahead_window`. v0.4 sets
`lookahead_window = page_size = 500` — the algorithm peeks anywhere in
the currently-loaded window, which gives it full visibility within
what's loaded.

### F.4 How Locks Interact

Locked lanes are **reserved** at the start of the walk. The set of
free lanes excludes locked lane indices unless the commit being
assigned is on the corresponding locked ref.

A commit on a locked ref always sits in that lock's lane. This is the
guarantee users get from locking: "I locked main to leftmost; main's
commits are in the leftmost lane, period."

A **non-locked branch terminating into a locked branch** (e.g., a
feature branch merged into main, where main is locked to lane 0):

- The feature branch sits in some non-locked lane (say lane 3) while
  its commits are being visited.
- At the merge commit on main, lane 3 terminates with a merge edge
  drawn from lane 3 to lane 0.
- Lane 3 is now free for reuse.
- Lane 0 (locked, main's) continues downward unaffected.

A **non-locked branch starting from a locked branch** (e.g., a new
feature branch off main):

- At the commit where the feature branch starts, the feature branch's
  lane is assigned via `pick_new_lane`.
- A branching edge is drawn from lane 0 (main) at that commit to the
  new lane at the row above.
- The locked lane (main) is unaffected.

The general rule: **locked lanes are inviolate.** Non-locked branches
visually flow around them but never displace them.

### F.5 Stability Under Pagination

On load-more, the existing lane assignments for already-rendered
commits are treated as **fixed input**. The algorithm only computes
assignments for the newly-loaded commits, with the existing lanes as
context.

Concretely: when `previous_lanes` is passed (§F.2), the walk starts
from the first newly-loaded commit (not from the top), and the set of
"active lanes" at that starting point is reconstructed from the last
known state of each lane in `previous_lanes`.

This means a lane that ended one commit before the load-more boundary
is correctly freed, and a lane that was active at the boundary
continues with its existing index. No commit ever changes its lane
assignment after it has been rendered.

The trade-off: a new branch revealed by load-more might have made
sense in a lane already-reused above the boundary. The algorithm
cannot move it there (that would reshuffle). It takes the lowest
available lane instead, producing a slightly suboptimal layout in
exchange for guaranteed stability.

### F.6 Performance Budget

v0.4 is done when these numbers hold on a developer-class laptop
(modern Apple Silicon or recent x86_64):

- **Initial lane computation on 500 commits**: < 100ms.
- **Lane computation on a 500-commit load-more increment**: < 50ms
  (since existing lanes are fixed input).
- **Render at 60fps while scrolling** through 10,000 loaded commits.
  Frame budget: 16ms; the visible window is typically 50–100 rows.

These are concrete numbers, not vibes. If real-repo testing shows any
of them missed, the algorithm or renderer gets optimized before v0.4
ships. If they're missed by a wide margin, the algorithm or the
virtualization layer needs revisiting — and that's a real risk worth
flagging before implementation.

### F.7 Visual Style of Lanes

Pseudo-fixed in v0.4 to ship with reasonable defaults; refinable in
later passes:

- **Lane spacing**: ~16px between lane centers.
- **Commit dots**: ~6px circles centered in their lane.
- **Vertical lines**: 1.5px stroke width.
- **Merge/branch curves**: smooth Bezier curves connecting lane
  centers at adjacent rows, with curvature scaled to lane distance.
- **Lane colors**: theme tokens `graph.lane.0` through `graph.lane.5`
  plus `graph.lane.fallback`. Colorblind-friendly defaults
  (distinguishable by both hue and luminance).
- **Locked lanes** have a subtle vertical bar in the column header
  area indicating the lock, with the ref name as a tooltip on hover.

---

## G. Backend Changes

### G.1 `LogOptions.refs` and `GitBackend::log()`

The trait signature is unchanged; only `LogOptions` grows. The
implementation in `cli_impl/log.rs` translates `RefSelector` into the
corresponding `git log` args:

- `RefSelector::Head` → no extra arg (current ref-resolution path)
- `RefSelector::AllLocalBranches` → `--branches`
- (future variants extend the match)

`--decorate=full` is added to the invocation unconditionally (v0.3
didn't include it; v0.4 needs ref decorations for the Refs column).
`--decorate=full` ensures ref names include their full
qualification (`refs/heads/main`, `refs/tags/v1.0`) so the parser can
distinguish branches from tags without ambiguity.

### G.2 Format String Extension

The `git log` format string from v0.3 gains a decoration field. The
actual format used (newline-separated fields; records terminated by
`%x1e` (ASCII RS)) is:

```
--format='%H%n%P%n%an%n%ae%n%aI%n%cn%n%ce%n%cI%n%d%n%s%n%b%x1e'
```

Fields are newline-separated (`%n`); records are terminated by
`%x1e` (ASCII Record Separator, 0x1E). Timestamps use strict ISO 8601
(`%aI`, `%cI`) rather than Unix epoch. The new `%d` field (field 8)
carries the decoration in the form
`(HEAD -> refs/heads/main, refs/heads/dev, refs/tags/v1.0)` — `git`'s
standard decoration syntax with `--decorate=full`.

The format string is a constant next to `parsers/log.rs`, per the
DESIGN.md §4.5 rule.

### G.3 Parser Update

`parsers/log.rs` gains decoration parsing. New helper:

```rust
fn parse_decoration(s: &str) -> Vec<RefDecoration>;

pub enum RefDecoration {
    Head,                          // bare HEAD (detached)
    HeadOf(String),                // HEAD -> refs/heads/main
    Branch(String),                // refs/heads/...
    Tag(String),                   // refs/tags/...
    Other(String),                 // refs/notes/..., refs/stash, etc. — kept as raw string
}
```

`Other` is the forward-compat bucket for ref namespaces v0.4 doesn't
have explicit support for (notes, stash refs, remote-tracking — even
though they shouldn't appear when `RefSelector::AllLocalBranches` is
used, they might if the user adds `--decorate=full` flags via a
hypothetical custom selector later).

Test corpus additions (§C.4 of v0.3):

- Commits with no decoration.
- Commits with one branch.
- Commits with HEAD on a branch.
- Commits with multiple branches at the same commit.
- Commits with branches and tags mixed.
- Commits in detached-HEAD state (bare HEAD decoration).
- Unicode in branch names and tag names.
- Branch names containing spaces or unusual characters (Git allows
  most things).

### G.4 Domain Type Additions

`Commit` (from DESIGN.md §4.4) gains a `decorations` field:

```rust
pub struct Commit {
    // ... existing fields ...
    pub decorations: Vec<RefDecoration>,
}
```

Empty vec for commits with no decoration. The parser populates this
from the `%d` field.

### G.5 Lock Storage in `RepoSettings`

`RepoSettings` (introduced in v0.2) gains a `lane_locks` field:

```rust
pub struct RepoSettings {
    // ... existing v0.2 fields ...
    pub lane_locks: Vec<LaneLock>,
}

pub struct LaneLock {
    pub ref_name: String,     // e.g., "refs/heads/main"
    pub lane_index: u32,      // 0-indexed
}
```

`lane_locks` defaults to an empty vec. Locks are stored as a `Vec`
rather than a `HashMap<RefName, LaneIndex>` so iteration order is
stable for diff-friendly persisted output and orphaned locks
preserve their entries deterministically.

### G.6 Tauri Commands for Lock Management

```rust
// Get all locks for the active repo:
fn list_lane_locks(repo_id: RepoId) -> Result<Vec<LaneLock>, AppError>;

// Add or update a lock (replaces any existing lock for the same ref):
fn set_lane_lock(repo_id: RepoId, ref_name: String, lane_index: u32) -> Result<Vec<LaneLock>, AppError>;

// Remove a lock for a ref:
fn unset_lane_lock(repo_id: RepoId, ref_name: String) -> Result<Vec<LaneLock>, AppError>;
```

All three return the post-mutation lock list so the UI refreshes from
the source of truth (same pattern as `repo_write_line_endings` in
v0.2 §H.8).

Backend-side validation:

- `set_lane_lock` does **not** reject conflicting lane indices (two
  refs locked to the same lane). It accepts whatever the UI sends.
  The layout algorithm handles the inconsistency case (§C.6).
- `lane_index` is clamped to a sane upper bound (say, 64) to prevent
  pathological input. Anything beyond that is rejected with
  `AppError::InvalidLockIndex`.

### G.7 The `RepoSession.backend` Fix (carried from v0.3)

v0.3 §C.5 fixed `RepoSession.backend` to hold a shared runner handle.
v0.4 verifies this still works under the new pressure of multi-ref
log invocations and lock-aware computation; no further changes
expected.

---

## H. Lane Algorithm Edge Cases

A subset of cases worth calling out explicitly because they're either
common or counterintuitive.

### H.1 Octopus Merges (3+ parents)

`git` supports merge commits with arbitrary numbers of parents. v0.4's
algorithm handles this naturally: the first parent inherits the merge
commit's lane (or the locked lane, if applicable); each additional
parent gets a new lane via `pick_new_lane`.

Octopus merges are visually busy (multiple lanes spawning from one
commit) but algorithmically the same as 2-parent merges.

### H.2 Disconnected Histories

Some repos have multiple "root" commits with no shared ancestry (e.g.,
after `git merge --allow-unrelated-histories` reverts). Each root
appears as a separate origin point in the graph. The algorithm
handles this without special-casing: roots are commits with empty
parent lists; their lanes simply terminate.

### H.3 The Window Edge

The oldest commit in the loaded window may have unloaded parents.
Its lane terminates at the bottom of the rendered area with a
downward-pointing edge indicating "continues off-screen" (a small
arrow or fade). On load-more, this lane reactivates and continues.

The newest commits may have unloaded *children* (descendants). The
algorithm doesn't know about them — it walks newest-to-oldest from
the loaded set. Lanes at the top edge just start there. This is fine
visually; there's nothing to render above the topmost commit.

### H.4 A Locked Lane's Ref Is Deleted Mid-Session

Sequence: user has `main` locked to lane 0. User runs
`git branch -D main` in the Console. Commits previously decorated
with main are now decorated only with whatever else points to them
(or nothing). The lane assignments computed before the deletion
still show those commits in lane 0; the *next* recomputation (next
fetch, next panel-focus refresh) excludes them from main and they
get reassigned by the normal heuristic.

The lock remains in storage (orphaned). If main is recreated later,
the lock reactivates.

### H.5 Two Locks Conflict in Storage

If `repos/<hash>/settings.json` is hand-edited to lock both `main`
and `dev` to lane 0, the layout algorithm:

1. Logs a `tracing` warning naming both refs.
2. Honors the lock entry that comes first in the `lane_locks` Vec.
3. Treats the second as orphaned (logged, but not silently dropped
   from storage).

The UI's "Show locks for this repo" dialog flags the conflict with a
"Resolve" affordance.

---

## I. Persistence

### I.1 Column Preferences (Global)

Stored in `global-settings.json` (v0.2 §G), under a new top-level
`columnPreferences.commits` block:

```json
{
  "columnPreferences": {
    "commits": {
      "format": "legit-commits-columns",
      "formatVersion": 1,
      "order": ["refs", "graph", "subject", "date", "author"],
      "hidden": ["sha"],
      "widths": {
        "refs": 140,
        "subject": 480,
        "date": 100,
        "author": 140,
        "sha": 100
      }
    }
  }
}
```

`graph` is intentionally absent from `widths` — its width is dynamic.

Format-versioning follows the v0.2 §D.4 rules: missing values filled
from defaults, unknown keys preserved silently.

### I.2 Lane Locks (Per-Repo)

Stored in `repos/<hash>/settings.json` under a new `laneLocks` block:

```json
{
  "laneLocks": {
    "format": "legit-lane-locks",
    "formatVersion": 1,
    "locks": [
      { "refName": "refs/heads/main", "laneIndex": 0 },
      { "refName": "refs/heads/dev",  "laneIndex": 1 }
    ]
  }
}
```

Same forward-compat rules. The block is created lazily (per v0.2 §B.5
"created on first repo-scope write"); repos with no locks have no
`laneLocks` block at all.

### I.3 No New Per-Panel State on Disk

The Commits panel's selected commit, scroll position, etc., remain
session-only (per v0.3 §C.2). They are not persisted across restarts.
v0.4 does not change this.

---

## J. Success Criteria

v0.4 is done when:

1. The Commits panel renders the loaded commits as a multi-column
   table with the default column set (Refs, Graph, Subject, Date,
   Author; SHA hidden) on a fresh install.
2. Multi-ref log via `RefSelector::AllLocalBranches` returns commits
   reachable from any local branch, correctly decorated with the refs
   that point to them.
3. The Refs column renders branches, tags, and HEAD with the
   distinctions described in §E.2.
4. The Graph column renders lanes via the option-2 algorithm specified
   in §F, including:
   - Stability under load-more (already-rendered lanes never
     reshuffle).
   - Locked lanes that hold their assignment across recomputations.
   - Merge and branch curves that correctly connect parents and
     children.
   - Dynamic width sizing to lane count in the visible window.
5. Column controls work:
   - Reorder via header drag.
   - Hide and show via right-click menu (Subject not hideable).
   - Resize via column-edge drag (Graph not resizable).
6. Column preferences persist across LeGit restarts as
   global-scope state.
7. Lane locks work end-to-end:
   - Right-click a ref chip → "Lock to leftmost lane" applies the
     lock immediately, with the lane visibly reassigning.
   - Locks persist across LeGit restarts as per-repo state.
   - Orphaned locks (ref deleted) are preserved silently and
     reactivate if the ref is recreated.
   - The "Show locks for this repo" dialog lists active and orphaned
     locks accurately.
8. The performance budget in §F.6 holds on the author's development
   machine against at least three real repos of varying size and
   complexity (a small personal repo, a medium-sized OSS repo, a
   large repo with deep history).
9. v0.3 carry-overs (§B) shipped:
   - Console default position is bottom-collapsed for new installs.
10. Author dogfooding for at least two weeks confirms the Commits
    panel is a pleasant history-browsing experience, and that lane
    locking matches the mental model of "trunk on the left" without
    surprising edge cases.

---

## K. Decision Log Additions (to append to DESIGN.md §11)

| Decision                                       | Choice                                                                                                              | Why                                                                                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v0.4 milestone framing                         | Ship graph + lane locking; defer Status and Diff to v0.5                                                            | Graph is the headline differentiator and a core panel with no panel dependencies; landing it first lets every later panel build on a validated graph foundation |
| Graph + locking in same milestone              | Yes, together                                                                                                       | A graph without locking would not match the author's mental model; isolating locking to v0.5 would mean v0.4 ships a graph the author considers incomplete     |
| Commits panel as renamed Log                   | Same registry id (`log`), new user-facing title ("Commits"), expanded columns                                       | Placement memory and backend continuity preserved; the rename is purely user-facing                                                                            |
| Multi-ref support in v0.4                      | Hardcoded `AllLocalBranches`; no picker UI                                                                          | Picker is additive; v0.4 scope is the graph itself, not ref selection UX                                                                                       |
| Remote-tracking branches in Refs column        | Excluded from v0.4                                                                                                  | Pulls in ahead/behind, fetch status, remote-aware coloring — a full remote UX milestone of its own                                                              |
| Graph algorithm                                | Option 2 (lookahead lane reuse with incremental stability)                                                          | Option 3 (full crossing minimization) is research-grade, incompatible with stability under load-more, and would make v0.4 months instead of weeks              |
| Lookahead window                               | Equal to page size (500 commits)                                                                                    | The algorithm has full visibility into what's loaded; bounded peek-ahead beyond the window is a post-v0.4 quality concern                                       |
| Stability under load-more                      | Already-assigned lanes are fixed input; no reshuffling                                                              | Reshuffling is a worse UX than slightly suboptimal lane choices at window edges                                                                                |
| Lane locking storage                           | `(ref_name, lane_index)` pairs in `repos/<hash>/settings.json`                                                      | Ref-name locking follows the ref; SHA-locking would expire on every commit                                                                                     |
| Lane locking opt-in vs. auto-lock              | Opt-in only in v0.4; no automatic lock heuristics                                                                   | Heuristics need tuning against real workflows; v0.5 is the natural place to revisit once dogfooding shows what manual lockings feel tedious                    |
| Lane numbering in the UI                       | 0-indexed in code; "leftmost / 2nd from left / …" in UI                                                             | Programmer-speak ("Lock to lane 3") leaks implementation; positional language is more natural for users                                                        |
| Two locks to same lane                         | Rejected at UI; backend permissive (first lock wins, second logged as orphaned)                                     | Defensive backend tolerates hand-edited config; UI prevents creating the inconsistency in the first place                                                      |
| Orphaned locks                                 | Preserved silently in storage; reactivate when ref reappears; visible in "Show locks" dialog                        | Matches the §6.5 theme-token forward-compat pattern; rename-then-un-rename should not lose configuration                                                       |
| Column reorder / hide / resize                 | All three ship in v0.4                                                                                              | A modern data-table UI is expected; shipping reorder without hide or resize would feel arbitrary                                                                |
| Graph column reorderable                       | Yes — Graph column can be placed at any position in the column order                                                | Graph renders within its own bounding rect; placing it in the middle is unconventional but mechanically sound, and the user gets full control over their layout |
| Column preferences scope                       | Global, not per-repo                                                                                                | Column order/visibility/width are per-user UI taste; per-repo preferences would double the per-repo-UI-state surface v0.4 is already validating with lane locks |
| Default column order                           | Refs, Graph, Subject, Date, Author; SHA hidden                                                                      | Refs-first puts labels at the user's reading position with the graph as immediate visual context; SHA is rarely needed at-a-glance and hides cleanly           |
| Console default position                       | Bottom, collapsed (new installs only; existing layouts preserved)                                                   | Resolves v0.3 §K — Console is an escape hatch, not a primary surface, and the bottom-collapsed position fits Commits + Commit Details as the working panels   |
| `--decorate=full` in the log invocation        | Yes, unconditionally                                                                                                | Full ref qualification disambiguates branches from tags in the parser without heuristics                                                                       |
| `RefDecoration::Other` fallback                | Yes — unknown ref namespaces preserved as raw strings                                                               | Forward-compat for ref namespaces v0.4 doesn't enumerate (notes, stash, etc.)                                                                                 |
| Performance budget                             | <100ms initial layout on 500 commits, <50ms incremental on load-more, 60fps scroll on 10k commits                   | Concrete numbers make "is the algorithm fast enough" answerable rather than vibes-based; missing the budget is a v0.4-blocking signal                          |
| Per-repo column preferences                    | Deferred                                                                                                            | Adds a second instance of per-repo UI state in the same milestone as lane locks; one new per-repo-UI-state surface per milestone matches v0.1–v0.3 discipline   |
| Data-table library                             | Hand-rolled column UI; no TanStack Table or similar                                                                 | The table is simple enough (5–6 columns, fixed row heights, no nested grouping) that a library would be overkill                                                |

---

## L. Open Questions

### Still open

- **Default fallback when peek-ahead misses a locked lane's need.**
  The lookahead in `pick_new_lane` (§F.3) prefers candidates that
  won't conflict with upcoming locked lanes. If every available
  candidate would conflict, the algorithm currently allocates a new
  lane index. There's a smarter option (reserve the conflict-prone
  candidate and defer the new branch's lane assignment one row), but
  it complicates the walk. Defer to implementation; revisit if
  real-repo testing surfaces the issue.

- **Color cycling beyond 6 lanes.** The first six lanes have distinct
  theme tokens; lane 7 onward uses `graph.lane.fallback`. A cycling
  scheme (lane 7 = lane 0's color, lane 8 = lane 1's, …) is the
  obvious alternative and might look better on busy histories. v0.4
  ships the single-fallback approach for simplicity; the
  iteration-on-color choice is post-v0.4 polish.

- **The "Show locks for this repo" dialog as a panel vs. a modal.**
  v0.4 specifies it as a small modal dialog. If lock management
  becomes a more frequent activity than expected (auto-lock
  iteration in v0.5, lots of locks per repo), it could grow into a
  small dedicated panel. Carry the question forward.

### Resolved during v0.4 planning

- **Whether Graph and Refs should be position-locked.** Resolved: no.
  All columns including Graph are user-reorderable. The Graph column
  renders within its own bounding rect, so placing it elsewhere does
  not break the lane visualization. Refs and Graph are visually
  paired and start adjacent by default; the user is free to separate
  them.
- **Default column order.** Resolved: Refs, Graph, Subject, Date,
  Author; SHA hidden. See §K decision log.
- **Graph quality target for v0.4.** Resolved: option 2 (lookahead
  lane reuse). Option 3 (full crossing minimization) is a long-term
  iteration target, not a v0.4 commitment. See §K decision log.
- **Console default position.** Resolved: bottom, collapsed.
  Resolves v0.3 §K's carried-forward question.

---

## M. Roadmap Sketch (for v0.4)

1. **Carry-overs.** §B.1.
2. **Backend foundations.**
   - Extend `LogOptions` with `RefSelector` (§G.1).
   - Update the `git log` invocation and format string (§G.2).
   - Extend `parsers/log.rs` for decoration parsing; add test corpus
     for decorations (§G.3).
   - Add `Commit.decorations` (§G.4).
3. **Lock storage.**
   - Add `lane_locks` to `RepoSettings` (§G.5).
   - Add `list_lane_locks` / `set_lane_lock` / `unset_lane_lock`
     Tauri commands (§G.6).
   - Verify `RepoSession.backend` runner-handle fix still holds
     (§G.7).
4. **Refs column.**
   - Render ref chips in the Commits panel (§E.2).
   - Right-click context menu scaffold (no lock actions wired yet).
5. **Lane algorithm.**
   - Implement option 2 walk per §F.3.
   - Unit-test exhaustively against synthetic commit graphs covering
     §H edge cases.
   - Verify stability under load-more (synthetic test:
     compute lanes on commits 1–500, then on 1–1000 with first 500
     as fixed input; assert lane assignments for 1–500 are identical).
6. **Graph column rendering.**
   - SVG-per-row renderer (§E.3).
   - Theme token integration for lane colors.
   - Dynamic column-width sizing.
7. **Lane locking wired end-to-end.**
   - Lock UI (right-click menu, "Show locks" dialog) wired to
     backend commands.
   - Algorithm consumes locks correctly (§F.4).
   - Orphaned-lock detection and display.
8. **Column controls.**
   - Reorder via header drag.
   - Hide/show via right-click menu.
   - Resize via column-edge drag.
   - Persist preferences to `global-settings.json`.
9. **Default repo dock layout refresh.** Commits + Commit Details +
   Console-collapsed (§E.5).
10. **Performance pass.**
    - Profile against three real repos (§J.8).
    - Optimize hot paths if the budget is missed.
11. **Dogfooding cycle.** Two weeks against the author's daily
    workflow. Revise based on what surfaces — particularly around
    lane locking ergonomics and whether the manual workflow points
    at a v0.5 auto-lock need.
