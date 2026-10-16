# Repository groups in the repo tab strip

Design note, 2026-10-16. Brainstormed with Simon; decisions below are his
unless marked "builder's call" or "Claude's call".

## Intent

The repo tab strip is flat. Users with many open repositories want to
separate them by context (work vs school, or one group per project) and
fold away the contexts they are not using right now. This adds named,
collapsible, user-colorable groups of repo tabs to the strip, created and
dissolved by drag and drop.

## Goals

- Group open repo tabs into named groups directly in the strip, iOS-folder
  style: drag a tab onto another, dwell, drop to create a group.
- Collapse a group to a compact form (name band + member count, keeping
  the container's full height at its level) and expand it again with one
  click.
- Groups follow the active repo tab style's shape language (flush, pill,
  browser): a group looks like a "big tab" of that style containing its
  member tabs.
- Group membership is remembered per repository: closing a tab does not
  remove it from its group; reopening the repo returns it to the group.
- Groups, their names, and their color overrides sync via settings sync
  and reapply on machines where the same repositories are present,
  mirroring how profile assignments sync.
- Groups nest recursively: a group can hold groups, and every mechanism
  (rendering layers, collapse, drag and drop, persistence, sync) stacks
  the same way at every level. The maximum nesting depth is a single
  configured number, not a structural limit.

## Non-goals (v1)

- No resource optimization: collapsing is purely visual. Sessions,
  watchers, and background refresh of collapsed repos are untouched.
  "Unload collapsed groups" is a potential later optimization
  (goes to BACKLOG.md).
- No keyboard shortcuts for group operations (Claude's call; can be added
  under the existing shortcut phases later).

## Anti-goals

