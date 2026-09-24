// Shared tail of every file-row context menu: one place for the wording,
// order, and disabled rules of the common entries, so panels cannot drift
// (the StashMenuSection lesson). Panel-specific entries render around it.

import React from "react";
import { MenuItem, SectionLabel } from "../shared/menu/primitives";
import { CopyPathMenuSection } from "./CopyPathMenuSection";
import { OpenInEditorMenuItem } from "./OpenInEditorMenuItem";
import { AddToGitignoreMenuItem } from "./AddToGitignoreMenuItem";
import { useSummonStore } from "../../store/summon";

export interface FileRowRev {
  /** What file-view/blame are summoned with (sha or user-typed rev). */
  value: string;
  /** Wording: "View file at <label>" / "Blame file at <label>". */
  label: string;
}

export function FileRowMenuSection({
  path,
  header,
  rev = null,
  deleted = false,
  deletedIn = "in this commit",
  submodule = false,
  untracked = false,
  view = false,
  onView,
  onHistory,
  onBlame,
  editorPath = path,
  gitignore = null,
  onClose,
}: {
  /** Repo-relative path (labels, copy entries, default summon payloads). */
  path: string;
  /** Menu header; null hides it; default is the path. */
  header?: React.ReactNode | null;
  rev?: FileRowRev | null;
  /** No content at the shown rev: view/blame disabled. */
  deleted?: boolean;
  deletedIn?: string;
  /** Gitlink row: no blob content. */
  submodule?: boolean;
  /** Not in HEAD: history/blame disabled with the "(untracked)" suffix. */
  untracked?: boolean;
  /** Render the "View file" entry. */
  view?: boolean;
  onView?: () => void;
  onHistory?: () => void;
  onBlame?: () => void;
  /** Working-tree path for "Open in editor"; null hides the entry. */
  editorPath?: string | null;
  gitignore?: "file" | "dir" | null;
  onClose: () => void;
}) {
  const run = (fn: () => void) => () => {
    onClose();
    fn();
  };
  const summon = useSummonStore.getState;

  const viewLabel = deleted
    ? `View file (deleted ${deletedIn})`
    : submodule
      ? "View file (submodule)"
      : rev
        ? `View file at ${rev.label}`
        : "View file";
  const blameLabel = submodule
    ? "Blame (submodule)"
    : untracked
      ? "Blame (untracked)"
      : deleted
        ? `Blame file (deleted ${deletedIn})`
        : rev
          ? `Blame file at ${rev.label}`
          : "Blame file";

  return (
    <>
      {header !== null && <SectionLabel>{header ?? path}</SectionLabel>}
      {view && (
        <MenuItem
          disabled={deleted || submodule}
          onClick={run(
            onView ?? (() => summon().summon("file-view", rev ? { path, rev: rev.value } : path)),
          )}
        >
          {viewLabel}
        </MenuItem>
      )}
      <MenuItem
        disabled={untracked}
        onClick={run(onHistory ?? (() => summon().summon("file-history", path)))}
      >
        {untracked ? "File history (untracked)" : "File history"}
      </MenuItem>
      <MenuItem
        disabled={untracked || submodule || deleted}
        onClick={run(
          onBlame ?? (() => summon().summon("blame", rev ? { path, rev: rev.value } : path)),
        )}
      >
        {blameLabel}
      </MenuItem>
      <CopyPathMenuSection path={path} onClose={onClose} />
      {editorPath !== null && !deleted && !submodule && (
        <OpenInEditorMenuItem path={editorPath} onClose={onClose} />
      )}
      {gitignore !== null && (
        <AddToGitignoreMenuItem path={path} isDir={gitignore === "dir"} onClose={onClose} />
      )}
    </>
  );
}
