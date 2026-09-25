import { useEffect } from "react";
import { create } from "zustand";
import type { DockviewApi } from "dockview-react";
import { useDockviewStore } from "./dockview";
import { useSettingsStore } from "./settings";
import { useRepoStore } from "./repos";
import { notify } from "./notifications";
import { api as commandApi } from "../lib/commands";
import { formatAppError } from "../lib/errors";
import type { FileHistoryRequest } from "../lib/types";
import { REPO_PANELS, SUPPRESSIBLE_SUMMON_PANELS } from "../layout/descriptors";

/**
 * True when the user has opted this panel out of auto-opening (Settings →
 * "Auto-open panels"). A `summon`/`swapSummon` to a suppressed panel degrades
 * to `notifyIfOpen`: it updates the panel only if it's already open, never
 * creates or focuses it. Read lazily (getState) so it always reflects the
 * current setting. SUPPRESSIBLE_SUMMON_PANELS is the authority: a stored id
 * no longer on that list (e.g. interactive-rebase, summon-only since
 * 2026-08-19) is inert - otherwise a stale settings entry could suppress a
 * panel that no longer offers the toggle to undo it.
 */
function isSuppressed(panelId: string): boolean {
  return (
    SUPPRESSIBLE_SUMMON_PANELS.includes(panelId) &&
    (useSettingsStore.getState().settings?.suppressed_auto_open_panels?.includes(panelId) ?? false)
  );
}

/**
 * The file-inspection panels. When one of these opens with no remembered
 * placement, it lands in an already-open companion's group (so the three share
 * one tabbed group); if none are open, the placement walk starts from Diff's
 * default reference so all three gravitate to one spot. A panel the user has
 * deliberately moved keeps its spot (that memory is honoured before this).
 */
const FILE_INSPECTION_GROUP = ["diff", "file-view", "blame"];

/** Where a summoned (closed) panel goes. A summon NEVER splits the layout:
 *  every outcome joins an existing group as a tab — splitting is reserved for
 *  building the default layout. */
export type SummonPlacement =
  | { kind: "group"; groupId: string }
  /** Join this open panel's group. */
  | { kind: "join"; panelId: string }
  /** Nothing resolvable — add to the active group (dockview default). */
  | { kind: "default" };

/**
 * Placement cascade for a summoned panel, in priority order: the remembered
 * group while it still exists; the fallback reference's group (the remembered
 * group was destroyed); an open file-inspection companion's group; the
 * defaultPlacement reference's group, walking closed references transitively
 * (they chain toward `log`, which is always open) — for a file-inspection
 * panel with no companion the walk starts at diff's reference so all three
 * land in one spot; else the active group. Pure: the api-facing `summon`
 * resolves the outcome against dockview.
 */
export function resolveSummonPlacement(
  targetId: string,
  placements: Record<string, string>,
  fallbacks: Record<string, FallbackPosition>,
  isPanelOpen: (panelId: string) => boolean,
  groupExists: (groupId: string) => boolean,
): SummonPlacement {
  const savedGroupId = placements[targetId];
  if (savedGroupId !== undefined && groupExists(savedGroupId)) {
    return { kind: "group", groupId: savedGroupId };
  }

  const fallback = fallbacks[targetId];
  if (fallback && isPanelOpen(fallback.referencePanel)) {
    return { kind: "join", panelId: fallback.referencePanel };
  }

  const isInspection = FILE_INSPECTION_GROUP.includes(targetId);
  if (isInspection) {
    const companion = FILE_INSPECTION_GROUP.find((id) => id !== targetId && isPanelOpen(id));
    if (companion) return { kind: "join", panelId: companion };
  }

  // Transitive defaultPlacement walk (visited set guards against a future
  // reference cycle in the descriptors).
  const referenceOf = (id: string): string | undefined =>
    REPO_PANELS.find((p) => p.id === id)?.defaultPlacement?.referencePanel;
  const visited = new Set<string>();
  let ref = referenceOf(isInspection ? "diff" : targetId);
  while (ref !== undefined && !visited.has(ref)) {
    if (isPanelOpen(ref)) return { kind: "join", panelId: ref };
    visited.add(ref);
    ref = referenceOf(ref);
  }

  return { kind: "default" };
}

