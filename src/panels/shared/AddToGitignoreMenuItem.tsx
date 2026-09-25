// Shared "Add to .gitignore" context-menu entry (Files, Working Changes).
// Owns the whole flow - append the `.gitignore` line, invalidate status,
// toast - so wording and behaviour cannot drift between panels (the
// StashMenuSection lesson). Untracked files/folders only: the tracked-file
// variant ("Stop tracking & ignore", `git rm --cached`) is destructive,
// confirm-gated, and stays a Files-panel concern.
//
// A nested file renders as a submenu: the trigger click ignores the file
// itself, the flyout offers the file plus each folder layer above it.

import { useQueryClient } from "@tanstack/react-query";
import { MenuItem, Submenu } from "../shared/menu/primitives";
import { api } from "../../lib/commands";
import { invalidateRepoDomains } from "../../lib/repoInvalidation";
import { useActiveRepo } from "../../store/repos";
import { notify } from "../../store/notifications";
import { formatAppError } from "../../lib/errors";
import { ancestorDirs } from "./ancestorDirs";

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

  const add = (target: string, targetIsDir: boolean) => {
    onClose();
    api.repoAddToGitignore(repo.id, target, targetIsDir)
      .then(() => {
        invalidateRepoDomains(queryClient, repo.id, ["status"]);
        notify.success(targetIsDir ? `Ignored ${target}/` : `Ignored ${target}`);
      })
      .catch((e) => notify.error(formatAppError(e)));
  };

  const dirs = isDir ? [] : ancestorDirs(path);
  if (dirs.length === 0) {
    return (
      <MenuItem onClick={() => add(path, isDir)}>
        {isDir ? "Add folder to .gitignore" : "Add to .gitignore"}
      </MenuItem>
    );
  }

  return (
    <Submenu
      testId="menu-gitignore-submenu"
      label="Add to .gitignore"
      onClickActivate={() => add(path, false)}
    >
      <MenuItem onClick={() => add(path, false)}>{path}</MenuItem>
      {dirs.map((dir) => (
        <MenuItem key={dir} onClick={() => add(dir, true)}>
          {`${dir}/`}
        </MenuItem>
      ))}
    </Submenu>
  );
}
