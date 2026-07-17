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
  File,
  FileQuestion,
  GitFork,
  Pencil,
  Plus,
  TriangleAlert,
  Trash2,
} from "lucide-react";
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import type { FileState } from "../../../lib/types";
import { useRestoreVirtualizerScroll } from "../../PanelApiContext";
import { baseName, flatten, type FileTreeEntry, type Row, type ViewMode } from "./buildTree";

interface FileTreeProps {
  files: FileTreeEntry[];
  viewMode: ViewMode;
  selectedPath: string | null;
  /** Optional — clicking a file row selects it (e.g. to open a diff). */
  onSelect?: (file: FileTreeEntry) => void;
  /**
   * Opt into Ctrl/Cmd + Shift multi-select. When enabled, `selectedPaths` drives
   * highlighting and `onSelectionChange` reports the full new set; `selectedPath`/
   * `onSelect` are ignored. Default false keeps the single-select behaviour.
   */
  multiSelect?: boolean;
  /** Highlighted set in multi-select mode. */
  selectedPaths?: ReadonlySet<string>;
  /** Reports the full new selection (multi-select mode only). */
  onSelectionChange?: (paths: string[]) => void;
  /** Optional per-file action buttons, revealed on row hover/focus (right edge). */
  renderActions?: (file: FileTreeEntry) => ReactNode;
  /**
   * Optional always-visible badge for a file row, rendered directly after
   * the filename (left-aligned; unlike `renderActions`, which is hover-only
   * at the right edge). Working Changes uses it for line-ending chips.
   */
  renderBadge?: (file: FileTreeEntry) => ReactNode;
  /**
   * Optional override for the leading status icon of a file row. When omitted,
   * the icon is derived from `file.change` (or a neutral file icon when the
   * entry has no change). The Files tree uses this to icon by tracked/
   * untracked/ignored rather than by change status.
   */
  renderFileIcon?: (file: FileTreeEntry) => ReactNode;
  /**
   * Optional per-folder action buttons (tree view), revealed on row hover.
   * Receives every file path under the folder, for bulk stage/unstage.
   */
  renderDirActions?: (filePaths: string[], dirPath: string) => ReactNode;
  /** Optional right-click handler for a file row (e.g. a context menu). */
  onContextMenu?: (file: FileTreeEntry, event: React.MouseEvent) => void;
  /**
   * Optional right-click handler for a folder row (tree view). Receives every
   * file path under the folder, for bulk stage/unstage/discard.
   */
  onDirContextMenu?: (filePaths: string[], dirPath: string, event: React.MouseEvent) => void;
  /** Row height in px. */
  rowHeight?: number;
  /** Status/chevron icon size in px. */
  iconSize?: number;
}

const ROW_HEIGHT_DEFAULT = 22;
const ICON_SIZE_DEFAULT = 14;

/** Hover tooltip for a file row: the path, plus the rename source when present. */
function fileTitle(file: FileTreeEntry): string {
  return file.old_path ? `${file.path}\n(renamed from ${file.old_path})` : file.path;
}

/** Icon/colour for a plain file with no change status (Files-tree tracked file). */
const PLAIN_FILE_META = { Icon: File, color: "var(--subtle-fg)" } as const;

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
  SubmoduleDirty: { Icon: GitFork, color: "var(--status-modified)" },
};

