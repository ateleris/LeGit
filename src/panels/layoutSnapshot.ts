// Saved "default layout": the user snapshots the current window layout
// ("Save as default layout" in the View menu) and "Reset to default layout"
// restores it. Without a snapshot, reset falls back to the built-in
// first-launch layout. The snapshot reuses the docks' live-persistence
// formats verbatim (repo: envelope { dockview, placements, fallbacks };
// global: plain dockview JSON), applied through the same restore path the
// docks use on startup.

import type { DockviewApi } from "dockview-react";
import { applyPanelConstraints } from "../store/dockview";
import {
  computeFallbackPosition,
  useSummonStore,
  type FallbackPosition,
} from "../store/summon";
// Only the RepoLayoutEnvelope TYPE flows back into defaultLayouts - no
// runtime cycle.
import { DEFAULT_GLOBAL_LAYOUT, DEFAULT_REPO_LAYOUT } from "./defaultLayouts";
import { GLOBAL_DOCKVIEW_COMPONENTS, REPO_DOCKVIEW_COMPONENTS } from "./registry";

export const SAVED_REPO_LAYOUT_KEY = "legit.repo-dock-layout-default";
export const SAVED_GLOBAL_LAYOUT_KEY = "legit.global-dock-layout-default";

/** Persisted shape of the repo dock's layout (live key and saved default). */
export interface RepoLayoutEnvelope {
  dockview: unknown;
  placements: Record<string, string>;
  fallbacks: Record<string, FallbackPosition>;
}

/**
 * Parse a persisted repo-dock layout. Accepts the envelope format and, for
 * backward compatibility, a bare dockview layout (pre-envelope persistence).
 * Returns null for unparseable input - callers fall back to the default
 * layout, never throw.
 */
export function parseRepoLayoutEnvelope(raw: string | null): RepoLayoutEnvelope | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const envelope = parsed as {
    dockview?: unknown;
    placements?: unknown;
    fallbacks?: unknown;
  };

  const placements: Record<string, string> = {};
  if (envelope.placements && typeof envelope.placements === "object") {
    for (const [panelId, groupId] of Object.entries(envelope.placements)) {
      if (typeof groupId === "string") placements[panelId] = groupId;
    }
  }

  const fallbacks: Record<string, FallbackPosition> = {};
  if (envelope.fallbacks && typeof envelope.fallbacks === "object") {
    for (const [panelId, pos] of Object.entries(envelope.fallbacks)) {
      if (pos && typeof pos === "object" && "referencePanel" in (pos as object)) {
        fallbacks[panelId] = pos as FallbackPosition;
      }
    }
  }

  // Bare layouts (no `dockview` field) are the layout itself.
  return { dockview: envelope.dockview ?? parsed, placements, fallbacks };
}

/**
 * Strip panels whose component no longer exists from a persisted dockview
 * layout. A removed panel (e.g. the retired Search panel) would otherwise
 * make `fromJSON` throw AFTER building the restored panes' DOM - the exact
 * failure mode behind the old Refs pane-duplication bug - and nuke the whole
 * layout to the default. Returns the cleaned layout, or null when nothing
 * usable remains (callers fall back to the default). Pure so the pruning
 * rules are unit-tested.
 */
export function sanitizeDockviewLayout(
  json: unknown,
  knownComponents: ReadonlySet<string>,
): unknown | null {
  const layout = json as {
    grid?: { root?: unknown };
    panels?: Record<string, unknown>;
    activeGroup?: unknown;
  } | null;
  if (!layout || typeof layout !== "object" || !layout.grid || !layout.panels) return null;

  // Panels whose contentComponent still exists.
  const panels: Record<string, unknown> = {};
  for (const [id, p] of Object.entries(layout.panels)) {
    const component = (p as { contentComponent?: unknown } | null)?.contentComponent;
    if (typeof component === "string" && knownComponents.has(component)) panels[id] = p;
  }

  const groupIds = new Set<string>();
  const usedViews = new Set<string>();

  type Node = { type?: unknown; data?: unknown; size?: unknown };
  const sanitizeNode = (node: Node | null | undefined): Node | null => {
    if (!node || typeof node !== "object") return null;
    if (node.type === "leaf") {
      const data = (node.data ?? {}) as { views?: unknown; activeView?: unknown; id?: unknown };
      const views = (Array.isArray(data.views) ? data.views : []).filter(
        (v): v is string => typeof v === "string" && v in panels,
      );
      if (views.length === 0) return null;
      for (const v of views) usedViews.add(v);
      if (typeof data.id === "string") groupIds.add(data.id);
      const activeView =
        typeof data.activeView === "string" && views.includes(data.activeView)
          ? data.activeView
          : views[0];
      return { ...node, data: { ...data, views, activeView } };
    }
    if (node.type === "branch") {
      const children = (Array.isArray(node.data) ? node.data : [])
        .map((c) => sanitizeNode(c as Node))
        .filter((c): c is Node => c !== null);
      if (children.length === 0) return null;
      return { ...node, data: children };
    }
    return null;
  };

  const root = sanitizeNode((layout.grid as { root?: Node }).root);
  if (!root) return null;

  const result: Record<string, unknown> = {
    ...layout,
    grid: { ...(layout.grid as object), root },
    panels: Object.fromEntries(Object.entries(panels).filter(([id]) => usedViews.has(id))),
  };
  if (typeof layout.activeGroup === "string" && !groupIds.has(layout.activeGroup)) {
    delete result.activeGroup;
  }
  return result;
}

