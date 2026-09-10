import type { ConflictKind, ConflictSide, DiffSource } from "../../lib/types";
import type { FileTreeEntry } from "../shared/FileTree/buildTree";
import { useSummonStore } from "../../store/summon";
import { useConfirmDestructive } from "../../store/settings";
import { MenuItem } from "../Commits/menu/primitives";
import { useMenuConfirm } from "../Commits/menu/PanelContextMenu";
import { CopyPathMenuSection } from "../shared/CopyPathMenuSection";
import { OpenInEditorMenuItem } from "../shared/OpenInEditorMenuItem";
import { AddToGitignoreMenuItem } from "../shared/AddToGitignoreMenuItem";
import { takeSideLabels } from "./conflictLabels";
import type { Section } from "./selection";

/**
 * "Reopen conflict" entry for a row (staged or unstaged again) that was a
 * conflict resolution: restores the conflicted state, discarding the current
 * resolution. Destructive, so it inline-confirms per the global
 * destructive-confirmation setting (a hook-using component because the menu
 * content is built inline).
 */
function ReopenConflictMenuItem({ onReopen }: { onReopen: () => void }) {
  const confirmDestructive = useConfirmDestructive();
  const menuConfirm = useMenuConfirm();
  const request = () => {
    if (!confirmDestructive) {
      onReopen();
      return;
    }
    menuConfirm("Reopen conflict? The current resolution will be discarded.", onReopen);
  };
  return (
    <MenuItem onClick={request}>
      {confirmDestructive ? "Reopen conflict…" : "Reopen conflict"}
    </MenuItem>
  );
}

/**
 * Context-menu content for one working-changes file row, shared between the
 * Unstaged and Staged sections (the BACKLOG'd FileRowMenu split). The two
 * sections differ only in their primary action (stage vs unstage), the
 * unstaged-only entries (conflict takes, discard, gitignore), and which diff
 * source an "Open submodule" jump carries.
 */
export function FileRowMenu({
  section,
  file,
  targets,
  opActive,
  reopenable,
  conflictKinds,
  stashable,
  onPrimary,
  onDiscard,
  onStash,
  onTakeSide,
  onMarkResolved,
  onReopenConflict,
  onOpenSubmodule,
  closeMenu,
}: {
  section: Section;
  file: FileTreeEntry;
  /** The paths the menu acts on (the row, or the multi-selection it is in). */
  targets: string[];
  opActive: boolean;
  /** Paths eligible for "Reopen conflict" (git's resolve-undo record). */
  reopenable: Set<string>;
  conflictKinds: Map<string, ConflictKind>;
  /** The subset of `targets` a pathspec stash can take (pre-filtered). */
  stashable: string[];
  /** Stage (unstaged section) / unstage (staged section) the targets. */
  onPrimary: (paths: string[]) => void;
  onDiscard: (paths: string[]) => void;
  onStash: (paths: string[]) => void;
  onTakeSide: (path: string, side: ConflictSide) => void;
  onMarkResolved: (path: string) => void;
  onReopenConflict: (path: string) => void;
  onOpenSubmodule: (path: string, source: DiffSource | null) => void;
  closeMenu: () => void;
}) {
  const many = targets.length > 1;
  const unstaged = section === "unstaged";

  // A dirty-inside submodule (unstaged only) has no stage/discard semantics:
  // its menu is just the submodule jump + file history.
  if (unstaged && file.change === "SubmoduleDirty" && !many) {
    return (
      <>
        <MenuItem onClick={() => { closeMenu(); onOpenSubmodule(file.path, null); }}>
          Open submodule
        </MenuItem>
        <MenuItem
          onClick={() => {
            closeMenu();
            useSummonStore.getState().summon("file-history", file.path);
          }}
        >
          File history
        </MenuItem>
      </>
    );
  }

  const blameHidden = unstaged
    ? file.change === "Untracked" || file.change === "SubmoduleChanged"
    : file.change === "Added" || file.change === "SubmoduleChanged";

  return (
    <>
      {!many && unstaged && file.change === "Conflicted" && (
        <>
          <MenuItem onClick={() => { onTakeSide(file.path, "ours"); closeMenu(); }}>
            {takeSideLabels(conflictKinds.get(file.path)).ours}
          </MenuItem>
          <MenuItem onClick={() => { onTakeSide(file.path, "theirs"); closeMenu(); }}>
            {takeSideLabels(conflictKinds.get(file.path)).theirs}
          </MenuItem>
          <MenuItem onClick={() => { onMarkResolved(file.path); closeMenu(); }}>
            Mark resolved
          </MenuItem>
        </>
      )}
      {!many && file.change === "SubmoduleChanged" && (
        <MenuItem
          onClick={() => {
            closeMenu();
            onOpenSubmodule(file.path, {
              kind: unstaged ? "working_unstaged" : "working_staged",
            });
          }}
        >
          Open submodule
        </MenuItem>
      )}
      {!many &&
        (!unstaged || file.change !== "Conflicted") &&
        opActive &&
        reopenable.has(file.path) && (
          <ReopenConflictMenuItem
            onReopen={() => {
              closeMenu();
              onReopenConflict(file.path);
            }}
          />
        )}
      <MenuItem onClick={() => { onPrimary(targets); closeMenu(); }}>
        {unstaged
          ? many ? `Stage ${targets.length} selected` : "Stage"
          : many ? `Unstage ${targets.length} selected` : "Unstage"}
      </MenuItem>
      {unstaged && (
        <MenuItem onClick={() => { onDiscard(targets); closeMenu(); }}>
          {many
            ? `Discard ${targets.length} selected`
            : file.change === "Untracked"
            ? "Delete file"
            : "Discard changes"}
        </MenuItem>
      )}
      {!opActive && stashable.length > 0 && (
        <MenuItem
          onClick={() => {
            onStash(stashable);
            closeMenu();
          }}
        >
          {many ? `Stash ${stashable.length} selected` : "Stash file"}
        </MenuItem>
      )}
      {!many && !blameHidden && (
        <MenuItem
          onClick={() => {
            closeMenu();
            useSummonStore.getState().summon("blame", file.path);
          }}
        >
          Blame file
        </MenuItem>
      )}
      {!many && (
        <MenuItem
          onClick={() => {
            closeMenu();
            useSummonStore.getState().summon("file-history", file.path);
          }}
        >
          File history
        </MenuItem>
      )}
      {!many && <CopyPathMenuSection path={file.path} onClose={closeMenu} />}
      {!many && file.change !== "Deleted" && file.change !== "SubmoduleChanged" && (
        <OpenInEditorMenuItem path={file.path} onClose={closeMenu} />
      )}
      {!many && unstaged && file.change === "Untracked" && (
        <AddToGitignoreMenuItem path={file.path} onClose={closeMenu} />
      )}
    </>
  );
}
