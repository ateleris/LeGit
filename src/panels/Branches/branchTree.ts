// Pure adapter: branch names are slash-paths, so the shared FileTree flatten
// (folder rows + compression + collapse) builds the Branches section's tree
// view. Git forbids a branch named like another branch's folder prefix
// ("feature" cannot coexist with "feature/api"), so mapping leaf rows back to
// branches by full path is total.

import { baseName, flatten, type Row } from "../shared/FileTree/buildTree";

/** Tree rows (folders first, alphabetical - `flatten`'s ordering) for the
 *  given branch names. Flat mode never calls this: the flat list renders
 *  exactly as before, sort mode included. */
export function branchTreeRows(names: string[], collapsed: ReadonlySet<string>): Row[] {
  return flatten(
    names.map((name) => ({ path: name })),
    "tree",
    collapsed,
  );
}

/** Display segment for a leaf row (full name stays in tooltips/actions). */
export const leafName = baseName;

/** True when the checked-out branch lives anywhere under this folder - a
 *  collapsed folder shows the current-branch dot so the checkout is never
 *  invisible. */
export function folderHoldsCurrent(
  folderPath: string,
  currentName: string | null | undefined,
): boolean {
  return !!currentName && currentName.startsWith(`${folderPath}/`);
}
