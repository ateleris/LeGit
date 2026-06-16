// Reusable, presentational changed-files view: a virtualized directory tree
// (single-child chains compressed) or flat list, with status badges, rename
// info, and +/- line counts. No data fetching — fed a CommitFileChange[].
//
// Designed for reuse: the future staging/commit panel will compose two of
// these (Staged / Unstaged).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowRightLeft,
  ChevronDown,
  ChevronRight,
  Copy,
  FileQuestion,
  GitFork,
  Pencil,
  Plus,
  TriangleAlert,
  Trash2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { CommitFileChange, FileState } from "../../../lib/types";
import { baseName, flatten, type Row, type ViewMode } from "./buildTree";

interface FileTreeProps {
  files: CommitFileChange[];
  viewMode: ViewMode;
  selectedPath: string | null;
  onSelect: (file: CommitFileChange) => void;
  /** Row height in px. */
  rowHeight?: number;
}

const ROW_HEIGHT_DEFAULT = 22;

/** Hover tooltip for a file row: the path, plus the rename source when present. */
function fileTitle(file: CommitFileChange): string {
  return file.old_path ? `${file.path}\n(renamed from ${file.old_path})` : file.path;
}

// Icon per change kind (lucide): + added, pencil modified, trash deleted,
// swap-arrows renamed, copy copied.
const STATUS_META: Record<FileState, { Icon: LucideIcon; color: string }> = {
  Added: { Icon: Plus, color: "var(--status-added)" },
  Modified: { Icon: Pencil, color: "var(--status-modified)" },
  Deleted: { Icon: Trash2, color: "var(--status-deleted)" },
  Renamed: { Icon: ArrowRightLeft, color: "var(--status-renamed)" },
  Copied: { Icon: Copy, color: "var(--status-copied)" },
  Conflicted: { Icon: TriangleAlert, color: "var(--status-conflicted)" },
  Untracked: { Icon: FileQuestion, color: "var(--subtle-fg)" },
  Ignored: { Icon: FileQuestion, color: "var(--subtle-fg)" },
  SubmoduleChanged: { Icon: GitFork, color: "var(--subtle-fg)" },
};

