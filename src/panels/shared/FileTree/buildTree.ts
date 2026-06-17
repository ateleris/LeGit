// Pure tree-building + flattening for the FileTree component.
//
// Turns a flat list of changed files into a render-ready row list, either as a
// directory tree (single-child folder chains compressed, VS Code style) or a
// flat path list. Kept free of React/DOM so it can be unit-tested and reused.

import type { FileState } from "../../../lib/types";

export type ViewMode = "tree" | "flat";

/**
 * Minimal shape `FileTree` renders. `CommitFileChange` satisfies it; the
 * Working Changes panel maps `FileStatus` into it (line counts omitted).
 */
export interface FileTreeEntry {
  path: string;
  change: FileState;
  old_path?: string | null;
  additions?: number;
  deletions?: number;
  binary?: boolean;
}

export interface DirRow {
  kind: "dir";
  /** Full path of the (possibly compressed) directory — unique key + collapse id. */
  path: string;
  /** Display label; for a compressed chain this is e.g. "src/panels/Commits". */
  label: string;
  depth: number;
  /** Number of changed files anywhere under this directory. */
  fileCount: number;
  collapsed: boolean;
}

export interface FileRow {
  kind: "file";
  path: string;
  depth: number;
  file: FileTreeEntry;
}

export type Row = DirRow | FileRow;

interface DirNode {
  name: string;
  children: Map<string, DirNode>;
  files: FileTreeEntry[];
}

function makeDir(name: string): DirNode {
  return { name, children: new Map(), files: [] };
}

export function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

/** Build a nested directory tree from the changed files (by their new path). */
function buildDirTree(files: FileTreeEntry[]): DirNode {
  const root = makeDir("");
  for (const f of files) {
    const parts = f.path.split("/");
    let cursor = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      let child = cursor.children.get(seg);
      if (!child) {
        child = makeDir(seg);
        cursor.children.set(seg, child);
      }
      cursor = child;
    }
    cursor.files.push(f);
  }
  return root;
}

function countFiles(dir: DirNode): number {
  let n = dir.files.length;
  for (const c of dir.children.values()) n += countFiles(c);
  return n;
}

/**
 * Collapse a single-child folder chain: while a directory has exactly one
 * subdirectory and no files of its own, merge it into the label/path. Returns
 * the compressed label/path and the deepest node reached (whose children/files
 * are what actually render beneath this row).
 */
function compress(node: DirNode, fullPath: string): { label: string; fullPath: string; node: DirNode } {
  let label = node.name;
  let path = fullPath;
  let cur = node;
  while (cur.children.size === 1 && cur.files.length === 0) {
    const child = cur.children.values().next().value as DirNode;
    label = `${label}/${child.name}`;
    path = `${path}/${child.name}`;
    cur = child;
  }
  return { label, fullPath: path, node: cur };
}

function emitChildren(
  dir: DirNode,
  prefix: string,
  depth: number,
  collapsed: ReadonlySet<string>,
  out: Row[],
): void {
  const dirs = [...dir.children.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const child of dirs) {
    const childPath = prefix ? `${prefix}/${child.name}` : child.name;
    const c = compress(child, childPath);
    const isCollapsed = collapsed.has(c.fullPath);
    out.push({
      kind: "dir",
      path: c.fullPath,
      label: c.label,
      depth,
      fileCount: countFiles(c.node),
      collapsed: isCollapsed,
    });
    if (!isCollapsed) emitChildren(c.node, c.fullPath, depth + 1, collapsed, out);
  }

  const files = [...dir.files].sort((a, b) => baseName(a.path).localeCompare(baseName(b.path)));
  for (const f of files) {
    out.push({ kind: "file", path: f.path, depth, file: f });
  }
}

/** Flatten files into render rows for the given view mode and collapse state. */
export function flatten(
  files: FileTreeEntry[],
  viewMode: ViewMode,
  collapsed: ReadonlySet<string>,
): Row[] {
  if (viewMode === "flat") {
    return [...files]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((file) => ({ kind: "file", path: file.path, depth: 0, file }) as FileRow);
  }
  const root = buildDirTree(files);
  const out: Row[] = [];
  emitChildren(root, "", 0, collapsed, out);
  return out;
}
