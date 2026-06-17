import { useEffect } from "react";
import { create } from "zustand";
import { useDockviewStore } from "./dockview";
import { REPO_PANELS } from "../panels/registry";

type Callback = (payload: unknown) => void;

export interface FallbackPosition {
  referencePanel: string;
  direction: "left" | "right" | "above" | "below";
}

interface SummonStore {
  /** Last-known group ID for each panel that has been closed. */
  placements: Record<string, string>;
  /** Fallback position (near-sibling reference) for panels whose group may be destroyed. */
  fallbackPositions: Record<string, FallbackPosition>;
  /** Payload waiting for a panel that isn't mounted yet. */
  payloadQueue: Record<string, unknown>;
  /** Mounted panel callbacks, keyed by panel ID. */
  callbacks: Record<string, Callback>;

  registerTarget: (panelId: string, cb: Callback) => void;
  unregisterTarget: (panelId: string) => void;
  capturePlacement: (panelId: string, groupId: string) => void;
  captureFallback: (panelId: string, pos: FallbackPosition) => void;
  summon: (targetId: string, payload?: unknown) => void;
  /**
   * Show `showId` in place of `hideId`: if `showId` isn't open, it opens in the
   * hidden sibling's group (taking over its spot); then `hideId` is closed. Used
   * so Changed Files and Working Changes share one side-region slot, one at a time.
   */
  swapSummon: (showId: string, hideId: string, payload?: unknown) => void;
}

export const useSummonStore = create<SummonStore>((set, get) => ({
  placements: {},
  fallbackPositions: {},
  payloadQueue: {},
  callbacks: {},

  registerTarget(panelId, cb) {
    set((s) => ({ callbacks: { ...s.callbacks, [panelId]: cb } }));
    // Flush any payload that arrived before the panel was mounted.
    const queued = get().payloadQueue[panelId];
    if (queued !== undefined) {
      set((s) => {
        const next = { ...s.payloadQueue };
        delete next[panelId];
        return { payloadQueue: next };
      });
      cb(queued);
    }
  },

  unregisterTarget(panelId) {
    set((s) => {
      const next = { ...s.callbacks };
      delete next[panelId];
      return { callbacks: next };
    });
  },

  capturePlacement(panelId, groupId) {
    set((s) => ({ placements: { ...s.placements, [panelId]: groupId } }));
  },

  captureFallback(panelId, pos) {
    set((s) => ({ fallbackPositions: { ...s.fallbackPositions, [panelId]: pos } }));
  },

  summon(targetId, payload) {
    const api = useDockviewStore.getState().repoApi;
    if (!api) return;

    const desc = REPO_PANELS.find((p) => p.id === targetId);
    if (!desc) return;

    const { placements, fallbackPositions, callbacks } = get();
    const existing = api.getPanel(targetId);

    if (existing) {
      // Case 1: panel is already open — focus and deliver payload.
      existing.focus();
      if (payload !== undefined) {
        const cb = callbacks[targetId];
        if (cb) {
          cb(payload);
        } else {
          set((s) => ({ payloadQueue: { ...s.payloadQueue, [targetId]: payload } }));
        }
      }
      return;
    }

    // Panel is not open — queue payload so it's ready when the panel mounts.
    if (payload !== undefined) {
      set((s) => ({ payloadQueue: { ...s.payloadQueue, [targetId]: payload } }));
    }

    // Case 2a: panel was previously placed — restore to that group if it still exists.
    const savedGroupId = placements[targetId];
    if (savedGroupId && api.groups.some((g) => g.id === savedGroupId)) {
      api.addPanel({
        id: targetId,
        component: targetId,
        title: desc.title,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        position: { referenceGroup: savedGroupId as any, direction: "within" },
      });
      return;
    }

    // Case 2b: group was destroyed but we have a fallback position (near where the panel was).
    const fallback = fallbackPositions[targetId];
    if (fallback && api.getPanel(fallback.referencePanel)) {
      api.addPanel({
        id: targetId,
        component: targetId,
        title: desc.title,
        position: { referencePanel: fallback.referencePanel, direction: fallback.direction },
      });
      return;
    }

    // Case 3: first time or no usable position — use descriptor's default placement.
    if (desc.defaultPlacement) {
      const { direction, referencePanel } = desc.defaultPlacement;
      api.addPanel({
        id: targetId,
        component: targetId,
        title: desc.title,
        position: referencePanel ? { referencePanel, direction } : { direction },
      });
    } else {
      api.addPanel({ id: targetId, component: targetId, title: desc.title });
    }
  },

  swapSummon(showId, hideId, payload) {
    const api = useDockviewStore.getState().repoApi;
    if (!api) return;
    const desc = REPO_PANELS.find((p) => p.id === showId);
    if (!desc) return;

    const sibling = api.getPanel(hideId);
    const existing = api.getPanel(showId);

    if (existing) {
      existing.focus();
      if (payload !== undefined) {
        const cb = get().callbacks[showId];
        if (cb) cb(payload);
        else set((s) => ({ payloadQueue: { ...s.payloadQueue, [showId]: payload } }));
      }
    } else if (sibling?.group) {
      // Take over the sibling's group so the new panel lands in the same spot.
      // Queue the payload so it's delivered when the freshly-added panel mounts.
      if (payload !== undefined) {
        set((s) => ({ payloadQueue: { ...s.payloadQueue, [showId]: payload } }));
      }
      api.addPanel({
        id: showId,
        component: showId,
        title: desc.title,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        position: { referenceGroup: sibling.group.id as any, direction: "within" },
      });
    } else {
      // No sibling open — fall back to normal placement (memory / default).
      get().summon(showId, payload);
    }

    // Close the sibling so only one panel occupies the shared spot.
    sibling?.api.close();
  },
}));

