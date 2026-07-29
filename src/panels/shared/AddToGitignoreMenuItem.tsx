// Shared "Add to .gitignore" context-menu entry (Files, Working Changes).
// Owns the whole flow - append the `.gitignore` line, invalidate status,
// toast - so wording and behaviour cannot drift between panels (the
// StashMenuSection lesson). Untracked files/folders only: the tracked-file
// variant ("Stop tracking & ignore", `git rm --cached`) is destructive,
// confirm-gated, and stays a Files-panel concern.

import { useQueryClient } from "@tanstack/react-query";
import { MenuItem } from "../Commits/menu/primitives";
import { repoAddToGitignore } from "../../lib/commands";
import { invalidateRepoDomains } from "../../lib/repoInvalidation";
import { useActiveRepo } from "../../store/repos";
import { notify } from "../../store/notifications";
import { formatAppError } from "../../lib/types";

export function AddToGitignoreMenuItem({
  path,
  isDir = false,
  onClose,
}: {
  /** Repo-relative path (POSIX-style, as git reports it). */
  path: string;
  /** Folder rows get a trailing `/` in the ignore line and the label. */
  isDir?: boolean;
  onClose: () => void;
}) {
  const repo = useActiveRepo();
  const queryClient = useQueryClient();
  if (repo === null) return null;

  return (
    <MenuItem
      onClick={() => {
        onClose();
        repoAddToGitignore(repo.id, path, isDir)
          .then(() => {
            invalidateRepoDomains(queryClient, repo.id, ["status"]);
            notify.success(isDir ? `Ignored ${path}/` : `Ignored ${path}`);
          })
          .catch((e) => notify.error(formatAppError(e)));
      }}
    >
      {isDir ? "Add folder to .gitignore" : "Add to .gitignore"}
    </MenuItem>
  );
}
