// Single column header cell: handles drag-to-reorder, edge-resize, and a
// right-click context menu for hide/show. One <ColumnHeader> renders per
// visible column.

import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { usePanelContextMenu } from "../menu/PanelContextMenu";
import { MenuItem, Separator, SectionLabel } from "../menu/primitives";
import { COLUMN_GAP, MIN_COLUMN_WIDTH } from "./types";
import type { ColumnId } from "./types";

interface ColumnHeaderProps {
  colId: ColumnId;
  /** Header content — text for most columns, an icon for the Signed column. */
  label: ReactNode;
  /** Current width as a CSS dimension string (px number or "1fr"). */
  width: string;
  isDraggable: boolean;
  isResizable: boolean;
  isHideable: boolean;
  /** Hidden columns — surfaced in the "Show columns" submenu. */
  hidden: ColumnId[];
  /** Map from ColumnId to its human-readable label. */
  labels: Record<ColumnId, string>;
  onReorder: (draggedId: ColumnId, targetId: ColumnId, side: "left" | "right") => void;
  onHide: (colId: ColumnId) => void;
  onShow: (colId: ColumnId) => void;
  /**
   * Called continuously during a resize drag *and* on pointerup with the
   * final width. The hook debounces disk writes (500 ms), so calling per
   * pointermove is cheap and keeps the grid live-updating.
   */
  onResizeEnd: (colId: ColumnId, width: number) => void;
  /**
   * Which edge of the header carries the resize handle, and therefore which
   * drag direction grows the column. Columns *left* of the elastic Subject
   * filler are anchored at their left edge — handle on the right, drag right
   * to grow. Columns *right* of the filler are anchored at their right edge
   * (growing them expands leftward into the filler), so the handle sits on
   * the left and dragging LEFT grows — otherwise the divider moves opposite
   * to the pointer and the resize feels reversed.
   */
  resizeEdge?: "left" | "right";
  /**
   * Draw a vertical separator on the cell's right edge — a visual hint that
   * the boundary is where columns are dragged to resize. Omitted on the last
   * visible column so there's no trailing line at the panel edge.
   */
  showSeparator?: boolean;
}

const DRAG_MIME = "application/x-legit-column-id";
const RESIZER_W = 4;

// Module-level flag so handleDragOver can reject non-column drags in Firefox
// (where dataTransfer.types is empty during dragover events).
let activeColumnDrag = false;