/**
 * Add a currently-closed repo panel, joining an existing group per
 * `resolveSummonPlacement` (a summon or menu open NEVER splits the layout),
 * then unhide the group it landed in — the console group starts collapsed
 * (`setVisible(false)`), and a panel added to a hidden group would open
 * invisibly. The single "open a closed panel" primitive behind `summon()`
 * and the View menu's `openRepoPanel`.
 */
export function addRepoPanelWithoutSplitting(api: DockviewApi, targetId: string) {
  const desc = REPO_PANELS.find((p) => p.id === targetId);
  if (!desc) return;
  const { placements, fallbackPositions } = useSummonStore.getState();
  const placement = resolveSummonPlacement(
    targetId,
    placements,
    fallbackPositions,
    (panelId) => !!api.getPanel(panelId),
    (groupId) => api.groups.some((g) => g.id === groupId),
  );
  if (placement.kind === "group") {
    api.addPanel({
      id: targetId,
      component: targetId,
      title: desc.title,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      position: { referenceGroup: placement.groupId as any, direction: "within" },
    });
  } else if (placement.kind === "join") {
    api.addPanel({
      id: targetId,
      component: targetId,
      title: desc.title,
      position: { referencePanel: placement.panelId, direction: "within" },
    });
  } else {
    // Active group (dockview's default for a position-less add).
    api.addPanel({ id: targetId, component: targetId, title: desc.title });
  }
  const panel = api.getPanel(targetId);
  if (panel && !panel.group.api.isVisible) panel.group.api.setVisible(true);
}

/**
 * When the "file history in a separate window" setting is on, a file-history
 * summon that carries a file is routed to an OS window instead of the dock.
 * Null = keep the docked path (setting off, other panel, or no usable file).
 */
export function fileHistoryWindowRequest(
  targetId: string,
  payload: unknown,
  opensWindow: boolean,
): { path: string; rev: string | null } | null {
  if (targetId !== "file-history" || !opensWindow) return null;
  if (typeof payload === "string") return { path: payload, rev: null };
  if (payload && typeof payload === "object") {
    const p = payload as Partial<FileHistoryRequest>;
    if (typeof p.path === "string") {
      return { path: p.path, rev: typeof p.rev === "string" ? p.rev : null };
    }
  }
  return null;
}

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
   * Deliver `payload` to a panel ONLY if it is currently mounted — never opens
   * or queues. Used to push state into an already-open panel (e.g. clearing the
   * Diff panel when the file selection is reset) without summoning it into view.
   */
  notifyIfOpen: (targetId: string, payload?: unknown) => void;
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

  notifyIfOpen(targetId, payload) {
    const cb = get().callbacks[targetId];
    if (cb) cb(payload);
  },

  summon(targetId, payload) {
    const windowed = fileHistoryWindowRequest(
      targetId,
      payload,
      useSettingsStore.getState().settings?.file_history_opens_window ?? false,
    );
    if (windowed) {
      const repoId = useRepoStore.getState().activeRepoId;
      if (repoId) {
        void commandApi
          .openFileHistoryWindow(repoId, windowed.path, windowed.rev)
          .catch((e: unknown) => notify.error(formatAppError(e)));
      }
      return;
    }

    // Per-panel "don't auto-open" opt-out: degrade to a notify so the panel
    // updates only if already open and never pops into view.
    if (isSuppressed(targetId)) {
      get().notifyIfOpen(targetId, payload);
      return;
    }

    const api = useDockviewStore.getState().repoApi;
    if (!api) return;

    const desc = REPO_PANELS.find((p) => p.id === targetId);
    if (!desc) return;

    const { callbacks } = get();
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

    // Slot sharing: if this panel's swap sibling is open, take over its spot
    // instead of placing a second panel next to it (e.g. Diff <-> Merge).
    if (desc.swapsWith && api.getPanel(desc.swapsWith)) {
      get().swapSummon(targetId, desc.swapsWith, payload);
      return;
    }

    // Panel is not open — queue payload so it's ready when the panel mounts.
    if (payload !== undefined) {
      set((s) => ({ payloadQueue: { ...s.payloadQueue, [targetId]: payload } }));
    }

    // Case 2: closed panel — join an existing group (never split the layout;
    // see resolveSummonPlacement for the priority cascade).
    addRepoPanelWithoutSplitting(api, targetId);
  },

  swapSummon(showId, hideId, payload) {
    // Suppressed target: don't take over the slot or open it — just update it
    // if it's already open, and leave the sibling (`hideId`) untouched.
    if (isSuppressed(showId)) {
      get().notifyIfOpen(showId, payload);
      return;
    }

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