export function FileTree({
  files,
  viewMode,
  selectedPath,
  onSelect,
  rowHeight = ROW_HEIGHT_DEFAULT,
}: FileTreeProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [focusedIndex, setFocusedIndex] = useState(0);
  const parentRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(
    () => flatten(files, viewMode, collapsed),
    [files, viewMode, collapsed],
  );

  // Keep focus in range when the row set shrinks (collapse, view switch).
  useEffect(() => {
    setFocusedIndex((i) => Math.min(i, Math.max(0, rows.length - 1)));
  }, [rows.length]);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
  });

  useEffect(() => {
    rowVirtualizer.measure();
  }, [rowHeight, rowVirtualizer]);

  const toggleDir = useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const activateRow = useCallback(
    (row: Row) => {
      if (row.kind === "dir") toggleDir(row.path);
      else onSelect(row.file);
    },
    [toggleDir, onSelect],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (rows.length === 0) return;
      const row = rows[focusedIndex];
      const move = (idx: number) => {
        const clamped = Math.max(0, Math.min(rows.length - 1, idx));
        setFocusedIndex(clamped);
        rowVirtualizer.scrollToIndex(clamped);
      };
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          move(focusedIndex + 1);
          break;
        case "ArrowUp":
          e.preventDefault();
          move(focusedIndex - 1);
          break;
        case "ArrowRight":
          e.preventDefault();
          if (row?.kind === "dir" && row.collapsed) toggleDir(row.path);
          else move(focusedIndex + 1);
          break;
        case "ArrowLeft":
          e.preventDefault();
          if (row?.kind === "dir" && !row.collapsed) toggleDir(row.path);
          else move(focusedIndex - 1);
          break;
        case "Enter":
        case " ":
          e.preventDefault();
          if (row) activateRow(row);
          break;
      }
    },
    [rows, focusedIndex, rowVirtualizer, toggleDir, activateRow],
  );

  return (
    <div
      ref={parentRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      style={{ flex: 1, minHeight: 0, overflow: "auto", outline: "none", position: "relative" }}
    >
      <div style={{ height: rowVirtualizer.getTotalSize(), width: "100%", position: "relative" }}>
        {rowVirtualizer.getVirtualItems().map((vItem) => {
          const row = rows[vItem.index];
          const isFocused = vItem.index === focusedIndex;
          const isSelected = row.kind === "file" && row.path === selectedPath;
          return (
            <div
              key={vItem.key}
              data-index={vItem.index}
              onClick={() => {
                setFocusedIndex(vItem.index);
                activateRow(row);
              }}
              title={row.kind === "file" ? fileTitle(row.file) : row.label}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: rowHeight,
                transform: `translateY(${vItem.start}px)`,
                display: "flex",
                alignItems: "center",
                gap: 6,
                paddingLeft: 8 + row.depth * 14,
                paddingRight: 8,
                cursor: "pointer",
                fontSize: 12,
                whiteSpace: "nowrap",
                background: isSelected
                  ? "var(--graph-row-selected-bg, rgba(255,255,255,0.10))"
                  : isFocused
                  ? "var(--graph-row-selected-bg, rgba(255,255,255,0.04))"
                  : "transparent",
              }}
            >
              {row.kind === "dir" ? (
                <DirRowView label={row.label} fileCount={row.fileCount} collapsed={row.collapsed} />
              ) : (
                <FileRowView file={row.file} viewMode={viewMode} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DirRowView({
  label,
  fileCount,
  collapsed,
}: {
  label: string;
  fileCount: number;
  collapsed: boolean;
}) {
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  return (
    <>
      <Chevron size={14} style={{ flexShrink: 0, color: "var(--subtle-fg)" }} aria-hidden />
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {label}
      </span>
      <span className="legit-subtle" style={{ flexShrink: 0, paddingLeft: 6, fontSize: 11 }}>
        {fileCount}
      </span>
    </>
  );
}

function FileRowView({ file, viewMode }: { file: CommitFileChange; viewMode: ViewMode }) {
  const meta = STATUS_META[file.change];
  const Icon = meta.Icon;
  const name = baseName(file.path);
  const dir = file.path.slice(0, file.path.length - name.length);

  return (
    <>
      <span
        aria-label={file.change}
        title={file.change}
        style={{ flexShrink: 0, width: 14, display: "flex", justifyContent: "center" }}
      >
        <Icon size={14} color={meta.color} />
      </span>

      {viewMode === "flat" ? (
        // Always show the full filename; truncate the directory prefix from its
        // end so the row reads "start/of/path…filename" when space is tight.
        <span style={{ display: "flex", flex: 1, minWidth: 0, alignItems: "center", whiteSpace: "nowrap" }}>
          {dir && (
            <span
              className="legit-subtle"
              style={{
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {dir}
            </span>
          )}
          <span style={{ flexShrink: 0 }}>{name}</span>
        </span>
      ) : (
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {name}
          {file.old_path && (
            <span className="legit-subtle" style={{ marginLeft: 6, fontSize: 11 }}>
              ← {baseName(file.old_path)}
            </span>
          )}
        </span>
      )}

      <span
        style={{
          marginLeft: "auto",
          flexShrink: 0,
          fontFamily: "monospace",
          fontSize: 11,
        }}
      >
        {file.binary ? (
          <span className="legit-subtle">bin</span>
        ) : (
          <>
            {file.additions > 0 && (
              <span style={{ color: "var(--status-added)" }}>+{file.additions}</span>
            )}
            {file.additions > 0 && file.deletions > 0 && " "}
            {file.deletions > 0 && (
              <span style={{ color: "var(--status-deleted)" }}>−{file.deletions}</span>
            )}
          </>
        )}
      </span>
    </>
  );
}
