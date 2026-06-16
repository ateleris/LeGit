import type { FunctionComponent } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { ConsolePanel } from "./Console/ConsolePanel";
import { CommitsPanel } from "./Commits/CommitsPanel";
import { CommitDetailsPanel } from "./CommitDetails/CommitDetailsPanel";
import { ChangedFilesPanel } from "./ChangedFiles/ChangedFilesPanel";
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
  /** IDs of panels this panel may summon (informational + enforced by API). */
  summons?: string[];
  /** Where to open the panel the first time it's ever opened. */
  defaultPlacement?: DefaultPlacement;
}

export const GLOBAL_PANELS: PanelDescriptor[] = [
  { id: "repositories", title: "Repositories", scope: "global" },
  { id: "theme-editor", title: "Theme Editor", scope: "global" },
  { id: "global-settings", title: "Global Settings", scope: "global" },
];

export const REPO_PANELS: PanelDescriptor[] = [
  { id: "console", title: "Git Console", scope: "repo" },
  { id: "repo-settings", title: "Repo Settings", scope: "repo" },
  {
    id: "log",
    title: "Commits",
    scope: "repo",
    summons: ["commit-details", "changed-files"],
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
    summons: ["diff"],
    defaultPlacement: { direction: "below", referencePanel: "commit-details" },
  },
];

/** All panels, for menus that need to enumerate both docks. */
export const ALL_PANELS = [...GLOBAL_PANELS, ...REPO_PANELS];

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
  "repo-settings": wrap(RepoSettingsPanel),
  log: wrap(CommitsPanel),
  "commit-details": wrap(CommitDetailsPanel),
  "changed-files": wrap(ChangedFilesPanel),
};