- Collapsing or grouping must never change which repo is active, close a
  session, or alter refresh behaviour. If the active repo's group is
  collapsed, the app keeps showing that repo; the collapsed chip carries
  an active marker so the strip never looks selection-less (marker:
  Claude's call).
- No violation of the theming rule: every drawn color resolves from a
  theme token, except the per-group user override, which is user data
  (see Color).
- The strip with zero groups must look and measure exactly as today
  (pixel-identical: no header band, no behaviour change to drag-reorder).

## The model

The strip is an ordered list of items; an item is a repo tab or a group.
A group has: stable id, name, optional color override, collapsed flag,
and an ordered member list of items - repos or groups, recursively. Repo
members are keyed by repo identity (locator, as persisted bookkeeping
already is), not by open-tab existence: a member that is not currently
open simply does not render, but stays in the list.

Nesting depth is capped by a hardcoded build constant (not a user
setting; value 3, Claude's call pending a better number; the constant is
app code, so it is not synced and never appears in settings). The cap is
enforced at mutation time (a drop that would exceed it falls back to the
reorder interpretation); a build that lowers the constant never destroys
existing deeper structure, it only prevents creating new levels beyond
the cap (Claude's call).

A group with zero members (open or closed) dissolves, at any level; a
dissolving group's remaining parent dissolves too if it thereby empties. A group whose
members are all closed still exists (it renders only if at least one
member is open; builder's call whether an all-closed group renders as an
empty collapsed chip or disappears until a member reopens - prefer
disappearing, it keeps the strip honest about open tabs).

New/reopened repos: a reopened repo rejoins its group (at its remembered
position, else at the group's end). A repo never seen in a group opens
ungrouped at the strip end, as today.

## Rendering

- The group is a container drawn structurally BEHIND its member tabs: a
  background block with the group name in a header band on top, member
  tabs drawn in front of it, keeping their normal tab appearance (Simon's
  sketch). Members keep a visible inset to the container's sides (gap-
  derived) in every style for separation; flush and browser keep the
  bottom flush so tabs stay on the strip's bottom line (explicit
  decision). Group headers carry no chevron in either state.
- The strip grows by one header-band height per nesting level, and
  COLLAPSE NEVER CHANGES ANY HEIGHT (explicit decision, revised twice from
  a tab-height chip): a collapsed group keeps its full expanded height -
  header band plus a body that stretches by the hidden subtree's bands -
  so a depth-2 group stays depth-2 tall and the strip never jumps on
  collapse/expand;
  everything bottom-aligns, so ungrouped tabs line up with the deepest
  tabs and each group's header sits one band above its members. A nested
  group renders exactly like a top-level one, inside its parent's member
  row; a collapsed nested group keeps its container form in that row.
  With zero groups
  the strip is exactly today's.
- Shape follows `repo_tab_style`:
  - flush: group block sits flush on the separator line, top corners
    rounded like tabs.
  - pill: the group is a big pill containing pill tabs (collapsed
    included).
  - browser: the group is a big borderless browser tab with rounded top
    corners AND outward bottom fillets, both scaled to the group's
    concentric radius (fillets were removed once over a perceived cut,
    then re-added at Simon's request once insets + concentric radii made
    the concave notch read as intended); member tabs keep their own
    flares inside it; collapsed included.
- Collapsed form: the header band (name, no caret - headers carry no
  chevron in either state) over a tab-height body showing the member
  count, with the active marker when it holds the active repo.
- All dimensions derive from `--ui-font-size` / the existing repo-tab
  geometry settings; no fixed px except hairlines.
- The existing no-scrollbar overflow fade must keep working with groups
  present (groups can be wide; the fade logic is content-agnostic but the
  clipped-edge detection must account for the new DOM).

## Color

- Two new theme tokens: group background and group text (exact token
  names builder's call, following existing naming). Added in the usual 4
  places plus a `CONTRAST_PAIRS` entry so built-in themes stay AA; tune
  built-ins if needed. Built-ins should ship a subtle translucent wash so
  tabs stay the main event; a theme is free to define a loud solid value.
- Per-group override: a context menu entry opens a color picker; the
  chosen color replaces the group background for that group only and is
  stored on the group (user data, not theme data), with a "Reset to theme
  color" entry. Group text always stays on the token. If a user picks a
  background that makes the token text unreadable, that is their problem -
  no auto-derivation, no guardrails (explicit decision).
- The override is exempt from the no-literal-colors test by virtue of
  being data, not code; the default path must render purely from tokens.

## Interactions

Creation (primary path, iOS-folder style):
- Dragging a tab over another tab's EDGE zones keeps today's live
  reorder.
- Pausing over a REPO TAB's center for a short dwell switches the drop
  preview to "merge into a new group" (the target swells); dropping
  creates a NEW group of the two, at the target's level. Groups are NEVER
  merge targets (revised: wrapping a hovered group and the dragged item
  in a new parent was confusing); a group-of-groups is built by dropping
  a group positionally inside another. Where the depth cap forbids the
  merge, the dwell preview never offers it. Dwell time and zone geometry:
  builder's call, tuned for not triggering during fast reorders.
- Dragging shows a LIVE PREVIEW: the strip rearranges as if the drop had
  landed (the dragged item floats fully opaque under the pointer while
  its slot holds the space); merge keeps the swell highlight instead.
  Stability: re-targeting needs pointer travel (hysteresis), a suppressed
  target applies after a short rest (settle), settling never bounces the
  item back into the slot it just left, and a group that grew to hold the
  item keeps it until the pointer leaves the group's bounds.
- Dragging the last member out keeps the emptied group visible (full
  size) until the drop commits - it dissolves only then; hovering it
  again re-enters it (never merges with the placeholder).
- ADDING to an existing group is positional, not dwell-based: drop the
  dragged item between a group's member tabs (the normal reorder
  interpretation, which already moves membership when a boundary is
  crossed). Dwell never means "add to this group" (Claude's call,
  resolving the ambiguity between add-to-group and create-nested-group:
  one gesture, one meaning).
- On creation the group header's inline name input opens immediately
  (existing `InlineRenameInput` pattern: Enter confirms, Esc keeps a
  default name like "Group 1"). No dialog.

Secondary path: tab context menu "Move to group" with existing groups and
"New group...".

Removal and dissolution, mirroring creation:
- Drag a tab (or group) out of its group onto free strip space to remove
  it; dropping it in the parent's row moves it up one level.
- Context menu on a tab inside a group: "Remove from group".
- Context menu on the group header: Rename, Change color..., Reset to
  theme color, Collapse/Expand, Ungroup (dissolves the group; its members,
  including nested groups, move up into the parent level in place). None
  of these are destructive confirmations: no repo closes, no data is
  lost.
- Removing the last member dissolves the group.

Reordering:
- Tabs reorder within a group, between groups (crossing a boundary moves
  membership), and in the ungrouped area - all the existing live-drag
  interaction.
- Dragging a group's header moves the whole group as one unit within the
  strip order.

Header gestures: single click toggles collapse/expand (immediately - no
double-click action exists); drag moves the group; rename is reachable
ONLY via the context menu, plus the auto-opened input on creation. (Click
vs drag disambiguation via the existing DRAG_THRESHOLD approach.)

Active repo: collapsing a group containing the active repo changes
nothing about activation (explicit decision); clicking a collapsed chip
expands the group (it does not activate a member).

## Persistence and sync

- Local persistence: groups (structure, names, color overrides, collapsed
  flags, member lists, strip order) persist in the app's global
  bookkeeping beside the existing `currently_open` order (exact home:
  builder's call; it is app-global state, not per-repo settings).
  `refresh()` and tab-order persistence must keep respecting manual
  order, now including group positions.
- Sync: group definitions (name, color override, membership, nested
  structure) ride the settings-sync document, unconditionally like
  ordinary synced settings - NOT gated by the `sync_git_profiles`
  opt-in; only the remote-URL keying is borrowed from
  `profile_assignments`, not its sensitivity gating (Claude's call: the
  opt-in exists for SSH-key material, which groups do not carry).
- Groups are identified across machines by their synced stable id;
  same-named groups created independently on two machines stay separate
  (Claude's call: names are labels, never identity).
- Membership stores, per repo member, the locator AND the repo's
  canonical remote URL, captured when the repo joins the group and
  refreshed whenever the repo opens; a stale key between opens is
  acceptable (Claude's call). The synced form carries the remote-URL
  keys; a member whose remote is unknown (no remote) stays local-only and
  is omitted from the synced form (Claude's call, forced by the keying).
  Export is therefore stable regardless of which repos are currently
  open.
- Global bookkeeping additionally records every known repo's last-seen
  canonical remote URL on open, so import can match repos that are
  currently closed.
- Imported groups are silently auto-applied wherever a matching repo is
  present - no acceptance step (explicit decision). The imported
  remote-keyed structure is authoritative for remote-keyed members,
  consistent with newer-wins everywhere else in sync: additions AND
  removals apply, including to closed repos matched via the bookkeeping
  remote map. Local-only members (no remote, or ambiguous) and the
  machine-local attributes (order, collapsed state, strip position) are
  preserved through the reconciliation (Claude's call).
- Several local repos can share one remote (worktrees, multiple clones).
  Import applies a synced membership to ALL matching repos except those
  holding a preserved local-only membership; on export, a remote key that
  maps to more than one group locally is ambiguous and is omitted from
  the synced form, staying local-only (Claude's call: deterministic and
  never destructive).
- Import replaces the synced group definitions wholesale under the
  engine's existing newer-wins semantics, then reconciles against local
  bookkeeping by remote key, so a membership removal on one machine
  propagates instead of being resurrected later by stale maps (Claude's
  call).
- Order does not sync: within-group member order and the strip order are
  machine-local; synced membership is a set. Remembered positions of
  closed members persist locally only (Claude's call).
- A group whose members are all closed renders nowhere and has no
  management surface in v1: it is invisible until a member reopens, and
  it continues to exist and sync meanwhile (Claude's call - acceptable
  ghost; a management surface can come later if it bites).
- Machine-local, never synced: collapsed state, strip order, and which
  tabs are open (consistent with `last_open_repos` being never-synced) -
  Claude's call.
- The new synced field(s) must be added to the classified sync key list
  (the `synced_key_list_is_exactly_the_classified_set` gate) and the sync
  merge needs the usual newer-wins semantics.

## Testing expectations

Follow the house rules; the plan decides specifics. At minimum:
- Pure decision logic unit-tested: group membership resolution on reopen,
  dissolve-on-empty (including cascading up), drop-zone classification
  (edge vs center dwell), depth-cap enforcement at drops and on cap
  changes, strip-height derivation from deepest nesting, sync merge of
  group definitions.
- Theme contract: new tokens in all 4 places + contrast pair
  (contract.test.ts enforces).
- Sync classification gate updated.
- Strip rendering/drag wiring that no unit seam can express: candidates
  for the E2E suite; otherwise record interactive-only repro notes.

## CHANGELOG

One Added bullet, user-phrased, e.g. "Repo tabs can be grouped into
named, collapsible, colorable groups by drag and drop".

## Left to the builder

- Exact DOM/CSS structure per tab style (incl. how the browser-style
  flare geometry wraps a group, recursively) and the header band's
  metrics.
- Dwell timing, zone sizes, drag previews, drop animations.
- Token names; storage field names and shapes; migration of existing
  persisted order.
- Whether group state lives in `GlobalSettings` or a sibling document
  like the profiles doc.
- Default group name scheme ("Group 1", "Group 2", ...); duplicate names
  are allowed (Claude's call - names are labels, the id is identity).