export function FileTree({
  files,
  viewMode,
  selectedPath,
  onSelect,
  multiSelect = false,
  selectedPaths,
  onSelectionChange,
  renderActions,
  renderBadge,
  renderFileIcon,
  renderDirActions,
  onContextMenu,
  onDirContextMenu,
  rowHeight = ROW_HEIGHT_DEFAULT,
  iconSize = ICON_SIZE_DEFAULT,
}: FileTreeProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  // Keyboard cursor tracked by row path, not index: staging/unstaging mutates
  // the row set, and a stale numeric index would point at whatever file slid
  // into that slot — lighting up a second, wrong row. A path that's no longer
  // present simply resolves to -1 (no cursor) until the user moves again.
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  // The keyboard-focus tint shows only while this tree actually holds focus, so
  // a panel with multiple trees never shows a focused row in more than one.
  const [hasFocus, setHasFocus] = useState(false);
  // Anchor for Shift-range selection (multi-select mode): the last file picked
  // without Shift. Held in a ref since it never needs to trigger a re-render.
  const anchorRef = useRef<string | null>(null);
  const parentRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(
    () => flatten(files, viewMode, collapsed),
    [files, viewMode, collapsed],
  );

  const focusedIndex = useMemo(
    () => (focusedPath == null ? -1 : rows.findIndex((r) => r.path === focusedPath)),
    [rows, focusedPath],
  );

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
  });

  useEffect(() => {
    rowVirtualizer.measure();
  }, [rowHeight, rowVirtualizer]);

  // Restore scroll (and re-render) when the containing panel is tab-shown again.
  useRestoreVirtualizerScroll(rowVirtualizer, parentRef);

  const toggleDir = useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  // Multi-select click resolution. Reduces to single-select when no modifier is
  // held. Shift extends the visible range from the anchor (folders in the span
  // are skipped — only files are selectable); Ctrl/Cmd toggles one file.
  const selectFile = useCallback(
    (path: string, mods: { toggle: boolean; range: boolean }) => {
      if (mods.range) {
        const anchor = anchorRef.current ?? path;
        const a = rows.findIndex((r) => r.path === anchor);
        const b = rows.findIndex((r) => r.path === path);
        if (a < 0 || b < 0) {
          anchorRef.current = path;
          onSelectionChange?.([path]);
          return;
        }
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        const range = rows
          .slice(lo, hi + 1)
          .filter((r) => r.kind === "file")
          .map((r) => r.path);
        onSelectionChange?.(range);
        return;
      }
      anchorRef.current = path;
      if (mods.toggle) {
        const next = new Set(selectedPaths ?? []);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        onSelectionChange?.([...next]);
        return;
      }
      onSelectionChange?.([path]);
    },
    [rows, selectedPaths, onSelectionChange],
  );

  const activateRow = useCallback(
    (row: Row) => {
      if (row.kind === "dir") toggleDir(row.path);
      else if (multiSelect) selectFile(row.file.path, { toggle: false, range: false });
      else onSelect?.(row.file);
    },
    [toggleDir, multiSelect, selectFile, onSelect],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (rows.length === 0) return;
      const row = focusedIndex >= 0 ? rows[focusedIndex] : undefined;
      // With no cursor yet (-1), the first key lands on row 0; otherwise step
      // from the current row. Cursor is stored by path so it survives mutation.
      const from = focusedIndex < 0 ? -1 : focusedIndex;
      const move = (idx: number) => {
        const clamped = Math.max(0, Math.min(rows.length - 1, idx));
        setFocusedPath(rows[clamped]?.path ?? null);
        rowVirtualizer.scrollToIndex(clamped);
      };
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          move(from + 1);
          break;
        case "ArrowUp":
          e.preventDefault();
          move(from - 1);
          break;
        case "ArrowRight":
          e.preventDefault();
          if (row?.kind === "dir" && row.collapsed) toggleDir(row.path);
          else move(from + 1);
          break;
        case "ArrowLeft":
          e.preventDefault();
          if (row?.kind === "dir" && !row.collapsed) toggleDir(row.path);
          else move(from - 1);
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
      onFocus={() => setHasFocus(true)}
      onBlur={() => setHasFocus(false)}
      style={{ flex: 1, minHeight: 0, overflow: "auto", outline: "none", position: "relative", userSelect: "none" }}
    >
      <div style={{ height: rowVirtualizer.getTotalSize(), width: "100%", position: "relative" }}>
        {rowVirtualizer.getVirtualItems().map((vItem) => {
          const row = rows[vItem.index];
          // Focus tint only while this tree holds focus; actions appear on hover
          // or on the focused row — both must clear when focus/hover moves away
          // (incl. to the other tree in a multi-tree panel).
          // Folders aren't selectable, so they never get the selection/focus
          // tint — only file rows do.
          const isFocused = hasFocus && row.kind === "file" && row.path === focusedPath;
          const isHovered = vItem.index === hoveredIndex;
          const isSelected =
            row.kind === "file" &&
            (multiSelect ? !!selectedPaths?.has(row.path) : row.path === selectedPath);
          return (
            <div
              key={vItem.key}
              data-index={vItem.index}
              data-testid={row.kind === "file" ? "file-row" : "dir-row"}
              data-path={row.path}
              // Activate on mousedown (not click) so selection switches atomically
              // with focus — otherwise the old selection lingers for a frame until
              // mouseup. Ignore non-primary buttons (right-click opens the menu).
              onMouseDown={(e) => {
                if (e.button !== 0) return;
                setFocusedPath(row.path);
                if (multiSelect && row.kind === "file") {
                  selectFile(row.path, {
                    toggle: e.ctrlKey || e.metaKey,
                    range: e.shiftKey,
                  });
                } else {
                  activateRow(row);
                }
              }}
              onMouseEnter={() => setHoveredIndex(vItem.index)}
              onMouseLeave={() => setHoveredIndex((i) => (i === vItem.index ? null : i))}
              onContextMenu={
                row.kind === "file"
                  ? onContextMenu
                    ? (e) => {
                        setFocusedPath(row.path);
                        // Right-click realigns the shift anchor, so a following
                        // Shift-click ranges from the row the menu acted on.
                        if (multiSelect) anchorRef.current = row.path;
                        onContextMenu(row.file, e);
                      }
                    : undefined
                  : onDirContextMenu
                  ? (e) =>
                      onDirContextMenu(
                        files.filter((f) => f.path.startsWith(`${row.path}/`)).map((f) => f.path),
                        row.path,
                        e,
                      )
                  : undefined
              }
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
                fontSize: "var(--fz-md)",
                whiteSpace: "nowrap",
                // Ignored files (Files tree) render dimmed to set them apart.
                opacity: row.kind === "file" && row.file.dimmed ? 0.55 : 1,
                background: isSelected
                  ? "var(--graph-row-selected-bg, rgba(255,255,255,0.10))"
                  : isFocused
                  ? "var(--graph-row-selected-bg, rgba(255,255,255,0.04))"
                  : "transparent",
              }}
            >
              {row.kind === "dir" ? (
                <DirRowView
                  label={row.label}
                  collapsed={row.collapsed}
                  iconSize={iconSize}
                  // Rendered always (so its width is reserved and the file-count
                  // badge never shifts), revealed only on hover.
                  actions={
                    renderDirActions
                      ? renderDirActions(
                          files.filter((f) => f.path.startsWith(`${row.path}/`)).map((f) => f.path),
                          row.path,
                        )
                      : null
                  }
                  actionsVisible={isHovered}
                />
              ) : (
                <FileRowView
                  file={row.file}
                  viewMode={viewMode}
                  iconSize={iconSize}
                  icon={renderFileIcon ? renderFileIcon(row.file) : null}
                  badge={renderBadge ? renderBadge(row.file) : null}
                  actions={renderActions && (isHovered || isFocused) ? renderActions(row.file) : null}
                />
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
  collapsed,
  iconSize,
  actions,
  actionsVisible,
}: {
  label: string;
  collapsed: boolean;
  iconSize: number;
  actions?: ReactNode;
  actionsVisible?: boolean;
}) {
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  return (
    <>
      <Chevron size={iconSize} style={{ flexShrink: 0, color: "var(--subtle-fg)" }} aria-hidden />
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {label}
      </span>
      {actions && (
        // Always mounted (width reserved so the count never shifts), only shown
        // on hover. Stop the click from toggling the folder when pressed;
        // preventDefault keeps the button from stealing DOM focus.
        <span
          onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onClick={(e) => e.stopPropagation()}
          style={{
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            gap: 2,
            paddingLeft: 4,
            visibility: actionsVisible ? "visible" : "hidden",
          }}
        >
          {actions}
        </span>
      )}
    </>
  );
}

/**
 * Wrapper for a row badge, sitting directly after the filename. A badge can
 * be interactive (the revert chip): stop the row's mousedown selection the
 * same way the hover actions do.
 */
function RowBadge({ children }: { children: ReactNode }) {
  return (
    <span
      onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onClick={(e) => e.stopPropagation()}
      style={{ marginLeft: 6, flexShrink: 0, display: "flex", alignItems: "center" }}
    >
      {children}
    </span>
  );
}

function FileRowView({
  file,
  viewMode,
  iconSize,
  icon,
  badge,
  actions,
}: {
  file: FileTreeEntry;
  viewMode: ViewMode;
  iconSize: number;
  /** Caller-supplied leading icon; falls back to the change-derived icon. */
  icon?: ReactNode;
  /** Always-visible badge directly after the filename. */
  badge?: ReactNode;
  actions?: ReactNode;
}) {
  const meta = file.change ? STATUS_META[file.change] : PLAIN_FILE_META;
  const Icon = meta.Icon;
  const statusLabel = file.change ?? "tracked";
  const name = baseName(file.path);
  const dir = file.path.slice(0, file.path.length - name.length);
  const additions = file.additions ?? 0;
  const deletions = file.deletions ?? 0;

  return (
    <>
      <span
        aria-label={statusLabel}
        title={statusLabel}
        style={{ flexShrink: 0, width: iconSize, display: "flex", justifyContent: "center" }}
      >
        {icon ?? <Icon size={iconSize} color={meta.color} />}
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
          {badge && <RowBadge>{badge}</RowBadge>}
        </span>
      ) : (
        <span style={{ display: "flex", flex: 1, minWidth: 0, alignItems: "center", whiteSpace: "nowrap" }}>
          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
            {name}
            {file.old_path && (
              <span className="legit-subtle" style={{ marginLeft: 6, fontSize: "var(--fz-sm)" }}>
                ← {baseName(file.old_path)}
              </span>
            )}
          </span>
          {badge && <RowBadge>{badge}</RowBadge>}
        </span>
      )}

      <span
        style={{
          marginLeft: "auto",
          flexShrink: 0,
          fontFamily: "monospace",
          fontSize: "var(--fz-sm)",
        }}
      >
        {file.binary ? (
          <span className="legit-subtle">bin</span>
        ) : (
          <>
            {additions > 0 && <span style={{ color: "var(--status-added)" }}>+{additions}</span>}
            {additions > 0 && deletions > 0 && " "}
            {deletions > 0 && <span style={{ color: "var(--status-deleted)" }}>−{deletions}</span>}
          </>
        )}
      </span>

      {actions && (
        // Stop row activation (select/diff, which fires on mousedown) from
        // triggering when an action button is pressed. preventDefault keeps the
        // button from taking DOM focus — otherwise, when the button unmounts
        // (e.g. a staged file leaves this list), the WebView restores focus to
        // the next tabbable element (the sibling tree), spuriously tinting a row
        // there. The onClick still fires, so the action runs.
        <span
          onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onClick={(e) => e.stopPropagation()}
          style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 2, paddingLeft: 4 }}
        >
          {actions}
        </span>
      )}
    </>
  );
}
