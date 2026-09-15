import type { FileTreeEntry } from "../shared/FileTree/buildTree";

/**
 * Whether a tree-view folder may offer "Add folder to .gitignore": every file
 * under it is untracked. Ignoring a folder that still holds tracked changes
 * would not hide them - the tracked variant (`git rm --cached`) is a
 * Files-panel concern.
 */
export function allUntracked(paths: string[], files: FileTreeEntry[]): boolean {
  if (paths.length === 0) return false;
  const changeByPath = new Map(files.map((f) => [f.path, f.change]));
  return paths.every((p) => changeByPath.get(p) === "Untracked");
}
