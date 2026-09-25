// Panel descriptors: pure data about every panel (ids, titles, placement).
// Kept separate from registry.tsx (which imports every panel component) so
// panels themselves — e.g. the Theme Editor's panel-override picker — can
// enumerate panels without an import cycle.

export interface DefaultPlacement {
  /** Which dock region to open into. */
  direction: "left" | "right" | "above" | "below" | "within";
  /** ID of the reference panel to position relative to. */
  referencePanel?: string;
}

export interface PanelDescriptor {
  id: string;
  title: string;
  scope: "global" | "repo";
  /** Where to open the panel the first time it's ever opened. */
  defaultPlacement?: DefaultPlacement;
  /** Panel this one shares a dock slot with: summoning one while the other is
   *  open takes over its group and closes it (enforced by `summon()`). */
  swapsWith?: string;
  /** Transient panel whose ONLY entry point is a summon: it has no View-menu
   *  entry and must never be suppressible (a suppressed summon degrades to
   *  notifyIfOpen, which would make the panel permanently unreachable). */
  summonOnly?: boolean;
}

// Declaration order IS the View menu order (settings first); every other
// consumer looks panels up by id, so the arrays are safe to reorder.
export const GLOBAL_PANELS: PanelDescriptor[] = [
  { id: "global-settings", title: "Global Settings", scope: "global" },
  { id: "repositories", title: "Repositories", scope: "global" },
  { id: "theme-editor", title: "Theme Editor", scope: "global" },
  { id: "layouts", title: "Layouts", scope: "global" },
  { id: "keyboard-shortcuts", title: "Keyboard Shortcuts", scope: "global" },
];

// Menu order: Repo Settings first, then the default layout's main views,
// then the file/history tools, then tooling; summon-only panels (hidden
// from the menu) trail at the end.
export const REPO_PANELS: PanelDescriptor[] = [
  { id: "repo-settings", title: "Repo Settings", scope: "repo" },
  { id: "log", title: "Commits", scope: "repo" },
  {
    // Branches + Remotes + Stashes combined as a vertical accordion
    // (Paneview) — see Refs/RefsPanel. The Stashes pane's "View diff"
    // summons the commit-details/changed-files slot.
    id: "refs",
    title: "Refs",
    scope: "repo",
    defaultPlacement: { direction: "left", referencePanel: "log" },
  },
  {
    id: "working-changes",
    title: "Working Changes",
    scope: "repo",
    // Same slot as Changed Files — the two swap in/out of this spot.
    defaultPlacement: { direction: "below", referencePanel: "commit-details" },
  },
  {
    id: "commit-details",
    title: "Commit Details",
    scope: "repo",
    defaultPlacement: { direction: "right", referencePanel: "log" },
  },
  {
    id: "changed-files",
    title: "Changed Files",
    scope: "repo",
    defaultPlacement: { direction: "below", referencePanel: "commit-details" },
  },
  {
    id: "diff",
    title: "Diff",
    scope: "repo",
    defaultPlacement: { direction: "right", referencePanel: "changed-files" },
    swapsWith: "merge",
  },
  {
    id: "merge",
    title: "Merge",
    scope: "repo",
    // Shares the Diff panel's spot (`swapsWith`), so the default placement
    // only matters when neither is open.
    defaultPlacement: { direction: "right", referencePanel: "changed-files" },
    swapsWith: "diff",
  },
  {
    id: "compare",
    title: "Compare",
    scope: "repo",
    defaultPlacement: { direction: "right", referencePanel: "log" },
  },
  {
    id: "files",
    title: "Files",
    scope: "repo",
    defaultPlacement: { direction: "left", referencePanel: "log" },
  },
  {
    id: "file-view",
    title: "File View",
    scope: "repo",
    defaultPlacement: { direction: "right", referencePanel: "log" },
  },
  {
    id: "file-history",
    title: "File History",
    scope: "repo",
    defaultPlacement: { direction: "right", referencePanel: "log" },
  },
  {
    id: "blame",
    title: "Blame",
    scope: "repo",
    defaultPlacement: { direction: "right", referencePanel: "log" },
  },
  { id: "console", title: "Git Console", scope: "repo" },
  {
    id: "git-log",
    title: "Git Command Log",
    scope: "repo",
    defaultPlacement: { direction: "below", referencePanel: "log" },
  },
  {
    id: "release-notes",
    title: "Release Notes",
    scope: "repo",
    defaultPlacement: { direction: "right", referencePanel: "log" },
  },
  {
    // Transient: summoned from a commit row's context menu, closes itself
    // when the rebase ends (see InteractiveRebasePanel).
    id: "interactive-rebase",
    title: "Interactive Rebase",
    scope: "repo",
    defaultPlacement: { direction: "right", referencePanel: "log" },
    summonOnly: true,
  },
];

/** All panels, for menus that need to enumerate both docks. */
export const ALL_PANELS = [...GLOBAL_PANELS, ...REPO_PANELS];

/** Tab title per panel id - the single source of truth for titles. Every
 *  other place a title surfaces (persisted layouts, the baked defaults, the
 *  programmatic fallback builders) resolves through this map, so renaming a
 *  panel is a one-line change to its descriptor above. */
export const PANEL_TITLES: Readonly<Record<string, string>> = Object.fromEntries(
  ALL_PANELS.map((p) => [p.id, p.title]),
);

/**
 * Panels that pop open as a SIDE EFFECT of selecting data (a commit, a file
 * row) and that the user may opt out of auto-opening (Settings → "Auto-open
 * panels"): a summon to a suppressed one degrades to `notifyIfOpen`.
 * Deliberately narrow (decided 2026-08-19): a panel whose summon IS the
 * user's explicit action (context-menu "Blame" / "File history" / "Compare" /
 * "Browse files" / "View file", the merge editor) must NOT be listed -
 * suppressing it would turn that click into a silent no-op. Same for
 * `summonOnly` panels (interactive-rebase, unreachable if suppressed) and
 * `log` (Commits), which the app opens on startup. This list is also the
 * AUTHORITY for what a stored settings entry may suppress (`isSuppressed` in
 * store/summon.ts), so a stale persisted id is inert.
 */
export const SUPPRESSIBLE_SUMMON_PANELS: string[] = [
  "commit-details",
  "changed-files",
  "working-changes",
  "diff",
];
