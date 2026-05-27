import type { FunctionComponent } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { ConsolePanel } from "./Console/ConsolePanel";
import { RepositoriesPanel } from "./Repositories/RepositoriesPanel";
import { ThemeEditorPanel } from "./ThemeEditor/ThemeEditorPanel";
import { GlobalSettingsPanel } from "./Settings/GlobalSettingsPanel";
import { RepoSettingsPanel } from "./Settings/RepoSettingsPanel";

export interface PanelDescriptor {
  id: string;
  title: string;
  scope: "global" | "repo";
}

export const GLOBAL_PANELS: PanelDescriptor[] = [
  { id: "repositories", title: "Repositories", scope: "global" },
  { id: "theme-editor", title: "Theme Editor", scope: "global" },
  { id: "global-settings", title: "Global Settings", scope: "global" },
];

export const REPO_PANELS: PanelDescriptor[] = [
  { id: "console", title: "Git Console", scope: "repo" },
  { id: "repo-settings", title: "Repo Settings", scope: "repo" },
];

/** All panels, for menus that need to enumerate both docks. */
export const ALL_PANELS = [...GLOBAL_PANELS, ...REPO_PANELS];

const wrap = (
  Inner: FunctionComponent
): FunctionComponent<IDockviewPanelProps> => {
  const Wrapped: FunctionComponent<IDockviewPanelProps> = () => <Inner />;
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
};