export function ColumnHeader({
  colId,
  label,
  width,
  isDraggable,
  isResizable,
  isHideable,
  hidden,
  labels,
  onReorder,
  onHide,
  onShow,
  onResizeEnd,
  resizeEdge = "right",
  showSeparator,
}: ColumnHeaderProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [dragOverSide, setDragOverSide] = useState<"left" | "right" | null>(null);
  const { openMenu } = usePanelContextMenu();

  // ------------------------------------------------------------------ drag
  const handleDragStart = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!isDraggable) return;
      e.dataTransfer.effectAllowed = "move";
      // Use both a custom MIME and "text/plain" — Firefox needs the latter
      // to actually start a drag in some configurations.
      e.dataTransfer.setData(DRAG_MIME, colId);
      e.dataTransfer.setData("text/plain", colId);
      activeColumnDrag = true;
    },
    [colId, isDraggable]
  );

  const handleDragEnd = useCallback(() => {
    activeColumnDrag = false;
  }, []);

  const handleDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      // Only accept column-header drags. The module-level flag guards Firefox
      // where dataTransfer.types is empty during dragover events — without it,
      // any external drag (files, text selection) would show a move cursor.
      if (!activeColumnDrag) return;
      const types = e.dataTransfer.types;
      if (
        types.length > 0 &&
        !Array.from(types).includes(DRAG_MIME) &&
        !Array.from(types).includes("text/plain")
      ) {
        return;
      }
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const rect = e.currentTarget.getBoundingClientRect();
      const side = e.clientX < rect.left + rect.width / 2 ? "left" : "right";
      setDragOverSide(side);
    },
    []
  );

  const handleDragLeave = useCallback(() => setDragOverSide(null), []);

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      const draggedId =
        (e.dataTransfer.getData(DRAG_MIME) as ColumnId) ||
        (e.dataTransfer.getData("text/plain") as ColumnId);
      setDragOverSide(null);
      if (!draggedId || draggedId === colId) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const side = e.clientX < rect.left + rect.width / 2 ? "left" : "right";
      onReorder(draggedId, colId, side);
    },
    [colId, onReorder]
  );

  // -------------------------------------------------------------- resize
  // We track the in-flight pointer state via refs to avoid React renders on
  // every pointermove. Final width is committed on pointerup via onResizeEnd.
  const resizing = useRef<{
    startX: number;
    startWidth: number;
    pointerId: number;
    handle: HTMLDivElement;
  } | null>(null);

  const handleResizePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!isResizable) return;
      // Initial width: measure the header itself so we capture whatever the
      // grid is currently rendering (handles "1fr" and px columns alike).
      const startWidth = wrapRef.current?.getBoundingClientRect().width ?? 0;
      const handle = e.currentTarget;
      try {
        handle.setPointerCapture(e.pointerId);
      } catch {
        // Element removed from DOM between pointerdown and capture — ignore.
      }
      resizing.current = {
        startX: e.clientX,
        startWidth,
        pointerId: e.pointerId,
        handle,
      };
      e.stopPropagation();
      e.preventDefault();
    },
    [isResizable]
  );

  // A handle on the left edge grows the column when dragged LEFT (the column
  // expands leftward, so the divider follows the pointer); on the right edge
  // it grows when dragged right.
  const resizeDir = resizeEdge === "left" ? -1 : 1;

  const handleResizePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const st = resizing.current;
      if (!st || e.pointerId !== st.pointerId) return;
      const delta = (e.clientX - st.startX) * resizeDir;
      const next = Math.max(MIN_COLUMN_WIDTH, Math.round(st.startWidth + delta));
      // Propagate width up so the grid template re-flows live. The hook
      // debounces persistence (500 ms), so this is one cheap state update
      // per pointermove and at most one disk write per resize gesture.
      onResizeEnd(colId, next);
    },
    [colId, onResizeEnd, resizeDir]
  );

  const finishResize = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const st = resizing.current;
      if (!st || e.pointerId !== st.pointerId) return;
      try {
        st.handle.releasePointerCapture(st.pointerId);
      } catch {
        // Already released — ignore.
      }
      const delta = (e.clientX - st.startX) * resizeDir;
      const finalWidth = Math.max(
        MIN_COLUMN_WIDTH,
        Math.round(st.startWidth + delta)
      );
      resizing.current = null;
      onResizeEnd(colId, finalWidth);
    },
    [colId, onResizeEnd, resizeDir]
  );

  // -------------------------------------------------------------- context menu
  // The column's hide/show entries are this header's contextual section in the
  // unified panel menu (the provider appends the baseline below them).
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      openMenu(
        e,
        <ColumnMenuSection
          colId={colId}
          isHideable={isHideable}
          hidden={hidden}
          labels={labels}
          onHide={onHide}
          onShow={onShow}
        />,
      );
    },
    [openMenu, colId, isHideable, hidden, labels, onHide, onShow],
  );

  // -------------------------------------------------------------- render
  // Border highlight for drop targets.
  const dropBorder = useMemo<React.CSSProperties>(() => {
    if (dragOverSide === "left") {
      return { boxShadow: "inset 2px 0 0 0 var(--accent, #4a9eff)" };
    }
    if (dragOverSide === "right") {
      return { boxShadow: "inset -2px 0 0 0 var(--accent, #4a9eff)" };
    }
    return {};
  }, [dragOverSide]);

  return (
    <div
      ref={wrapRef}
      draggable={isDraggable}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onContextMenu={handleContextMenu}
      style={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        // Visible so a left-edge resize handle can reach across the grid gap
        // to the previous column's separator line. The label truncates itself
        // (its own overflow/ellipsis), so nothing else can spill out.
        overflow: "visible",
        cursor: isDraggable ? "grab" : "default",
        userSelect: "none",
        // The width is controlled via the grid template — this is just a hint
        // for layout debugging.
        minWidth: 0,
        height: "100%",
        // Same line properties as the header's top/bottom rules.
        borderRight: showSeparator
          ? "1px solid var(--panel-border, rgba(255,255,255,0.10))"
          : undefined,
        ...dropBorder,
      }}
      data-col-id={colId}
      data-col-width={width}
    >
      <span
        style={{
          fontSize: "var(--fz-sm)",
          fontWeight: 600,
          color: "var(--subtle-fg)",
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          flex: 1,
        }}
      >
        {label}
      </span>

      {isResizable && (
        <div
          onPointerDown={handleResizePointerDown}
          onPointerMove={handleResizePointerMove}
          onPointerUp={finishResize}
          onPointerCancel={finishResize}
          // Don't initiate header drag from the resize handle.
          onDragStart={(e) => e.preventDefault()}
          style={{
            position: "absolute",
            // The handle sits on the divider that actually moves when this
            // column resizes (see `resizeEdge`). The separator line is the
            // *previous* cell's right border, one grid gap to the left of
            // this cell — a left-edge handle spans that gap so it lies on
            // the visible "|", not floating next to it.
            left: resizeEdge === "left" ? -(COLUMN_GAP + 1) : undefined,
            right: resizeEdge === "right" ? 0 : undefined,
            top: 0,
            bottom: 0,
            width: resizeEdge === "left" ? COLUMN_GAP + RESIZER_W : RESIZER_W,
            cursor: "col-resize",
            zIndex: 1,
            // Subtle hover hint — not visible without :hover, but keeps the
            // handle discoverable on mouseover via the cursor change.
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Contextual menu section for a column header: hide this column / show hidden
// columns. Rendered inside the unified PanelContextMenu, which supplies the
// shell and appends the baseline entries below.
// ---------------------------------------------------------------------------

function ColumnMenuSection({
  colId,
  isHideable,
  hidden,
  labels,
  onHide,
  onShow,
}: {
  colId: ColumnId;
  isHideable: boolean;
  hidden: ColumnId[];
  labels: Record<ColumnId, string>;
  onHide: (id: ColumnId) => void;
  onShow: (id: ColumnId) => void;
}) {
  const { closeMenu } = usePanelContextMenu();

  const handleHide = () => {
    onHide(colId);
    closeMenu();
  };
  const handleShow = (id: ColumnId) => {
    onShow(id);
    closeMenu();
  };

  return (
    <>
      {isHideable && <MenuItem onClick={handleHide}>Hide this column</MenuItem>}

      {hidden.length > 0 && (
        <>
          {isHideable && <Separator />}
          <SectionLabel>Show columns:</SectionLabel>
          {hidden.map((id) => (
            <MenuItem key={id} onClick={() => handleShow(id)}>
              {`Show ${labels[id]}`}
            </MenuItem>
          ))}
        </>
      )}

      {!isHideable && hidden.length === 0 && (
        <SectionLabel>No column actions available</SectionLabel>
      )}
    </>
  );
}