const REPO_COMPONENT_IDS: ReadonlySet<string> = new Set(Object.keys(REPO_DOCKVIEW_COMPONENTS));
const GLOBAL_COMPONENT_IDS: ReadonlySet<string> = new Set(Object.keys(GLOBAL_DOCKVIEW_COMPONENTS));

/**
 * Snapshot the current group ID and fallback position for every open panel
 * into the summon store (drives where closed panels re-open). Pass
 * `layoutJson` if you already called `api.toJSON()` to avoid a second call.
 */
export function capturePlacements(api: DockviewApi, layoutJson?: unknown) {
  const json = layoutJson ?? api.toJSON();
  const { capturePlacement, captureFallback } = useSummonStore.getState();
  for (const panel of api.panels) {
    const groupId = panel.group?.id;
    if (!groupId) continue;
    capturePlacement(panel.id, groupId);
    const fallback = computeFallbackPosition(json, groupId);
    if (fallback) captureFallback(panel.id, fallback);
  }
}

/** The repo dock's current layout in its persisted envelope shape. */
export function captureRepoLayoutEnvelope(api: DockviewApi): RepoLayoutEnvelope {
  return {
    dockview: api.toJSON(),
    placements: useSummonStore.getState().placements,
    fallbacks: useSummonStore.getState().fallbackPositions,
  };
}

/**
 * Restore the repo dock from a parsed envelope: seed the summon store's
 * placements/fallbacks first (matching the startup order in RepoDock), then
 * apply the layout. Returns false when the layout restored zero panels or
 * threw - the caller falls back to the default layout.
 */
export function applyRepoLayoutEnvelope(api: DockviewApi, envelope: RepoLayoutEnvelope): boolean {
  // Retired panels are pruned first - a stale reference would make fromJSON
  // throw and nuke the whole layout.
  const dockview = sanitizeDockviewLayout(envelope.dockview, REPO_COMPONENT_IDS);
  if (dockview === null) return false;
  const { capturePlacement, captureFallback } = useSummonStore.getState();
  for (const [panelId, groupId] of Object.entries(envelope.placements)) {
    capturePlacement(panelId, groupId);
  }
  for (const [panelId, pos] of Object.entries(envelope.fallbacks)) {
    captureFallback(panelId, pos);
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    api.fromJSON(dockview as any);
  } catch (e) {
    console.warn("could not apply repo dock layout", e);
    return false;
  }
  if (api.panels.length === 0) return false;
  capturePlacements(api);
  applyPanelConstraints(api);
  return true;
}

/** Persist the current layout of both docks as the saved default. */
export function saveLayoutAsDefault(globalApi: DockviewApi | null, repoApi: DockviewApi | null) {
  try {
    if (repoApi) {
      localStorage.setItem(SAVED_REPO_LAYOUT_KEY, JSON.stringify(captureRepoLayoutEnvelope(repoApi)));
    }
    if (globalApi) {
      localStorage.setItem(SAVED_GLOBAL_LAYOUT_KEY, JSON.stringify(globalApi.toJSON()));
    }
  } catch {
    /* quota - the snapshot simply isn't saved */
  }
}

/**
 * Restore the repo dock to the saved default layout. Returns false when no
 * snapshot exists or it fails to apply - the caller then rebuilds the
 * built-in first-launch layout.
 */
export function applySavedRepoLayout(api: DockviewApi): boolean {
  const envelope = parseRepoLayoutEnvelope(localStorage.getItem(SAVED_REPO_LAYOUT_KEY));
  if (!envelope) return false;
  return applyRepoLayoutEnvelope(api, envelope);
}

/**
 * Apply a plain global-dock layout JSON (sanitized: retired panels pruned).
 * Shared by the startup restore, the saved default, and the baked default.
 */
export function applyGlobalLayoutJson(api: DockviewApi, json: unknown): boolean {
  const layout = sanitizeDockviewLayout(json, GLOBAL_COMPONENT_IDS);
  if (layout === null) return false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    api.fromJSON(layout as any);
  } catch (e) {
    console.warn("could not apply global dock layout", e);
    return false;
  }
  if (api.panels.length === 0) return false;
  applyPanelConstraints(api);
  return true;
}

/** Same as `applySavedRepoLayout`, for the global dock's plain-JSON layout. */
export function applySavedGlobalLayout(api: DockviewApi): boolean {
  const raw = localStorage.getItem(SAVED_GLOBAL_LAYOUT_KEY);
  if (!raw) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  return applyGlobalLayoutJson(api, parsed);
}

/**
 * Apply the built-in default repo layout (`defaultLayouts.ts`). Cloned so
 * fromJSON / the summon store never share references with the module
 * constant. Returns false if it fails to apply - callers fall back to the
 * programmatic builder.
 */
export function applyBakedRepoLayout(api: DockviewApi): boolean {
  return applyRepoLayoutEnvelope(api, structuredClone(DEFAULT_REPO_LAYOUT));
}

/** Same as `applyBakedRepoLayout`, for the global dock. */
export function applyBakedGlobalLayout(api: DockviewApi): boolean {
  return applyGlobalLayoutJson(api, structuredClone(DEFAULT_GLOBAL_LAYOUT));
}