/**
 * Hook for panels that receive payloads via the summon mechanism.
 * `onReceive` must be stable (wrap in useCallback at the call site).
 */
export function useSummonTarget<T>(panelId: string, onReceive: (payload: T) => void) {
  useEffect(() => {
    const { registerTarget, unregisterTarget } = useSummonStore.getState();
    registerTarget(panelId, onReceive as Callback);
    return () => unregisterTarget(panelId);
  }, [panelId, onReceive]);
}

/**
 * Given a dockview `toJSON()` snapshot and a group ID, find a reference panel
 * and direction that describes approximately where that group sits in the layout.
 * Returns null if the group is the only node or can't be found.
 */
export function computeFallbackPosition(
  layoutJson: unknown,
  groupId: string
): FallbackPosition | null {
  const json = layoutJson as any;
  const grid = json?.grid;
  if (!grid?.root) return null;
  return walkGrid(grid.root, grid.orientation as string, groupId);
}

function walkGrid(
  node: any,
  orientation: string,
  targetGroupId: string
): FallbackPosition | null {
  if (node.type === "leaf") return null;

  const children: any[] = node.data;
  for (let i = 0; i < children.length; i++) {
    if (!subtreeContainsGroup(children[i], targetGroupId)) continue;

    // Recurse first to get the most precise sibling (e.g. "right of log"
    // rather than the coarser "above console" found at a higher level).
    const next = orientation === "HORIZONTAL" ? "VERTICAL" : "HORIZONTAL";
    const deeper = walkGrid(children[i], next, targetGroupId);
    if (deeper) return deeper;

    // Target is a direct leaf of this branch — use an adjacent sibling.
    if (children.length > 1) {
      const siblingIdx = i === 0 ? 1 : i - 1;
      const refPanel = firstPanelInSubtree(children[siblingIdx]);
      if (refPanel) {
        const direction: FallbackPosition["direction"] =
          orientation === "HORIZONTAL"
            ? i < siblingIdx ? "left" : "right"
            : i < siblingIdx ? "above" : "below";
        return { referencePanel: refPanel, direction };
      }
    }

    return null;
  }
  return null;
}

function subtreeContainsGroup(node: any, groupId: string): boolean {
  if (node.type === "leaf") return node.data?.id === groupId;
  return (node.data as any[]).some((c: any) => subtreeContainsGroup(c, groupId));
}

function firstPanelInSubtree(node: any): string | null {
  if (node.type === "leaf") {
    const views = node.data?.views;
    return Array.isArray(views) && views.length > 0 ? views[0] : null;
  }
  for (const child of node.data as any[]) {
    const p = firstPanelInSubtree(child);
    if (p) return p;
  }
  return null;
}
