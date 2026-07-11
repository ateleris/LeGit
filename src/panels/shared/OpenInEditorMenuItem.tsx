// Shared "Open in editor" context-menu entry for file rows (Files, Working
// Changes, Changed Files). Opens the working-tree file via the External
// editor command template ($FILE placeholder; reveal-in-file-manager fallback
// when no editor is configured). Shared like CopyPathMenuSection so wording
// and behaviour cannot drift between panels. Fire-and-forget: editors are
// long-lived, only a failure to launch is reported.

import { MenuItem } from "../Commits/menu/primitives";
import { repoOpenFileInEditor } from "../../lib/commands";
import { useActiveRepo } from "../../store/repos";
import { notify } from "../../store/notifications";
import { formatAppError } from "../../lib/types";

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
        repoOpenFileInEditor(repo.id, path).catch((e) =>
          notify.error(formatAppError(e)),
        );
      }}
    >
      Open in editor
    </MenuItem>
  );
}
