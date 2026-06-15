// Hook for column state (order / hidden / widths) with debounced persistence
// to `global-settings.json` via the `save_column_preferences` Tauri command.
//
// On mount we read `column_preferences` from the global settings, validate it,
// and fall back to defaults if missing or malformed. Subsequent state changes
// are debounced (500 ms) before persisting — fast resize drags still produce
// one final write.

import { useCallback, useEffect, useRef, useState } from "react";
import { getGlobalSettings, saveColumnPreferences } from "../../../lib/commands";
import {
  ALL_COLUMN_IDS,
  DEFAULT_HIDDEN,
  DEFAULT_ORDER,
  DEFAULT_WIDTHS,
} from "./types";
import type { ColumnId, ColumnPreferences, ColumnState } from "./types";

const PERSIST_DEBOUNCE_MS = 500;

function defaultState(): ColumnState {
  return {
    order: [...DEFAULT_ORDER],
    hidden: [...DEFAULT_HIDDEN],
    widths: { ...DEFAULT_WIDTHS },
  };
}

/**
 * Validate raw JSON from disk against our schema. Returns a ColumnState if the
 * input is a well-formed `legit-column-prefs` v1 document with all-known
 * ColumnId values; returns null otherwise (caller substitutes defaults).
 */
function parsePreferences(value: unknown): ColumnState | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  if (obj.format !== "legit-commits-columns") return null;
  if (obj.formatVersion !== 1) return null;

  const validId = (x: unknown): x is ColumnId =>
    typeof x === "string" && (ALL_COLUMN_IDS as readonly string[]).includes(x);

  const rawOrder = Array.isArray(obj.order) ? obj.order : null;
  const rawHidden = Array.isArray(obj.hidden) ? obj.hidden : null;
  const rawWidths =
    obj.widths && typeof obj.widths === "object" && !Array.isArray(obj.widths)
      ? (obj.widths as Record<string, unknown>)
      : null;

  if (!rawOrder || !rawHidden || !rawWidths) return null;

  // §I.1 forward-compat: filter out unknown ids (a newer version may have
  // added column ids this build doesn't know about) rather than rejecting
  // the whole document. Duplicates within a filtered array are still
  // rejected — they indicate corruption, not version skew.
  const order = (rawOrder as unknown[]).filter(validId);
  const hidden = (rawHidden as unknown[]).filter(validId);

  // Dedup check after filtering (valid ids only).
  const seenOrder = new Set(order);
  if (seenOrder.size !== order.length) return null;

  // Forward-compatible: if a future version drops a column, fill from defaults
  // so the user doesn't end up with an empty header row after downgrading.
  for (const id of DEFAULT_ORDER) {
    if (!seenOrder.has(id)) order.push(id);
  }

  // Keep only hidden ids that exist in the resolved order.
  const filteredHidden = hidden.filter((id) => order.includes(id));

  const widths: Partial<Record<ColumnId, number>> = {};
  for (const [k, v] of Object.entries(rawWidths)) {
    if (validId(k) && typeof v === "number" && Number.isFinite(v) && v > 0) {
      widths[k] = v;
    }
  }

  return { order, hidden: filteredHidden, widths };
}

export function useColumnState(): {
  state: ColumnState;
  setOrder: (order: ColumnId[]) => void;
  setHidden: (hidden: ColumnId[]) => void;
  setWidth: (colId: ColumnId, width: number) => void;
} {
  const [state, setState] = useState<ColumnState>(defaultState);
  // `initialLoadDone`: true once the async getGlobalSettings call completes.
  // `loadingFromDisk`: true for the one render triggered by the load's setState,
  //   so the persist effect skips writing data we just read from disk.
  const initialLoadDone = useRef(false);
  const loadingFromDisk = useRef(false);
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // One-shot read of the persisted preferences.
  useEffect(() => {
    let cancelled = false;
    getGlobalSettings()
      .then((settings) => {
        if (cancelled) return;
        const raw = (settings.column_preferences as Record<string, unknown> | null | undefined)
          ?.columnPreferences as Record<string, unknown> | undefined;
        const parsed = parsePreferences(raw?.commits ?? null);
        if (parsed) {
          loadingFromDisk.current = true;
          setState(parsed);
        }
        initialLoadDone.current = true;
      })
      .catch((e) => {
        console.warn("getGlobalSettings failed; using default columns", e);
        initialLoadDone.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Debounced write whenever the state changes after the initial load.
  useEffect(() => {
    if (!initialLoadDone.current) return;
    // Skip writing data we just read from disk (avoids a redundant round-trip).
    if (loadingFromDisk.current) { loadingFromDisk.current = false; return; }
    if (persistTimer.current) clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      const prefs: ColumnPreferences = {
        format: "legit-commits-columns",
        formatVersion: 1,
        order: state.order,
        hidden: state.hidden,
        widths: state.widths,
      };
      saveColumnPreferences({ columnPreferences: { commits: prefs } }).catch((e) =>
        console.warn("saveColumnPreferences failed", e)
      );
    }, PERSIST_DEBOUNCE_MS);
    return () => {
      if (persistTimer.current) clearTimeout(persistTimer.current);
    };
  }, [state]);

  const setOrder = useCallback(
    (order: ColumnId[]) => setState((s) => ({ ...s, order })),
    []
  );
  const setHidden = useCallback(
    (hidden: ColumnId[]) => setState((s) => ({ ...s, hidden })),
    []
  );
  const setWidth = useCallback(
    (colId: ColumnId, width: number) =>
      setState((s) => ({ ...s, widths: { ...s.widths, [colId]: width } })),
    []
  );

  return { state, setOrder, setHidden, setWidth };
}
