# Lane locks: working-dir row and stashes on the locked lane (2026-07-09)

The lane algorithm reserves locked lanes for the locked ref's first-parent
ancestry (`computeOwnership` in `src/panels/Commits/graph/lanes.ts`);
`pickNewLane` keeps everything else off them. The synthetic working-dir row
(parent = HEAD) and injected stash nodes (parent = base commit) therefore get
pushed onto a free lane even when they belong to the branch that owns the
locked lane. Approved design:

- `CommitForGraph` gains an optional `inheritsParentLane?: boolean`.
  `CommitsPanel` sets it when building the graph input for exactly the two
  synthetic node kinds it already identifies: the working-dir row
  (`WORKING_DIR_ID`) and stash nodes (`stashSelectorById`).
- `computeOwnership` gains a post-pass: a flagged, still-unowned node whose
  **first parent is owned** inherits the parent's lane. Stashes based off an
  unlocked commit stay on free lanes; the flag confines inheritance to
  synthetic nodes - without it every branch forked off a locked branch would
  jump onto the locked lane.
- Tests extend the existing `"computeLanes - first-parent ownership"` suite:
  flagged working-dir row inherits HEAD's locked lane; flagged stash with an
  owned base inherits; flagged stash with an unowned base does not; an
  unflagged child of an owned commit does not (regression guard).
