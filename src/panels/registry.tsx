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
import { ReleaseNotesPanel } from "./ReleaseNotes/ReleaseNotesPanel";
import { RepositoriesPanel } from "./Repositories/RepositoriesPanel";
import { ThemeEditorPanel } from "./ThemeEditor/ThemeEditorPanel";
import { LayoutsPanel } from "./Layouts/LayoutsPanel";
import { KeyboardShortcutsPanel } from "./Shortcuts/KeyboardShortcutsPanel";
import { GlobalSettingsPanel } from "./Settings/GlobalSettingsPanel";
import { RepoSettingsPanel } from "./Settings/RepoSettingsPanel";
import { PanelApiProvider } from "./PanelApiContext";
import { ConfirmCloseTab } from "./ConfirmCloseTab";
import type { IDockviewPanelHeaderProps } from "dockview-react";

// Panel descriptors (ids, titles, placement) live in descriptors.ts to keep
// them importable from panel components without a cycle; re-exported here so
// existing consumers keep working.
export * from "../layout/descriptors";

const TAB_COMPONENTS: Record<string, FunctionComponent<IDockviewPanelHeaderProps>> = {
  "confirm-close": ConfirmCloseTab,
};

export const GLOBAL_DOCKVIEW_TAB_COMPONENTS = TAB_COMPONENTS;
export const REPO_DOCKVIEW_TAB_COMPONENTS = TAB_COMPONENTS;

const wrap = (
  Inner: FunctionComponent
): FunctionComponent<IDockviewPanelProps> => {
  // data-panel-id lets focus-dependent logic map DOM focus back to the panel
  // (focusedDockPanelId in store/dockview.ts).
  const Wrapped: FunctionComponent<IDockviewPanelProps> = ({ api }) => (
    <PanelApiProvider api={api}>
      <div data-panel-id={api.id} style={{ height: "100%" }}>
        <Inner />
      </div>
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
  layouts: wrap(LayoutsPanel),
  "keyboard-shortcuts": wrap(KeyboardShortcutsPanel),
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
  "release-notes": wrap(ReleaseNotesPanel),
  files: wrap(FilesPanel),
  blame: wrap(BlamePanel),
  "file-view": wrap(FileViewPanel),
  "file-history": wrap(FileHistoryPanel),
};
