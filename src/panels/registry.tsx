import type { FunctionComponent } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { ConsolePanel } from "./Console/ConsolePanel";
import { CommitsPanel } from "./Commits/CommitsPanel";
import { CommitDetailsPanel } from "./CommitDetails/CommitDetailsPanel";
import { ChangedFilesPanel } from "./ChangedFiles/ChangedFilesPanel";
import { WorkingChangesPanel } from "./WorkingChanges/WorkingChangesPanel";
import { DiffPanel } from "./Diff/DiffPanel";
import { MergePanel } from "./Merge/MergePanel";
import { InteractiveRebasePanel } from "./InteractiveRebase/InteractiveRebasePanel";
import { ComparePanel } from "./Compare/ComparePanel";
import { BlamePanel } from "./Blame/BlamePanel";
import { FileViewPanel } from "./FileView/FileViewPanel";
import { FileHistoryPanel } from "./FileHistory/FileHistoryPanel";
import { FilesPanel } from "./Files/FilesPanel";
import { GitLogPanel } from "./GitLog/GitLogPanel";
import { RefsPanel } from "./Refs/RefsPanel";
import { RepositoriesPanel } from "./Repositories/RepositoriesPanel";
import { ThemeEditorPanel } from "./ThemeEditor/ThemeEditorPanel";
import { GlobalSettingsPanel } from "./Settings/GlobalSettingsPanel";
import { RepoSettingsPanel } from "./Settings/RepoSettingsPanel";
import { PanelApiProvider } from "./PanelApiContext";
import { ConfirmCloseTab } from "./ConfirmCloseTab";
import type { IDockviewPanelHeaderProps } from "dockview-react";

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
  /** IDs of panels this panel may summon. Informational only - `summon()`
   *  does not enforce it; keep it in sync when adding summon() calls. */
  summons?: string[];
  /** Where to open the panel the first time it's ever opened. */
  defaultPlacement?: DefaultPlacement;
  /** Panel this one shares a dock slot with: summoning one while the other is
   *  open takes over its group and closes it (enforced by `summon()`). */
  swapsWith?: string;
}

export const GLOBAL_PANELS: PanelDescriptor[] = [
  { id: "repositories", title: "Repositories", scope: "global" },
  { id: "theme-editor", title: "Theme Editor", scope: "global" },
  { id: "global-settings", title: "Global Settings", scope: "global" },
];

export const REPO_PANELS: PanelDescriptor[] = [
  { id: "console", title: "Git Console", scope: "repo" },
  {
    id: "git-log",
    title: "Git Log",
    scope: "repo",
    defaultPlacement: { direction: "below", referencePanel: "log" },
  },
  { id: "repo-settings", title: "Repo Settings", scope: "repo" },
  {
    // Branches + Remotes + Stashes combined as a vertical accordion
    // (Paneview) — see Refs/RefsPanel. The Stashes pane's "View diff"
    // summons the commit-details/changed-files slot.
    id: "refs",
    title: "Refs",
    scope: "repo",
    summons: ["commit-details", "changed-files", "working-changes"],
    defaultPlacement: { direction: "left", referencePanel: "log" },
  },
  {
    id: "log",
    title: "Commits",
    scope: "repo",
    summons: ["commit-details", "changed-files", "working-changes", "interactive-rebase", "compare", "files"],
  },
  {
    id: "interactive-rebase",
    title: "Interactive Rebase",
    scope: "repo",
    defaultPlacement: { direction: "right", referencePanel: "log" },
  },
  {
    id: "compare",
    title: "Compare",
    scope: "repo",
    summons: ["diff"],
    defaultPlacement: { direction: "right", referencePanel: "log" },
  },
  {
    id: "files",
    title: "Files",
    scope: "repo",
    summons: ["blame", "file-history", "file-view"],
    defaultPlacement: { direction: "left", referencePanel: "log" },
  },
  {
    id: "blame",
    title: "Blame",
    scope: "repo",
    summons: ["commit-details", "changed-files", "file-history", "log"],
    defaultPlacement: { direction: "right", referencePanel: "log" },
  },
  {
    id: "file-history",
    title: "File History",
    scope: "repo",
    summons: [
      "commit-details",
      "changed-files",
      "working-changes",
      "file-view",
      "blame",
      "diff",
      "log",
    ],
    defaultPlacement: { direction: "right", referencePanel: "log" },
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
    summons: ["diff", "file-view"],
    defaultPlacement: { direction: "below", referencePanel: "commit-details" },
  },
  {
    id: "file-view",
    title: "File View",
    scope: "repo",
    defaultPlacement: { direction: "right", referencePanel: "log" },
  },
  {
    id: "working-changes",
    title: "Working Changes",
    scope: "repo",
    summons: ["diff"],
    // Same slot as Changed Files — the two swap in/out of this spot.
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
];

/** All panels, for menus that need to enumerate both docks. */
export const ALL_PANELS = [...GLOBAL_PANELS, ...REPO_PANELS];

/**
 * Detail/secondary panels that appear via `summon` and that the user may opt
 * out of auto-opening (Settings → "Auto-open panels"): a summon to a suppressed
 * one degrades to `notifyIfOpen`. Deliberately excludes `log` (Commits), which
 * the app opens on startup, and non-summoned panels.
 */
export const SUPPRESSIBLE_SUMMON_PANELS: string[] = [
  "commit-details",
  "changed-files",
  "working-changes",
  "diff",
  "merge",
  "file-view",
  "file-history",
  "blame",
  "compare",
  "interactive-rebase",
  "files",
];

const TAB_COMPONENTS: Record<string, FunctionComponent<IDockviewPanelHeaderProps>> = {
  "confirm-close": ConfirmCloseTab,
};

export const GLOBAL_DOCKVIEW_TAB_COMPONENTS = TAB_COMPONENTS;
export const REPO_DOCKVIEW_TAB_COMPONENTS = TAB_COMPONENTS;

const wrap = (
  Inner: FunctionComponent
): FunctionComponent<IDockviewPanelProps> => {
  const Wrapped: FunctionComponent<IDockviewPanelProps> = ({ api }) => (
    <PanelApiProvider api={api}>
      <Inner />
    </PanelApiProvider>
  );
  Wrapped.displayName = `Dockable(${Inner.displayName ?? Inner.name ?? "Panel"})`;
  return Wrapped;
};

export const GLOBAL_DOCKVIEW_COMPONENTS: Record<
  string,
  FunctionComponent<IDockviewPanelProps>
> = {
  repositories: wrap(RepositoriesPanel),
  "theme-editor": wrap(ThemeEditorPanel),
  "global-settings": wrap(GlobalSettingsPanel),
};

export const REPO_DOCKVIEW_COMPONENTS: Record<
  string,
  FunctionComponent<IDockviewPanelProps>
> = {
  console: wrap(ConsolePanel),
  "git-log": wrap(GitLogPanel),
  "repo-settings": wrap(RepoSettingsPanel),
  refs: wrap(RefsPanel),
  log: wrap(CommitsPanel),
  "commit-details": wrap(CommitDetailsPanel),
  "changed-files": wrap(ChangedFilesPanel),
  "working-changes": wrap(WorkingChangesPanel),
  diff: wrap(DiffPanel),
  merge: wrap(MergePanel),
  "interactive-rebase": wrap(InteractiveRebasePanel),
  compare: wrap(ComparePanel),
  files: wrap(FilesPanel),
  blame: wrap(BlamePanel),
  "file-view": wrap(FileViewPanel),
  "file-history": wrap(FileHistoryPanel),
};
