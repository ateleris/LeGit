// Shared context-menu entries offered by every file-listing panel (Files,
// Working Changes, Changed Files, File History, Compare, Search): "Copy
// relative path" (repo-relative, as git reports it) and "Copy absolute path"
// (repo root + relative path, OS-native separators). Shared like
// StashMenuSection so wording and behaviour cannot drift between panels
// (design/2026-07-09-copy-path-actions.md). The section renders entries
// only — the caller owns its SectionLabel.

import { MenuItem } from "../Commits/menu/primitives";
import { useActiveRepo } from "../../store/repos";
import { toAbsolutePath } from "../../lib/paths";
import { copyText } from "../../lib/clipboard";
import { notify } from "../../store/notifications";
import { formatAppError } from "../../lib/types";

export function CopyPathMenuSection({
  path,
  onClose,
}: {
  /** Repo-relative path (POSIX-style, as git reports it). */
  path: string;
  onClose: () => void;
}) {
  const repo = useActiveRepo();

  const copy = (text: string) => {
    onClose();
    copyText(text).then(
      () => notify.success(`Copied ${text}`),
      (e) => notify.error(formatAppError(e)),
    );
  };

  return (
    <>
      <MenuItem onClick={() => copy(path)}>Copy relative path</MenuItem>
      {repo !== null && (
        <MenuItem onClick={() => copy(toAbsolutePath(repo.path, path))}>
          Copy absolute path
        </MenuItem>
      )}
    </>
  );
}
