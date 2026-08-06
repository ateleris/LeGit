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

## Revision 2026-08-06: stashes no longer inherit

In practice flagging stash nodes was wrong: locking `main` to lane 0 piled
every stash of that branch onto lane 0, instead of the free side lanes they
occupy without a lock (user report, LeGit repo: two stashes rendered on the
locked lane). Stashes hang OFF the line; only the working-dir row CONTINUES
it. `CommitsPanel` now flags only `WORKING_DIR_ID`; the `inheritsParentLane`
mechanism in `computeLanes` is unchanged. Pinned in `lanes.test.ts`
("stash (unflagged) with a base on the locked lane takes a free side lane").
Note the flag decision itself lives in CommitsPanel's graph-input mapping,
which no unit test covers - if stashes are ever flagged again, that test
will not catch it; this note is the record of the decision.
