// Built-in default window layouts, captured from the development setup on
// 2026-07-30 (the dev instance's live dockview layout, baked in verbatim -
// only the settings panels' `confirm-close` tab component was re-added, as
// dockview's toJSON had dropped it). Used whenever the user has not saved
// their own default: first launch and "Reset to default layout" without a
// snapshot. The programmatic builders in RepoDock/GlobalDock stay as the
// last-resort fallback if these fail to apply (e.g. a panel id disappears
// from the registry) - `defaultLayouts.test.ts` guards that drift.
//
// Sizes are the capture-time pixels; dockview re-scales the grid
// proportionally to the actual window on fromJSON.

import type { RepoLayoutEnvelope } from "./layoutSnapshot";

export const DEFAULT_REPO_LAYOUT: RepoLayoutEnvelope = {
  dockview: {
    grid: {
      root: {
        type: "branch",
        data: [
          {
            type: "leaf",
            data: { views: ["git-log", "refs", "repo-settings"], activeView: "refs", id: "3" },
            size: 464,
          },
          {
            type: "leaf",
            data: { views: ["log"], activeView: "log", id: "2" },
            size: 925,
          },
          {
            type: "leaf",
            data: { views: ["commit-details", "working-changes"], activeView: "working-changes", id: "4" },
            size: 413,
          },
          {
            type: "leaf",
            data: { views: ["file-view", "blame", "diff"], activeView: "diff", id: "7" },
            size: 539,
          },
        ],
        size: 1328,
      },
      width: 2341,
      height: 1328,
      orientation: "HORIZONTAL",
    },
    panels: {
      "git-log": { id: "git-log", contentComponent: "git-log", title: "Git Log" },
      refs: { id: "refs", contentComponent: "refs", title: "Refs" },
      "repo-settings": {
        id: "repo-settings",
        contentComponent: "repo-settings",
        tabComponent: "confirm-close",
        title: "Repo Settings",
      },
      log: { id: "log", contentComponent: "log", title: "Commits" },
      "commit-details": { id: "commit-details", contentComponent: "commit-details", title: "Commit Details" },
      "working-changes": { id: "working-changes", contentComponent: "working-changes", title: "Working Changes" },
      "file-view": { id: "file-view", contentComponent: "file-view", title: "File View" },
      blame: { id: "blame", contentComponent: "blame", title: "Blame" },
      diff: { id: "diff", contentComponent: "diff", title: "Diff" },
    },
    activeGroup: "7",
  },
  placements: {
    log: "2",
    "commit-details": "4",
    console: "1",
    "repo-settings": "3",
    "changed-files": "4",
    diff: "7",
    "git-log": "3",
    refs: "3",
    "interactive-rebase": "1",
    compare: "7",
    search: "1",
    files: "2",
    blame: "7",
    "file-history": "5",
    "file-view": "7",
    "working-changes": "4",
    merge: "7",
  },
  fallbacks: {
    log: { referencePanel: "git-log", direction: "right" },
    "commit-details": { referencePanel: "log", direction: "right" },
    console: { referencePanel: "log", direction: "below" },
    "repo-settings": { referencePanel: "log", direction: "left" },
    "changed-files": { referencePanel: "log", direction: "right" },
    diff: { referencePanel: "commit-details", direction: "right" },
    "git-log": { referencePanel: "log", direction: "left" },
    refs: { referencePanel: "log", direction: "left" },
    "working-changes": { referencePanel: "log", direction: "right" },
    "file-view": { referencePanel: "commit-details", direction: "right" },
    "file-history": { referencePanel: "commit-details", direction: "below" },
    merge: { referencePanel: "commit-details", direction: "right" },
    compare: { referencePanel: "commit-details", direction: "right" },
    files: { referencePanel: "git-log", direction: "right" },
    search: { referencePanel: "log", direction: "right" },
    blame: { referencePanel: "commit-details", direction: "right" },
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
            views: ["repositories", "theme-editor", "global-settings"],
            activeView: "global-settings",
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
    repositories: { id: "repositories", contentComponent: "repositories", title: "Repositories" },
    "theme-editor": { id: "theme-editor", contentComponent: "theme-editor", title: "Theme Editor" },
    "global-settings": {
      id: "global-settings",
      contentComponent: "global-settings",
      tabComponent: "confirm-close",
      title: "Global Settings",
    },
  },
  activeGroup: "3",
};
