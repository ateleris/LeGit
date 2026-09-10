import type { FileTreeEntry } from "../shared/FileTree/buildTree";

/**
 * Expand unstage targets with each selected rename's source path. `git
 * restore --staged` on the new path alone unstages only the add half and
 * leaves the source's deletion staged - the pair must be restored together
 * to return the index to HEAD.
 */
export function expandUnstagePaths(paths: string[], staged: FileTreeEntry[]): string[] {
  const included = new Set(paths);
  const out = [...paths];
  for (const entry of staged) {
    if (entry.old_path && included.has(entry.path) && !included.has(entry.old_path)) {
      included.add(entry.old_path);
      out.push(entry.old_path);
    }
  }
  return out;
}
