import type { FunctionComponent } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { ConsolePanel } from "./Console/ConsolePanel";
import { RepositoriesPanel } from "./Repositories/RepositoriesPanel";
import { ThemeEditorPanel } from "./ThemeEditor/ThemeEditorPanel";
import { SettingsPanel } from "./Settings/SettingsPanel";

/** Panel descriptor used by both dockview's component map and the
 *  "Add panel" menu in the tab strip. */
export interface PanelDescriptor {
  /** Stable identifier — also used as dockview's `component` string. */
  id: string;
  /** Human-readable name shown in tabs. */
  title: string;
  /** Available in v0.1. */
  shipInV0_1: boolean;
}

export const PANELS: PanelDescriptor[] = [
  { id: "repositories", title: "Repositories", shipInV0_1: true },
  { id: "console", title: "Git Console", shipInV0_1: true },
  { id: "theme-editor", title: "Theme Editor", shipInV0_1: true },
  { id: "settings", title: "Settings", shipInV0_1: true },
];

// Dockview's components map expects components that *accept* IDockviewPanelProps.
// Our panel components ignore the props; the wrappers below are the type
// adapter so each panel can be a normal React component internally.
const wrap = (
  Inner: FunctionComponent
): FunctionComponent<IDockviewPanelProps> => {
  const Wrapped: FunctionComponent<IDockviewPanelProps> = () => <Inner />;
  Wrapped.displayName = `Dockable(${Inner.displayName ?? Inner.name ?? "Panel"})`;
  return Wrapped;
};

export const DOCKVIEW_COMPONENTS: Record<
  string,
  FunctionComponent<IDockviewPanelProps>
> = {
  repositories: wrap(RepositoriesPanel),
  console: wrap(ConsolePanel),
  "theme-editor": wrap(ThemeEditorPanel),
  settings: wrap(SettingsPanel),
};
