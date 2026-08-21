// Built-in default window layouts. The repo layout is the DESIGNED first-run
// arrangement (2026-08-21, release-blocker "first-run experience" - it
// replaced a verbatim dev-setup capture from 2026-07-30): the panels a new
// user's first clicks land in, and nothing else.
//
//   Refs | Commits | Commit Details over Working Changes | Diff
//
// Clicking a commit fills Commit Details and swaps Changed Files into the
// Working Changes slot; clicking a file fills the Diff panel - every default
// interaction lands in an already-open group, never splitting the layout.
// Tooling panels (Git Console, Git Command Log, Repo Settings) start closed;
// the placements/fallbacks below pre-seed where panels land when first
// summoned or opened via the View menu. Used whenever the user has not saved
// their own default: first launch and "Reset to default layout" without a
// snapshot. The programmatic builders in RepoDock/GlobalDock stay as the
// last-resort fallback if these fail to apply (e.g. a panel id disappears
// from the registry) - `defaultLayouts.test.ts` guards that drift.
//
// Sizes are design-time pixels for a 1600x900 window; dockview re-scales the
// grid proportionally to the actual window on fromJSON.
//
// Panel entries deliberately carry NO `title`: tab titles live only in the
// panel registry, and the apply path (sanitizeDockviewLayout) injects them
// from there. When re-capturing these layouts from a live dockview, strip
// the `title` fields again - defaultLayouts.test.ts enforces this.

import type { RepoLayoutEnvelope } from "./layoutSnapshot";

export const DEFAULT_REPO_LAYOUT: RepoLayoutEnvelope = {
  dockview: {
    grid: {
      root: {
        type: "branch",
        data: [
          {
            type: "leaf",
            data: { views: ["refs"], activeView: "refs", id: "1" },
            size: 260,
          },
          {
            type: "leaf",
            data: { views: ["log"], activeView: "log", id: "2" },
            size: 620,
          },
          {
            // Right detail column: Commit Details on top, the shared
            // Working Changes / Changed Files slot below.
            type: "branch",
            data: [
              {
                type: "leaf",
                data: { views: ["commit-details"], activeView: "commit-details", id: "3" },
                size: 380,
              },
              {
                type: "leaf",
                data: { views: ["working-changes"], activeView: "working-changes", id: "4" },
                size: 520,
              },
            ],
            size: 340,
          },
          {
            type: "leaf",
            data: { views: ["diff"], activeView: "diff", id: "5" },
            size: 380,
          },
        ],
        size: 900,
      },
      width: 1600,
      height: 900,
      orientation: "HORIZONTAL",
    },
    panels: {
      refs: { id: "refs", contentComponent: "refs" },
      log: { id: "log", contentComponent: "log" },
      "commit-details": { id: "commit-details", contentComponent: "commit-details" },
      "working-changes": { id: "working-changes", contentComponent: "working-changes" },
      diff: { id: "diff", contentComponent: "diff" },
    },
    activeGroup: "2",
  },
  // Pre-seeded landing spots for panels the user opens later: closed panels
  // whose natural home is an existing group join it as a tab (Changed Files
  // shares the Working Changes slot; Merge/File View/Blame/Compare share the
  // Diff group; Files and Repo Settings tab next to Refs).
  placements: {
    refs: "1",
    files: "1",
    "repo-settings": "1",
    log: "2",
    "commit-details": "3",
    "working-changes": "4",
    "changed-files": "4",
    diff: "5",
    merge: "5",
    "file-view": "5",
    blame: "5",
    compare: "5",
  },
  // Where those panels go when their remembered group is gone (splits off a
  // still-open reference panel). Console / Git Command Log get a bottom
  // split - as tabs they would cover the commits list.
  fallbacks: {
    refs: { referencePanel: "log", direction: "left" },
    log: { referencePanel: "refs", direction: "right" },
    "commit-details": { referencePanel: "log", direction: "right" },
    "working-changes": { referencePanel: "commit-details", direction: "below" },
    "changed-files": { referencePanel: "commit-details", direction: "below" },
    diff: { referencePanel: "commit-details", direction: "right" },
    merge: { referencePanel: "commit-details", direction: "right" },
    "file-view": { referencePanel: "commit-details", direction: "right" },
    blame: { referencePanel: "commit-details", direction: "right" },
    compare: { referencePanel: "commit-details", direction: "right" },
    "file-history": { referencePanel: "commit-details", direction: "below" },
    files: { referencePanel: "log", direction: "left" },
    "repo-settings": { referencePanel: "log", direction: "left" },
    console: { referencePanel: "log", direction: "below" },
    "git-log": { referencePanel: "log", direction: "below" },
  },
};

export const DEFAULT_GLOBAL_LAYOUT: unknown = {
  grid: {
    root: {
      type: "branch",
      data: [
        {
          type: "leaf",
          data: {
            // First-run: land on Repositories - opening/cloning a repo is
            // the first thing a new user needs to do.
            views: ["repositories", "theme-editor", "global-settings"],
            activeView: "repositories",
            id: "3",
          },
          size: 700,
        },
      ],
      size: 1360,
    },
    width: 700,
    height: 1360,
    orientation: "HORIZONTAL",
  },
  panels: {
    repositories: { id: "repositories", contentComponent: "repositories" },
    "theme-editor": { id: "theme-editor", contentComponent: "theme-editor" },
    "global-settings": {
      id: "global-settings",
      contentComponent: "global-settings",
      tabComponent: "confirm-close",
    },
  },
  activeGroup: "3",
};
