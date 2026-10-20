import type { ConflictKind, ConflictSide, DiffSource } from "../../lib/types";
import type { SideNames } from "../../lib/conflictSides";
import type { FileTreeEntry } from "../shared/FileTree/buildTree";
import { useConfirmDestructive } from "../../store/settings";
import { MenuItem, Submenu } from "../shared/menu/primitives";
import { useDestructiveMenuConfirm } from "../shared/menu/PanelContextMenu";
import { FileRowMenuSection } from "../shared/FileRowMenuSection";
import { takeSideLabels } from "./conflictLabels";
import type { Section } from "./selection";

/**
 * "Resolve conflict" / "Resolve N conflicted" submenu - the one conflict
 * surface for file rows, multi-selections and folders; the actions apply to
 * the conflicted paths only. A single file gets its kind's delete-aware
 * labels; a selection stays kind-generic (it has no single consequence) and
 * each file still resolves per its own conflict kind.
 */
export function ResolveConflictsSubmenu({
  paths,
  conflictKinds,
  sideNames,
  onTakeSide,
  onMarkResolved,
  closeMenu,
}: {
  paths: string[];
  conflictKinds: Map<string, ConflictKind>;
  sideNames: SideNames;
  onTakeSide: (paths: string[], side: ConflictSide) => void;
  onMarkResolved: (paths: string[]) => void;
  closeMenu: () => void;
}) {
  const single = paths.length === 1;
  const labels = takeSideLabels(single ? conflictKinds.get(paths[0]) : undefined, sideNames);
  return (
    <Submenu
      testId="resolve-conflicted"
      label={single ? "Resolve conflict" : `Resolve ${paths.length} conflicted`}
    >
      <MenuItem testId="resolve-take-ours" onClick={() => { onTakeSide(paths, "ours"); closeMenu(); }}>
        {labels.ours}
      </MenuItem>
      <MenuItem testId="resolve-take-theirs" onClick={() => { onTakeSide(paths, "theirs"); closeMenu(); }}>
        {labels.theirs}
      </MenuItem>
      <MenuItem testId="resolve-mark-resolved" onClick={() => { onMarkResolved(paths); closeMenu(); }}>
        Mark resolved
      </MenuItem>
    </Submenu>
  );
}

/**
 * "Reopen conflict" entry for a row (staged or unstaged again) that was a
 * conflict resolution: restores the conflicted state, discarding the current
 * resolution. Destructive, so it inline-confirms per the global
 * destructive-confirmation setting (a hook-using component because the menu
 * content is built inline).
 */
function ReopenConflictMenuItem({ onReopen }: { onReopen: () => void }) {
  const confirmDestructive = useConfirmDestructive();
  const destructiveMenuConfirm = useDestructiveMenuConfirm();
  const request = () =>
    destructiveMenuConfirm("Reopen conflict? The current resolution will be discarded.", onReopen);
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
  sideNames,
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
  /** Branch names for the conflict sides (the Take labels). */
  sideNames: SideNames;
  /** The subset of `targets` a pathspec stash can take (pre-filtered). */
  stashable: string[];
  /** Stage (unstaged section) / unstage (staged section) the targets. */
  onPrimary: (paths: string[]) => void;
  onDiscard: (paths: string[]) => void;
  onStash: (paths: string[]) => void;
  onTakeSide: (paths: string[], side: ConflictSide) => void;
  onMarkResolved: (paths: string[]) => void;
  onReopenConflict: (path: string) => void;
  onOpenSubmodule: (path: string, source: DiffSource | null) => void;
  closeMenu: () => void;
}) {
  const many = targets.length > 1;
  const unstaged = section === "unstaged";
  const conflicted = targets.filter((p) => conflictKinds.has(p));

  // A dirty-inside submodule (unstaged only) has no stage/discard semantics:
  // its menu is just the submodule jump + the common section.
  if (unstaged && file.change === "SubmoduleDirty" && !many) {
    return (
      <>
        <MenuItem onClick={() => { closeMenu(); onOpenSubmodule(file.path, null); }}>
          Open submodule
        </MenuItem>
        <FileRowMenuSection
          path={file.path}
          submodule
          editorPath={null}
          onClose={closeMenu}
        />
      </>
    );
  }

  return (
    <>
      {unstaged &&
        (many ? conflicted.length > 0 : file.change === "Conflicted") && (
          <ResolveConflictsSubmenu
            paths={many ? conflicted : [file.path]}
            conflictKinds={conflictKinds}
            sideNames={sideNames}
            onTakeSide={onTakeSide}
            onMarkResolved={onMarkResolved}
            closeMenu={closeMenu}
          />
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
      {!many && (
        <FileRowMenuSection
          path={file.path}
          untracked={unstaged ? file.change === "Untracked" : file.change === "Added"}
          submodule={file.change === "SubmoduleChanged"}
          editorPath={file.change === "Deleted" ? null : file.path}
          gitignore={unstaged && file.change === "Untracked" ? "file" : null}
          onClose={closeMenu}
        />
      )}
    </>
  );
}
