// Shared "Open in editor" context-menu entry for file rows (Files, Working
// Changes, Changed Files). Opens the working-tree file via the External
// editor command template ($FILE placeholder; reveal-in-file-manager fallback
// when no editor is configured). Shared like CopyPathMenuSection so wording
// and behaviour cannot drift between panels. Fire-and-forget: editors are
// long-lived, only a failure to launch is reported.

import { MenuItem } from "../shared/menu/primitives";
import { api } from "../../lib/commands";
import { useActiveRepo } from "../../store/repos";
import { notify } from "../../store/notifications";
import { formatAppError } from "../../lib/errors";

/** "Open in folder": selects the WORKING-TREE file in the OS file
 *  manager (WSL repos through the share). Always the current content - a
 *  historical blob has nothing to reveal. */
export function OpenInFolderMenuItem({
  path,
  onClose,
}: {
  /** Repo-relative working-tree path. */
  path: string;
  onClose: () => void;
}) {
  const repo = useActiveRepo();
  if (repo === null) return null;

  return (
    <MenuItem
      onClick={() => {
        onClose();
        api.repoRevealPath(repo.id, path).catch((e) => notify.error(formatAppError(e)));
      }}
    >
      Open in folder
    </MenuItem>
  );
}

/** "Open this version in editor": the blob at `rev` is written to a host
 *  temp copy (detached - edits go nowhere) and opened like any file. */
export function OpenAtRevisionInEditorMenuItem({
  path,
  rev,
  revLabel,
  onClose,
}: {
  /** Repo-relative path AT the revision (rename-aware rows pass that one). */
  path: string;
  rev: string;
  /** Wording: "Open file at <revLabel>". */
  revLabel: string;
  onClose: () => void;
}) {
  const repo = useActiveRepo();
  if (repo === null) return null;

  return (
    <MenuItem
      onClick={() => {
        onClose();
        api.repoOpenFileAtRevisionInEditor(repo.id, rev, path).catch((e) =>
          notify.error(formatAppError(e)),
        );
      }}
    >
      Open file at {revLabel}
    </MenuItem>
  );
}

export function OpenInEditorMenuItem({
  path,
  onClose,
}: {
  /** Repo-relative path (POSIX-style, as git reports it). */
  path: string;
  onClose: () => void;
}) {
  const repo = useActiveRepo();
  if (repo === null) return null;

  return (
    <MenuItem
      onClick={() => {
        onClose();
        api.repoOpenFileInEditor(repo.id, path).catch((e) =>
          notify.error(formatAppError(e)),
        );
      }}
    >
      Open file
    </MenuItem>
  );
}
