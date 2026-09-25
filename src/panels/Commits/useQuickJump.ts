// Type-to-jump quick search (GitExtensions-style) and list keyboard
// navigation: with the list focused, typing jumps the selection to the next
// loaded row whose subject or ref label matches; Alt+Down/Up steps through
// matches (also after the typing buffer expired - the last query persists),
// Esc dismisses. Plain arrows move the selection like a native list (details
// follow, as on a click); Shift+arrows extend/shrink a bulk range. Purely
// client-side over the loaded rows; the toolbar filter covers full history.

import { useCallback, useRef, useState, type MutableRefObject } from "react";
import type { Virtualizer } from "@tanstack/react-virtual";
import type { Commit, CommitId } from "../../lib/types";
import { useLayer } from "../../store/layers";
import { quickSearchMatch } from "./commitSearch";
import { shouldCenterScroll } from "./scrollToRow";
import { arrowSelection, type SelectionState } from "./multiSelect";

type RowVirtualizer = Virtualizer<HTMLDivElement, Element>;

export function useQuickJump(args: {
  rowsRef: MutableRefObject<readonly Commit[]>;
  virtualizerRef: MutableRefObject<RowVirtualizer>;
  selectionRef: MutableRefObject<SelectionState>;
  selectedId: CommitId | null;
  selectSingle: (id: CommitId) => void;
  applySelection: (selection: SelectionState) => void;
  isMultiSelectable: (id: CommitId) => boolean;
  summonForRow: (commit: Commit) => void;
}) {
  const {
    rowsRef,
    virtualizerRef,
    selectionRef,
    selectedId,
    selectSingle,
    applySelection,
    isMultiSelectable,
    summonForRow,
  } = args;

  const quickBufferRef = useRef("");
  const lastQuickQueryRef = useRef("");
  const quickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [quickOverlay, setQuickOverlay] = useState<string | null>(null);
  const clearQuickJump = useCallback(() => {
    quickBufferRef.current = "";
    lastQuickQueryRef.current = "";
    if (quickTimerRef.current) clearTimeout(quickTimerRef.current);
    setQuickOverlay(null);
  }, []);
  // While visible the overlay is a popover layer: the key dispatcher pops it
  // on Escape (topmost layer first), so dismissing it can never also exit a
  // maximized panel.
  useLayer(quickOverlay !== null, "popover", clearQuickJump);

  const showQuickOverlay = (text: string) => {
    setQuickOverlay(text);
    if (quickTimerRef.current) clearTimeout(quickTimerRef.current);
    quickTimerRef.current = setTimeout(() => {
      quickBufferRef.current = "";
      setQuickOverlay(null);
    }, 1200);
  };

  const quickJump = (anchor: number, direction: 1 | -1, query: string) => {
    const idx = quickSearchMatch(rowsRef.current, query, anchor, direction);
    if (idx === null) return;
    selectSingle(rowsRef.current[idx].id);
    if (shouldCenterScroll(idx, virtualizerRef.current.range)) {
      virtualizerRef.current.scrollToIndex(idx, { align: "center" });
    }
  };

  const handleQuickSearchKey = (e: React.KeyboardEvent) => {
    // Never intercept typing meant for an inline editor or the toolbar.
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable=true]")) return;
    const selectedIdx = rowsRef.current.findIndex((c) => c.id === selectedId);

    if (e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp") && lastQuickQueryRef.current) {
      e.preventDefault();
      const dir = e.key === "ArrowDown" ? 1 : -1;
      quickJump(selectedIdx + dir, dir, lastQuickQueryRef.current);
      showQuickOverlay(lastQuickQueryRef.current);
      return;
    }
    // Plain arrows move the selection like a native list (details follow, as
    // on a click); Shift+arrows extend/shrink a bulk range (no summon, like
    // modifier clicks). Alt+arrows above (quick-jump repeat) win when a
    // quick-jump query is live.
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      const delta = e.key === "ArrowDown" ? 1 : -1;
      const moved = arrowSelection(
        selectionRef.current,
        rowsRef.current.map((r) => r.id),
        delta,
        e.shiftKey,
        isMultiSelectable,
      );
      if (!moved) return;
      applySelection(moved.selection);
      const idx = rowsRef.current.findIndex((r) => r.id === moved.cursorId);
      if (idx >= 0) {
        virtualizerRef.current.scrollToIndex(idx);
        if (!e.shiftKey) summonForRow(rowsRef.current[idx]);
      }
      return;
    }
    if (e.key === "Escape") {
      // A visible overlay is popped by the key dispatcher before this handler
      // ever sees Escape; reached only to clear the invisible leftover query,
      // which must not swallow anyone's Esc.
      clearQuickJump();
      return;
    }
    if (e.key === "Backspace" && quickBufferRef.current) {
      e.preventDefault();
      const next = quickBufferRef.current.slice(0, -1);
      quickBufferRef.current = next;
      lastQuickQueryRef.current = next;
      if (next) {
        quickJump(Math.max(selectedIdx, 0), 1, next);
        showQuickOverlay(next);
      } else {
        setQuickOverlay(null);
      }
      return;
    }
    if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    const next = quickBufferRef.current + e.key;
    quickBufferRef.current = next;
    lastQuickQueryRef.current = next;
    // Anchor inclusively on the current row so refining the query stays put.
    quickJump(Math.max(selectedIdx, 0), 1, next);
    showQuickOverlay(next);
  };

  return { quickOverlay, handleQuickSearchKey };
}
